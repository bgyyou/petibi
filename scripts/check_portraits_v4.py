# -*- coding: utf-8 -*-
"""
check_portraits_v4.py — v4 定稿形象图验收校验（工单 v4 第 4 步 / 验收标准 1-3）

逐张校验 assets/art/portraits/<code>.png：
  1. 尺寸必须 512×512；
  2. 全部像素颜色 ∈ 色板（families + neutrals + outline）∪ {纯白 #FFFFFF 背景}；
  3. 毛色规避四族色（绿/黄/紫/蓝）：
     - 「中央头部区」（x 25%-75%，y 8%-45%，覆盖脸/头主体，兜帽两侧下沿不算）
       不许出现其他族颜色 > 0.3%（本族色允许——兜帽/帽子是服装，如 INTJ 紫兜帽）；
     - 全图其他族颜色 > 0.5% 判失败（如海豚蓝灰皮被量化到守护者蓝即在此拦截），
       0.05%-0.5% 只提示（小配饰/搭扣等可容忍）；
  4. 族一致性：本族 main 色像素存在且为本族四色中最多的（服装主色主导）。

输出逐张明细 + 汇总；退出码：全部通过 0，否则 1。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码与 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import json
from pathlib import Path

from PIL import Image

from check_palette import load_palette_colors
from gen_portraits_v4 import PERSONALITIES
from unify_family_colors import hex_to_rgb, load_family_map

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

# 定稿画布与纯白背景
CANVAS = 512
WHITE = (255, 255, 255)

# 中央头部区（脸/头主体）：x 25%-75%，y 8%-45%
HEAD_X0, HEAD_X1 = int(CANVAS * 0.25), int(CANVAS * 0.75)
HEAD_Y0, HEAD_Y1 = int(CANVAS * 0.08), int(CANVAS * 0.45)

# 阈值（占画布比例）
HEAD_FAIL = 0.003    # 中央头部区其他族颜色 > 0.3% → 失败
CROSS_FAIL = 0.005   # 全图其他族颜色 > 0.5% → 失败
CROSS_WARN = 0.0005  # 0.05%-0.5% → 提示（小配饰）


def load_family_color_sets(palette_path=PALETTE_PATH):
    """读取色板，返回 {族前缀: 四色 dict}。"""
    data = json.loads(Path(palette_path).read_text(encoding="utf-8"))
    families = {}
    for key, value in data["families"].items():
        prefix = key.split("_")[0]
        families[prefix] = {name: hex_to_rgb(value[name]) for name in ("main", "shadow", "light", "highlight")}
    return families


def check_one(png_path, code, own_family, families, allowed):
    """校验单张，返回 (是否通过, 明细字符串列表)。"""
    details = []
    ok = True
    img = Image.open(png_path).convert("RGB")

    # 1. 尺寸
    if img.size != (CANVAS, CANVAS):
        ok = False
        details.append(f"[FAIL] 尺寸 {img.size[0]}x{img.size[1]}，要求 {CANVAS}x{CANVAS}")

    own = families[own_family]
    own_colors = set(own.values())
    # 其他族颜色 → 族名（用于定位越界来源）
    other_color_map = {}
    for prefix, fam in families.items():
        if prefix == own_family:
            continue
        for c in fam.values():
            other_color_map[c] = prefix

    off_palette = {}        # 色板外颜色（不含纯白背景）
    head_other = {}         # 中央头部区的其他族颜色
    cross_other = {}        # 全图其他族颜色
    own_counts = {c: 0 for c in own_colors}  # 本族四色像素数

    total = CANVAS * CANVAS
    pixels = img.load()
    for y in range(CANVAS):
        in_head_y = HEAD_Y0 <= y < HEAD_Y1
        for x in range(CANVAS):
            rgb = pixels[x, y]
            if rgb == WHITE:
                continue
            if rgb not in allowed:
                off_palette[rgb] = off_palette.get(rgb, 0) + 1
            if rgb in own_counts:
                own_counts[rgb] += 1
            elif rgb in other_color_map:
                cross_other[rgb] = cross_other.get(rgb, 0) + 1
                if in_head_y and HEAD_X0 <= x < HEAD_X1:
                    head_other[rgb] = head_other.get(rgb, 0) + 1

    # 2. 色板合规
    if off_palette:
        ok = False
        worst = sorted(off_palette.items(), key=lambda kv: -kv[1])[:5]
        details.append("[FAIL] 色板外颜色："
                       + ", ".join(f"#{r:02X}{g:02X}{b:02X}×{n}" for (r, g, b), n in worst))
    else:
        details.append("[OK] 全部颜色在色板内（背景纯白 #FFFFFF）")

    # 3a. 中央头部区毛色：其他族颜色 > 0.3% 判失败
    head_bad = sum(head_other.values())
    if head_bad > total * HEAD_FAIL:
        ok = False
        worst = sorted(head_other.items(), key=lambda kv: -kv[1])[:5]
        details.append(f"[FAIL] 中央头部区含其他族色 {head_bad} 像素（{head_bad / total:.2%}）："
                       + ", ".join(f"#{r:02X}{g:02X}{b:02X}({other_color_map[c]})×{n}" for c, n in worst
                                   for r, g, b in [c]))
    else:
        details.append(f"[OK] 中央头部区其他族色 {head_bad} 像素（{head_bad / total:.2%}，阈值 0.3%）")

    # 3b. 全图其他族颜色：> 0.5% 失败，0.05%-0.5% 提示
    cross = sum(cross_other.values())
    if cross > total * CROSS_FAIL:
        ok = False
        worst = sorted(cross_other.items(), key=lambda kv: -kv[1])[:5]
        details.append(f"[FAIL] 全图其他族色 {cross} 像素（{cross / total:.2%}）："
                       + ", ".join(f"#{r:02X}{g:02X}{b:02X}({other_color_map[c]})×{n}" for c, n in worst
                                   for r, g, b in [c]))
    elif cross > total * CROSS_WARN:
        details.append(f"[提示] 全图其他族色 {cross} 像素（{cross / total:.2%}，小配饰级，容忍内）")
    else:
        details.append(f"[OK] 全图其他族色 {cross} 像素（{cross / total:.3%}）")

    # 4. 本族 main 存在且主导
    main = own["main"]
    counts_str = ", ".join(f"{name}×{own_counts[own[name]]}" for name in ("main", "shadow", "light", "highlight"))
    main_hex = f"#{main[0]:02X}{main[1]:02X}{main[2]:02X}"
    if own_counts[main] == 0:
        ok = False
        details.append(f"[FAIL] 无本族 main 色像素（{counts_str}）")
    elif own_counts[main] < max(own_counts[own[n]] for n in ("shadow", "light", "highlight")):
        ok = False
        details.append(f"[FAIL] 本族 main 非主导色（{counts_str}）")
    else:
        details.append(f"[OK] 本族 main {main_hex} 主导服装（{counts_str}）")

    return ok, details


def main():
    """校验全部 16 张定稿并汇总。"""
    allowed = load_palette_colors(PALETTE_PATH)
    families = load_family_color_sets(PALETTE_PATH)
    family_map = load_family_map(PALETTE_PATH)

    passed, failed = [], []
    for code in PERSONALITIES:
        png_path = PORTRAITS_DIR / f"{code}.png"
        if not png_path.exists():
            print(f"{code}: [FAIL] 文件缺失 {png_path}")
            failed.append(code)
            continue
        own_family = family_map[code]["family"]
        ok, details = check_one(png_path, code, own_family, families, allowed)
        print(f"{code}（{own_family}）：")
        for line in details:
            print(f"  {line}")
        (passed if ok else failed).append(code)

    # 族内一致性汇总：同族 4 人 main 色值（取自色板同一字段，逐族打印核对）
    print("\n族内 main 色一致性（同族 4 人服装主色必须像素级相同）：")
    by_family = {}
    for code, fam in family_map.items():
        by_family.setdefault(fam["family"], []).append(code)
    for family, codes in sorted(by_family.items()):
        main = families[family]["main"]
        hex_str = f"#{main[0]:02X}{main[1]:02X}{main[2]:02X}"
        present = [c for c in codes if c in passed]
        print(f"  [{family}] main={hex_str}，成员 {', '.join(codes)}（通过 {len(present)}/{len(codes)}）")

    print(f"\n汇总：通过 {len(passed)} / {len(PERSONALITIES)}")
    if failed:
        print(f"未通过：{', '.join(failed)}")
        return 1
    print("校验通过：16 张形象图全部合规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
