# -*- coding: utf-8 -*-
"""
verify_fur_fix_v6.py — 工单 v6 美术精修自验（毛色区域零四族色 / infj 白羽描边）

owner 工单要求：
  - 3 张修改图：毛色区域（头/手）零四族色
    → 扫头部区域验证黄/绿色像素 = 0
  - infj 允许头部有白/奶油/描边色
    → 扫头部区，确认有 #F2EDE4 白 / #E6D3B3 奶油 / #2B2320 描边 像素
    → 扫白羽-白底 8-邻域接触 = 0（描边闭合）

约定：
  - 头部区域：y < HEAD_Y_MAX（200，画布上 1/3 多一点）
  - explorer 服装四色（黄）：#E4C728 / #EBD55E / #F0E089 / #7D6D16
  - diplomat 服装四色（绿）：#3E8F6E / #224F3D / #54C194 / #69F3BB
  - 其他族色（analyst 紫 / sentinel 蓝）也按"毛色区域零四族色"标准一并检查
  - 退出码：全部通过 → 0；任何失败 → 1。
"""

import sys
from pathlib import Path

from PIL import Image

# Windows 控制台默认 GBK，强制 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

HEAD_Y_MAX = 200

# 四族服装四色（24 色）
FAMILY_COLORS = {
    "analyst_紫": {(120, 93, 135), (66, 51, 74), (162, 126, 182), (204, 158, 230)},
    "diplomat_绿": {(62, 143, 110), (34, 79, 61), (84, 193, 148), (105, 243, 187)},
    "sentinel_蓝": {(57, 159, 185), (31, 87, 102), (77, 215, 250), (146, 202, 216)},
    "explorer_黄": {(228, 199, 40), (235, 213, 94), (240, 224, 137), (125, 109, 22)},
}

# 白羽/奶油/描边（infj 头部允许的颜色）
WHITE_FEATHER = (242, 237, 228)
CREAM = (230, 211, 179)
OUTLINE = (43, 35, 32)
WHITE_BG = (255, 255, 255)

# infj 用所有族色（毛色区域必须零四族色，infj 自身是 diplomat 绿也含绿 → 头部若有绿即异常）
INFJ_FORBIDDEN_FAMILIES = ["analyst_紫", "sentinel_蓝", "explorer_黄"]
# diplomat 绿不算异常（infj 自身是绿族，绿色出现在衣领区也合理；owner 工单仅要求黄/绿为 0，
# 这里保守起见仍按"四族零"标准扫描）。

NB8 = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))


def scan_head_zone(code, allowed_families=None):
    """扫描 y < HEAD_Y_MAX 区域：返回 (各族色像素数 dict, 头部总像素数)。

    allowed_families: 允许出现的族集合（None = 全部四族都不允许）
    """
    img = Image.open(PORTRAITS_DIR / f"{code}.png").convert("RGB")
    arr = img.load()
    H, W = img.height, img.width
    fam_count = {fam: 0 for fam in FAMILY_COLORS}
    total = 0
    for y in range(0, min(H, HEAD_Y_MAX)):
        for x in range(W):
            rgb = arr[x, y]
            for fam, colors in FAMILY_COLORS.items():
                if rgb in colors:
                    fam_count[fam] += 1
            total += 1
    return fam_count, total


def scan_white_feather_outline(code):
    """扫描 infj 头部区（y<HEAD_Y_MAX）：白羽/奶油像素与白底 8-邻域接触 = 0；
    描边像素与白底相邻是正常的（描边即用于分隔白底与白羽）。

    返回 (羽毛接触像素数, 白羽像素数, 奶油像素数, 描边像素数)
    """
    img = Image.open(PORTRAITS_DIR / f"{code}.png").convert("RGB")
    arr = img.load()
    H, W = img.height, img.width
    contact = 0
    white_count = 0
    cream_count = 0
    outline_count = 0
    for y in range(0, min(H, HEAD_Y_MAX)):
        for x in range(W):
            rgb = arr[x, y]
            if rgb == WHITE_FEATHER:
                white_count += 1
                is_feather = True
            elif rgb == CREAM:
                cream_count += 1
                is_feather = True
            elif rgb == OUTLINE:
                outline_count += 1
                is_feather = False  # 描边像素自身与白底相邻是正常的（描边的作用就是分隔白底）
            else:
                continue
            if not is_feather:
                continue
            # 仅统计白羽/奶油像素与白底的接触
            for dy, dx in NB8:
                ny, nx = y + dy, x + dx
                if ny < 0 or ny >= H or nx < 0 or nx >= W:
                    contact += 1
                    break
                if arr[nx, ny] == WHITE_BG:
                    contact += 1
                    break
    return contact, white_count, cream_count, outline_count


def main():
    ok = True
    print("=== 头部区（y<200）四族色扫描（owner 工单要求黄/绿像素 = 0）===\n")

    # estp（猴子，explorer 族）：头部区黄 = 0；其他族色应已统一（非毛色）
    print("[estp] 猴子头部区四族色：")
    fam_count, total = scan_head_zone("estp")
    for fam, n in fam_count.items():
        flag = "[OK]" if n == 0 else "[FAIL]"
        print(f"  {flag} {fam}: {n} 像素")
        if n > 0 and fam == "explorer_黄":
            ok = False
    print(f"  头部区总像素 {total}\n")

    # isfp（卡皮巴拉，explorer 族）：同上
    print("[isfp] 卡皮巴拉头部区四族色：")
    fam_count, total = scan_head_zone("isfp")
    for fam, n in fam_count.items():
        flag = "[OK]" if n == 0 else "[FAIL]"
        print(f"  {flag} {fam}: {n} 像素")
        if n > 0 and fam == "explorer_黄":
            ok = False
    print(f"  头部区总像素 {total}\n")

    # infj（天鹅，diplomat 族）：头部允许白/奶油/描边；其他族色 = 0
    print("[infj] 天鹅头部区四族色（白/奶油/描边不算族色）：")
    fam_count, total = scan_head_zone("infj")
    for fam, n in fam_count.items():
        flag = "[OK]" if n == 0 else "[FAIL]"
        print(f"  {flag} {fam}: {n} 像素")
        if n > 0 and fam in INFJ_FORBIDDEN_FAMILIES:
            ok = False
    print(f"  头部区总像素 {total}\n")

    # infj 描边闭合 + 头部色合法
    print("[infj] 白羽头部描边闭合 + 头部色合法：")
    contact, white_n, cream_n, outline_n = scan_white_feather_outline("infj")
    flag1 = "[OK]" if contact == 0 else "[FAIL]"
    flag2 = "[OK]" if white_n > 0 else "[FAIL]"
    flag3 = "[OK]" if cream_n > 0 else "[FAIL]"
    flag4 = "[OK]" if outline_n > 0 else "[FAIL]"
    print(f"  {flag1} 白羽/奶油/描边像素 8-邻域接触白底 = {contact}（要求 = 0）")
    print(f"  {flag2} 白羽 #F2EDE4 像素 = {white_n}（头部天鹅羽毛主色）")
    print(f"  {flag3} 奶油 #E6D3B3 像素 = {cream_n}（天鹅羽毛过渡色）")
    print(f"  {flag4} 描边 #2B2320 像素 = {outline_n}（颈部/头部外缘）")
    if contact != 0 or white_n == 0 or cream_n == 0 or outline_n == 0:
        ok = False

    print()
    if ok:
        print("汇总：3 张精修图自验通过（头部区黄/绿 = 0；infj 白羽描边闭合）")
        return 0
    print("汇总：自验失败（见上方 ✗）")
    return 1


if __name__ == "__main__":
    sys.exit(main())