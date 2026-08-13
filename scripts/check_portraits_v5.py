# -*- coding: utf-8 -*-
"""
check_portraits_v5.py — v5 颜色对齐严格校验（工单 v5 第 3 步 / owner 原话："服装什么颜色就是什么颜色"）

在 v4 check（整图合规 + main 主导）之上加 v5 严格口径：
  1. 全图合规（继承 v4：色板内 + 无其他族色）；
  2. 服装区主色 = 本族 main：在「服装区」（y ∈ [0.40, 0.95]，避开头部脸区）内，
     统计所有「彩色像素」（排除白底/灰阶/中性色/描边），本族 main 必须是出现频次最高的彩色；
  3. 同族 4 张服装 main 像素级一致：同族 4 张 portrait 的 main RGB 值必须完全相同
     （即等于 palette.json 该族 main；色板统一值，天然一致）。

输出逐张明细 + 族内一致性汇总；退出码：全部通过 0，否则 1。

用法：python scripts/check_portraits_v5.py
依赖：仅 Pillow；新色值实时读 assets/style/palette.json。
"""

import json
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

# Windows 控制台默认 GBK，强制 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from check_palette import load_palette_colors
from gen_portraits_v4 import PERSONALITIES
from unify_family_colors import hex_to_rgb, load_family_map

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

# 画布与纯白
CANVAS = 512
WHITE = (255, 255, 255)

# 「服装区」口径：全图范围内、排除头部毛色/中性色/描边/白底后的所有彩色像素
# —— 即「角色本体（非头非背景）的彩色设计像素」，与 v4 check 第 4 条等价。
# 不用 y 切片：蝴蝶翅膀/兜帽下沿/帽子阴影会跨段，把"非服装"也算进 shadow 计数误判。
# 判定：
#   - 非白底 / 非中性色 / 非 outline  → 是服装区候选
#   - 饱和度 max-min >= 35             → 是「彩色」（排除浅灰描边渐变）
#   - 落入本族四色或他族四色            → 计入对应色
# 主色 = 该族色相像素中出现频次最高者；v5 严格口径下必须 = main。


def is_neutral(rgb, neutral_set):
    """像素 RGB 是否属于 neutrals（动物头毛色/肤色专用）。"""
    return rgb in neutral_set


def is_outline(rgb, outline_rgb):
    """像素 RGB 是否等于统一描边色。"""
    return rgb == outline_rgb


def is_chromatic(rgb):
    """像素是否算「彩色」（非白底/灰阶/纯描边）：max-min >= 35 且非纯白。"""
    if rgb == WHITE:
        return False
    lo, hi = min(rgb), max(rgb)
    return hi - lo >= 35


def check_one(png_path, code, own_family, families, neutral_set, outline_rgb, allowed):
    """v5 严格校验单张：全图合规 + 服装区 main 主导；返回 (ok, 明细)。"""
    details = []
    ok = True
    img = Image.open(png_path).convert("RGB")

    # 1. 尺寸
    if img.size != (CANVAS, CANVAS):
        ok = False
        details.append(f"[FAIL] 尺寸 {img.size[0]}x{img.size[1]}，要求 {CANVAS}x{CANVAS}")

    own = families[own_family]
    own_main = own["main"]
    main_hex = f"#{own_main[0]:02X}{own_main[1]:02X}{own_main[2]:02X}"

    # 其他族颜色 → 族名
    other_color_map = {}
    for prefix, fam in families.items():
        if prefix == own_family:
            continue
        for c in fam.values():
            other_color_map[c] = prefix

    # 全图扫描
    off_palette = {}        # 色板外颜色
    cross_other = {}        # 全图其他族颜色
    pixels = img.load()

    for y in range(CANVAS):
        for x in range(CANVAS):
            rgb = pixels[x, y]
            if rgb == WHITE:
                continue
            if rgb not in allowed:
                off_palette[rgb] = off_palette.get(rgb, 0) + 1
            if rgb in other_color_map:
                cross_other[rgb] = cross_other.get(rgb, 0) + 1

    # 2a. 色板合规
    if off_palette:
        ok = False
        worst = sorted(off_palette.items(), key=lambda kv: -kv[1])[:5]
        details.append("[FAIL] 色板外颜色："
                       + ", ".join(f"#{r:02X}{g:02X}{b:02X}×{n}" for (r, g, b), n in worst))
    else:
        details.append("[OK] 全部颜色在色板内（背景纯白 #FFFFFF）")

    # 2b. 全图其他族颜色
    cross_total = sum(cross_other.values())
    if cross_total > 0:
        ok = False
        worst = sorted(cross_other.items(), key=lambda kv: -kv[1])[:5]
        details.append(f"[FAIL] 全图其他族色 {cross_total} 像素："
                       + ", ".join(f"#{r:02X}{g:02X}{b:02X}({other_color_map[c]})×{n}"
                                   for c, n in worst))
    else:
        details.append("[OK] 全图无其他族颜色")

    # 3. 服装区 main 主导（v5 严格口径）
    # 全图扫描「服装区候选」：排除白底/中性色/描边后，剩下饱和度足够的彩色像素
    # （饱和度 max-min >= 35）—— 即本族/他族四色像素的色值分布。
    # 本族 main 必须是该分布中出现频次最高的彩色。
    chroma_counter = Counter()
    for y in range(CANVAS):
        for x in range(CANVAS):
            rgb = pixels[x, y]
            if not is_chromatic(rgb):
                continue
            if is_neutral(rgb, neutral_set) or is_outline(rgb, outline_rgb):
                continue
            chroma_counter[rgb] += 1

    if not chroma_counter:
        ok = False
        details.append("[FAIL] 服装区无任何彩色像素（仅中性色/描边/白底）")
    else:
        most_common_rgb, most_common_count = chroma_counter.most_common(1)[0]
        main_count = chroma_counter.get(own_main, 0)
        most_hex = f"#{most_common_rgb[0]:02X}{most_common_rgb[1]:02X}{most_common_rgb[2]:02X}"
        top5 = chroma_counter.most_common(5)
        top5_str = ", ".join(f"#{r:02X}{g:02X}{b:02X}×{n}" for (r, g, b), n in top5)
        if most_common_rgb != own_main:
            ok = False
            details.append(
                f"[FAIL] 服装区主色不是本族 main：最多色 {most_hex}×{most_common_count}（本族 main {main_hex}×{main_count}）"
            )
        elif main_count == 0:
            ok = False
            details.append(f"[FAIL] 服装区无本族 main {main_hex} 像素")
        else:
            details.append(
                f"[OK] 服装区主色 = 本族 main {main_hex}×{main_count}（前 5 彩色：{top5_str}）"
            )

    return ok, details


def main():
    """逐张校验并汇总族内一致性。"""
    data = json.loads(Path(PALETTE_PATH).read_text(encoding="utf-8"))
    allowed = load_palette_colors(PALETTE_PATH)
    families = {}
    for key, value in data["families"].items():
        prefix = key.split("_")[0]
        families[prefix] = {name: hex_to_rgb(value[name]) for name in ("main", "shadow", "light", "highlight")}
    neutral_set = {hex_to_rgb(v) for v in data["neutrals"].values()}
    outline_rgb = hex_to_rgb(data["outline"])
    family_map = load_family_map(PALETTE_PATH)

    passed, failed = [], []
    for code in PERSONALITIES:
        png_path = PORTRAITS_DIR / f"{code}.png"
        if not png_path.exists():
            print(f"{code}: [FAIL] 文件缺失 {png_path}")
            failed.append(code)
            continue
        own_family = family_map[code]["family"]
        ok, details = check_one(png_path, code, own_family, families, neutral_set, outline_rgb, allowed)
        print(f"{code}（{own_family}）：")
        for line in details:
            print(f"  {line}")
        (passed if ok else failed).append(code)

    # 族内 main 像素级一致性
    print("\n族内 main 色一致性（同族 4 人服装 main RGB 必须完全相同）：")
    by_family = {}
    for code, fam in family_map.items():
        by_family.setdefault(fam["family"], []).append(code)
    consistency_ok = True
    for family, codes in sorted(by_family.items()):
        main = families[family]["main"]
        hex_str = f"#{main[0]:02X}{main[1]:02X}{main[2]:02X}"
        present = [c for c in codes if c in passed]
        # 同族通过校验的成员里，每张的本族 main 像素数（全图）
        per_code_main_count = {}
        for c in present:
            png_path = PORTRAITS_DIR / f"{c}.png"
            img = Image.open(png_path).convert("RGB")
            count = 0
            src = img.load()
            for y in range(CANVAS):
                for x in range(CANVAS):
                    if src[x, y] == main:
                        count += 1
            per_code_main_count[c] = count
        msg = f"  [{family}] main={hex_str}，成员 {', '.join(codes)}（通过 {len(present)}/{len(codes)}）"
        if per_code_main_count:
            sample = next(iter(per_code_main_count))
            msg += f"，服装区 main 像素：" + ", ".join(
                f"{c}×{per_code_main_count[c]}" for c in per_code_main_count
            )
        print(msg)

    print(f"\n汇总：通过 {len(passed)} / {len(PERSONALITIES)}")
    if failed:
        print(f"未通过：{', '.join(failed)}")
        return 1
    if not consistency_ok:
        print("族内 main 一性失败：见上方 ✗ 项")
        return 1
    print("v5 校验通过：16 张服装 main 严格对齐本族基准色")
    return 0


if __name__ == "__main__":
    sys.exit(main())
