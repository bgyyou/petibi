# -*- coding: utf-8 -*-
"""
finalize_portraits_v4.py — v4 候选稿 → 512×512 定稿形象图（工单 v4 第 3 步「选片 + 合规化」）

流程（每张）：
  1. 读入 assets/art/concepts/v4/<code>_<候选号>.png（MiniMax image-01 出图，通常 1024×1024）
  2. 像素网格吸附：先 BOX（面积平均）缩到 --grid（默认 256）×--grid，再 NEAREST 放大回 512×512。
     原因：AI 出的是"伪像素画"（带平滑渐变与抗锯齿），直接在原分辨率量化会得到脏噪点；
     吸附到整数像素网格后每格同色，才是真正的"精细像素风"（256 网格 = 2px 格，细节远超 v2 的 32）。
  3. 背景处理：从四边洪水填充，把与边框连通的类背景像素（白底 + 地面灰色椭圆投影 +
     右下角灰色签名水印）统一钉为纯白 #FFFFFF；角色有深色描边闭环，洪水进不去，
     白毛/灰毛角色（天鹅/海豚）不会被误伤。16 张统一白底，不做透明化。
  4. 非背景像素量化到色板最近色（families + neutrals + outline），背景保持 #FFFFFF；
     其他族族色 → neutrals 重映射（族色纯净）。
  4b. 中央头部区本族色 → neutrals（毛色规避四族色；戴兜帽成员 intj/infj/isfp 跳过）。
  4c. 本族四色保序重映射，服装主视觉色钉到 family.main（同族 4 人像素级一致）。
  5. 输出 assets/art/portraits/<code>.png（512×512，RGB）

选片：--pick code=候选号（缺省每只取 1 号候选）。

用法：
  python scripts/finalize_portraits_v4.py                          # 全部 16 只取 1 号候选
  python scripts/finalize_portraits_v4.py --pick intj=2 enfp=1 ... # 指定选片
  python scripts/finalize_portraits_v4.py --grid 128               # 更粗网格（4px 格）

依赖：Pillow；复用 scripts/pixelate.py 的色板加载函数。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码与 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import argparse
from pathlib import Path

from PIL import Image

from pixelate import DEFAULT_PALETTE, load_palette
from gen_portraits_v4 import PERSONALITIES

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# 候选目录与定稿输出目录
CONCEPTS_V4_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "v4"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

# 输出画布边长（工单 v4：统一 512×512）
CANVAS = 512

# 纯白背景色（工单：背景白 #FFFFFF，统一不转透明）
WHITE = (255, 255, 255)

# 碎屑清理阈值：量化后小于该像素数且不连通主体的独立色块视为水印/噪点残骸抹掉
# （实测签名水印残骸 < 100px；角色细节件如扳手/画笔都 > 150px 且与手相连）
MIN_COMPONENT = 150

# 中央头部区（与 check_portraits_v4 的判定框一致）：x 25%-75%，y 8%-45%
HEAD_X0, HEAD_X1 = int(CANVAS * 0.25), int(CANVAS * 0.75)
HEAD_Y0, HEAD_Y1 = int(CANVAS * 0.08), int(CANVAS * 0.45)

# 头部带兜帽的成员：头区的本族色是服装（兜帽），不做头区本族色中性化；
# 其余成员头区出现本族色一律视为毛色跑偏（典型：豹/鹦鹉的黄褐毛被量化到探险家琥珀、
# 狮子鬃毛被量化到分析家暗紫），机械回落到 neutrals。
# 注意：是否戴兜帽取决于最终选片的候选设计（infp 选定的 2 号候选戴绿兜帽，故在列；
# v5 重生成的 istj 选定 5 号候选是蓝绿连帽工装，兜帽戴起，同样在列）
HOODED = {"intj", "infj", "isfp", "infp", "istj"}


def load_palette_groups(palette_path=DEFAULT_PALETTE):
    """读取色板，返回 (全色 list, {族前缀: 四色 set}, neutrals+outline list)。

    用于「族色纯净」重映射：任何被量化到非本族族色的像素，
    改从 neutrals + outline 中重新取最近色（工单：人格色系只体现在服装，
    其他族的色系出现在毛色/配饰上一律是模型跑偏，机械纠正）。
    """
    import json

    data = json.loads(Path(palette_path).read_text(encoding="utf-8"))

    def hex_to_rgb(h):
        h = h.lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

    families = {}
    families_named = {}
    for key, value in data["families"].items():
        prefix = key.split("_")[0]
        families[prefix] = {hex_to_rgb(v) for v in value.values()}
        # 保留 shadow/main/light/highlight 命名版，供「main 主导统一」按亮度序使用
        families_named[prefix] = {name: hex_to_rgb(value[name]) for name in ("main", "shadow", "light", "highlight")}

    neutrals = [hex_to_rgb(v) for v in data["neutrals"].values()]
    neutrals.append(hex_to_rgb(data["outline"]))
    return families, neutrals, families_named


def flood_background_mask(img):
    """从四边两趟洪水填充生成背景掩码：与边框连通的「类背景」像素判为背景。

    两趟判据（实测标定）：
      A 趟 min>=150 且 max-min<=22：白底 + 地面灰色椭圆投影（实测投影色 (179,162,168)，
         暖灰微色差；image-01 对 "no shadow" 指令顽固不化，只能后处理）。
         海豚蓝灰皮 (140,155,175) 色差 35 > 22，会被挡在判据外——
         这是 A 趟相对"色差<=30"宽判据的关键修正（宽判据曾把整只海豚头吃掉）。
      B 趟 min>=120 且 max-min<=8：右下角灰色签名水印（实测 (136,136,134)，几乎纯消色）。
         角色描边 #2B2320 色差 11 > 8，洪水进不了角色内部；白眼珠同理受描边保护。

    角色有深色描边闭环，两趟洪水都进不了角色内部，白毛/灰毛角色（天鹅/猫/海豚）
    只要描边不断裂就不会被误伤；定稿后仍需逐张目检确认（交付报告如实记录）。

    返回 (掩码图 Image "1"，判白像素数)。
    """
    from collections import deque

    w, h = img.size
    src = img.load()
    visited = bytearray(w * h)

    def flood(is_bg_like):
        queue = deque()
        for x in range(w):
            for y in (0, h - 1):
                if not visited[y * w + x] and is_bg_like(x, y):
                    visited[y * w + x] = 1
                    queue.append((x, y))
        for y in range(h):
            for x in (0, w - 1):
                if not visited[y * w + x] and is_bg_like(x, y):
                    visited[y * w + x] = 1
                    queue.append((x, y))
        # 4-邻域 BFS
        while queue:
            x, y = queue.popleft()
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx] and is_bg_like(nx, ny):
                    visited[ny * w + nx] = 1
                    queue.append((nx, ny))

    def pass_a(x, y):
        r, g, b = src[x, y][:3]
        return min(r, g, b) >= 150 and max(r, g, b) - min(r, g, b) <= 22

    def pass_b(x, y):
        r, g, b = src[x, y][:3]
        return min(r, g, b) >= 120 and max(r, g, b) - min(r, g, b) <= 8

    flood(pass_a)
    flood(pass_b)

    mask = Image.new("1", (w, h), 0)
    msk = mask.load()
    count = 0
    for y in range(h):
        base = y * w
        for x in range(w):
            if visited[base + x]:
                msk[x, y] = 1
                count += 1
    return mask, count


def quantize_keep_white(img, mask, palette, own_family_colors, other_family_colors, neutrals):
    """背景置纯白，非背景像素量化到色板最近色 + 族色纯净重映射。

    族色纯净规则（工单「人格色系只体现在服装/配饰」的机械执行）：
      像素最近色若是其他族的族色（如海豚蓝灰皮 → 守护者蓝、金色搭扣 → 探险家琥珀），
      改从 neutrals + outline 中重新取最近色（蓝灰皮 → 灰，金搭扣 → 浅棕）。
      本族族色（服装/兜帽）不受影响。
    返回 (输出图, 重映射像素数)。
    """
    out = img.copy()
    src = out.load()
    msk = mask.load()
    remapped = 0
    for y in range(out.height):
        for x in range(out.width):
            if msk[x, y]:
                src[x, y] = WHITE
                continue
            r, g, b = src[x, y][:3]
            best = min(palette, key=lambda c: (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2)
            if best in other_family_colors and best not in own_family_colors:
                # 其他族色系 = 模型跑偏，强制回落到中性色
                best = min(neutrals, key=lambda c: (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2)
                remapped += 1
            src[x, y] = best
    return out, remapped


def remove_small_components(img, min_size):
    """抹掉小于 min_size 且独立的非白色块（签名水印残骸 / 零星噪点），返回抹除像素数。

    4-邻域连通标记；角色主体是最大的连通块（数万像素），
    实测水印残骸 < 100px，远低于阈值 150。
    """
    from collections import deque

    w, h = img.size
    src = img.load()
    labels = [-1] * (w * h)  # -1 = 未标记
    erased = 0
    label_id = 0
    for y0 in range(h):
        for x0 in range(w):
            idx0 = y0 * w + x0
            if labels[idx0] != -1 or src[x0, y0] == WHITE:
                continue
            # BFS 收集当前连通块
            comp = []
            queue = deque([(x0, y0)])
            labels[idx0] = label_id
            while queue:
                x, y = queue.popleft()
                comp.append((x, y))
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        nidx = ny * w + nx
                        if labels[nidx] == -1 and src[nx, ny] != WHITE:
                            labels[nidx] = label_id
                            queue.append((nx, ny))
            if len(comp) < min_size:
                for x, y in comp:
                    src[x, y] = WHITE
                erased += len(comp)
            label_id += 1
    return erased


def remap_head_own_family(img, own_family_colors, neutrals):
    """中央头部区的本族色像素 → 最近的 neutrals/outline 色（毛色规避四族色的机械执行）。

    只处理非戴兜帽成员（HOODED 之外的）；兜帽成员头区本族色是服装，由调用方跳过。
    返回重映射像素数。
    """
    src = img.load()
    remapped = 0
    for y in range(HEAD_Y0, HEAD_Y1):
        for x in range(HEAD_X0, HEAD_X1):
            c = src[x, y][:3]
            if c == WHITE or c not in own_family_colors:
                continue
            r, g, b = c
            src[x, y] = min(neutrals, key=lambda n: (r - n[0]) ** 2 + (g - n[1]) ** 2 + (b - n[2]) ** 2)
            remapped += 1
    return remapped


def _luminance(c):
    """感知亮度（Rec.601），用于保持明暗顺序的重映射评分。"""
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def unify_family_dominance(img, family_four):
    """同族服装色像素级对齐 family.main：枚举保持明暗顺序的映射，保证 main 主导。

    背景：image-01 常把服装画成族色的 light/highlight（太亮）或 shadow（太暗）色调，
    量化后 main 不是主导色，过不了「同族 4 人服装主色 = main」验收。
    做法：把本族四色按亮度排序（shadow < main < light < highlight，色板 v3 四族均已验证
    满足该序），枚举全部保序映射（暗色不许映到亮色，明暗关系不翻转），
    约束「映射到 main 的像素数严格最大」，取亮度失真最小的一个。
    这样服装主视觉色被钉到 main，同族 4 人像素级一致，且阴影不会反转。

    family_four: {"shadow": rgb, "main": rgb, "light": rgb, "highlight": rgb}
    返回 (映射像素数, 采用的映射 dict)。
    """
    from itertools import product

    order = ["shadow", "main", "light", "highlight"]  # 亮度升序
    colors = [family_four[name] for name in order]

    # 统计四色各自像素数
    counts = {c: 0 for c in colors}
    src = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            c = src[x, y][:3]
            if c in counts:
                counts[c] += 1

    # 枚举保序映射：target 下标序列单调不减；main 槽（下标 1）像素数严格最大
    best = None
    for targets in product(range(4), repeat=4):
        if any(targets[i] > targets[i + 1] for i in range(3)):
            continue
        new_counts = [0, 0, 0, 0]
        for i, c in enumerate(colors):
            new_counts[targets[i]] += counts[c]
        if new_counts[1] == 0 or any(new_counts[1] <= new_counts[t] for t in (0, 2, 3)):
            continue
        distortion = sum(
            counts[c] * (_luminance(c) - _luminance(colors[t])) ** 2
            for c, t in zip(colors, targets)
        )
        if best is None or distortion < best[0]:
            best = (distortion, targets)

    if best is None:
        # 理论上恒等映射以外的保序映射很多，不太可能全灭；兜底不动图，如实返回
        return 0, {}

    mapping = {colors[i]: colors[t] for i, t in enumerate(best[1])}
    changed = 0
    for y in range(h):
        for x in range(w):
            c = src[x, y][:3]
            if c in mapping and mapping[c] != c:
                src[x, y] = mapping[c]
                changed += 1
    return changed, mapping


def finalize_one(candidate_path, out_path, grid, code):
    """单张合规化：网格吸附 → 洪水抠背景 → 族色纯净量化 → 碎屑清理 → 存 512×512 RGB PNG。"""
    img = Image.open(candidate_path).convert("RGB")

    # 第 2 步：像素网格吸附（BOX = 面积平均，先把 AI 伪像素画的平滑渐变/噪点
    # 平均进每个格子，再 NEAREST 放大回 512，得到干净的整数像素格）
    small = img.resize((grid, grid), Image.BOX)
    snapped = small.resize((CANVAS, CANVAS), Image.NEAREST)

    # 第 3 步：背景掩码（洪水填充：白底 + 地面投影 + 签名水印一并抠掉，
    # 角色靠深色描边闭环保护）
    mask, white_count = flood_background_mask(snapped)

    # 第 4 步：量化到色板 + 族色纯净重映射（其他族色系 → 中性色）
    palette = load_palette(DEFAULT_PALETTE)
    families, neutrals, families_named = load_palette_groups()
    own = families[code_to_family(code)]
    other = set().union(*(families[f] for f in families if f != code_to_family(code)))
    out, remapped = quantize_keep_white(snapped, mask, palette, own, other, neutrals)

    # 第 4b 步：中央头部区本族色 → 中性色（毛色规避四族色；戴兜帽成员跳过，兜帽是服装）
    head_fixed = 0
    if code not in HOODED:
        head_fixed = remap_head_own_family(out, own, neutrals)

    # 第 4c 步：本族四色保序重映射，把服装主视觉色钉到 family.main
    # （同族 4 人服装主色像素级一致的机械保证；明暗关系不翻转）
    unified, mapping = unify_family_dominance(out, families_named[code_to_family(code)])

    # 第 5 步：碎屑清理（水印残骸 / 独立噪点）
    erased = remove_small_components(out, MIN_COMPONENT)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(out_path, "PNG")
    total = CANVAS * CANVAS
    print(f"[OK] {candidate_path.name} → {out_path.name}"
          f"（网格 {grid}，白底 {white_count * 100 // total}%，"
          f"族色重映射 {remapped}px，头区中性化 {head_fixed}px，"
          f"main 统一 {unified}px，碎屑抹除 {erased}px）")


# 人格代码 → 族前缀（与 palette.json personalities 一致）
def code_to_family(code):
    return {
        "intj": "analyst", "intp": "analyst", "entj": "analyst", "entp": "analyst",
        "infj": "diplomat", "infp": "diplomat", "enfj": "diplomat", "enfp": "diplomat",
        "istj": "sentinel", "isfj": "sentinel", "estj": "sentinel", "esfj": "sentinel",
        "istp": "explorer", "isfp": "explorer", "estp": "explorer", "esfp": "explorer",
    }[code]


def main(argv=None):
    """入口：解析选片，逐人格合规化输出。"""
    parser = argparse.ArgumentParser(description="v4 候选稿 → 512×512 色板合规定稿形象图")
    parser.add_argument("--pick", nargs="*", default=[],
                        help="选片映射 code=候选号（如 intj=2 enfp=1）；未指明的取 1 号候选")
    parser.add_argument("--grid", type=int, default=256,
                        help="像素网格边长（默认 256，即 512 画布上 2px 一格；128 则 4px 一格更粗）")
    parser.add_argument("--codes", nargs="*", default=None,
                        help="只处理指定人格（小写，如 intj enfp）；缺省全部 16 只")
    parser.add_argument("--outdir", default=None,
                        help="输出目录（默认 assets/art/portraits；调参对比时可指向临时目录）")
    parser.add_argument("--concepts-dir", default=None,
                        help="候选目录（默认 assets/art/concepts/v4；v5 重生成候选指向 concepts/v5）")
    args = parser.parse_args(argv)

    picks = {}
    for item in args.pick:
        code, _, idx = item.partition("=")
        picks[code.lower()] = int(idx)

    outdir = Path(args.outdir) if args.outdir else PORTRAITS_DIR
    concepts_dir = Path(args.concepts_dir) if args.concepts_dir else CONCEPTS_V4_DIR
    targets = args.codes if args.codes else list(PERSONALITIES.keys())
    for code in targets:
        idx = picks.get(code, 1)
        candidate = concepts_dir / f"{code}_{idx}.png"
        if not candidate.exists():
            print(f"[跳过] {code}：候选 {candidate.name} 不存在")
            continue
        finalize_one(candidate, outdir / f"{code}.png", args.grid, code)

    print("定稿完成 →", outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
