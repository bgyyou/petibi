# -*- coding: utf-8 -*-
"""
sample_reference_colors.py — 从 owner 提供的 16personalities 官方原型图采样四族基准色（工单 v5 第 1 步）

原型图：C:/Users/19802/Desktop/R-C.png（4×4 布局，第 1 行分析家紫 / 第 2 行外交家绿 /
第 3 行守护者蓝绿 / 第 4 行探险家金黄；每行 4 个人物 + 底部一行彩色中文标签）。

采样方法（工单口径：每行 4 个人物服装区出现频次最高的饱和色）：
  1. 把图按 4×4 均分成行带/列格；每行只取上 68%（人物区，避开底部彩色标签文字），
     每列左右各缩 12%（避开相邻人物的边缘溢出）。
  2. 过滤像素：排除近白背景（min 通道 >= 235）、近灰/描边（max-min <= 25）、低饱和
     （饱和度 < 0.30）——剩下的是服装色 + 肤色 + 个别异色成员（ENTJ 品红裙 330°、
     INFP 黄绿兜帽 85°）。
  3. 按官方参考色色相开窗口（紫 255-310° / 绿 140-170° / 蓝 175-200° / 黄 38-52°），
     只留族色色相的像素——窗口同时排掉肤色（20-35°）与异色成员
     （试跑教训：直接全行色相直方图取峰会被 ENTJ 品红 / INFP 黄绿带偏，平均法还会
     被阴影色调拉暗）。
  4. 窗口内取「精确 RGB 众数」——这类矢量平涂图里服装主色调是面积最大的单色块，
     精确众数即主色调；打印前 5 名精确色供人工核对，并输出与 16p 官方参考值的色差。

用法：python scripts/sample_reference_colors.py [原型图路径]
依赖：仅 Pillow。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import colorsys
from pathlib import Path

from PIL import Image

# 默认原型图路径（owner 提供，仓库外）
DEFAULT_REF = Path(r"C:/Users/19802/Desktop/R-C.png")

# 16p 官方品牌色参考值（工单给出）：族名 / 参考 RGB / 采样色相窗口（度）
# 窗口作用：排掉肤色（20-35°）与异色成员（ENTJ 品红裙 ~330°、INFP 黄绿兜帽 ~85°），
# 只留本族官方色系的服装像素
REFERENCE = {
    0: ("analyst_分析家_紫", (0x88, 0x61, 0x9A), (255, 310)),
    1: ("diplomat_外交家_绿", (0x33, 0xA4, 0x74), (140, 170)),
    2: ("sentinel_守护者_蓝", (0x42, 0x98, 0xB4), (175, 200)),
    3: ("explorer_探险家_黄", (0xE4, 0xAE, 0x3A), (38, 52)),
}

# 行带内人物区占比：顶部留 2% 边距，底部 30% 是彩色标签文字，不采
ROW_TOP, ROW_BOTTOM = 0.02, 0.68
# 列格左右各缩 12%，避开相邻人物溢出
COL_MARGIN = 0.12


def collect_row_pixels(img, row, cols=4, rows=4):
    """收集某一行人物区内通过过滤的像素 RGB 列表。"""
    w, h = img.size
    band_h = h / rows
    y0 = int(band_h * (row + ROW_TOP))
    y1 = int(band_h * (row + ROW_BOTTOM))
    src = img.load()
    picked = []
    for col in range(cols):
        cell_w = w / cols
        x0 = int(cell_w * (col + COL_MARGIN))
        x1 = int(cell_w * (col + 1 - COL_MARGIN))
        for y in range(y0, y1):
            for x in range(x0, x1):
                r, g, b = src[x, y][:3]
                lo, hi = min(r, g, b), max(r, g, b)
                if lo >= 235:            # 近白背景
                    continue
                if hi - lo <= 25:        # 近灰（黑发/灰衣/描边/投影）
                    continue
                hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                if ss < 0.30 or vv < 0.25:   # 低饱和或近黑描边
                    continue
                picked.append((r, g, b, hh * 360))
    return picked


def sample_row(img, row, hue_window):
    """对一行按色相窗口过滤后取精确 RGB 众数，返回 (基准 RGB, 诊断串)。"""
    picked = collect_row_pixels(img, row)
    if not picked:
        raise RuntimeError(f"第 {row + 1} 行没有采到任何饱和像素，检查行列切分")

    lo_deg, hi_deg = hue_window
    in_window = [(r, g, b) for r, g, b, deg in picked if lo_deg <= deg <= hi_deg]
    if not in_window:
        raise RuntimeError(f"第 {row + 1} 行色相窗口 {hue_window} 内无像素，检查窗口设置")

    counts = {}
    for r, g, b in in_window:
        counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    top5 = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
    best = top5[0][0]
    diag = (f"窗口内像素 {len(in_window)}/{len(picked)}；前 5 精确色："
            + ", ".join(f"#{r:02X}{g:02X}{b:02X}×{n}" for (r, g, b), n in top5))
    return best, diag


def derive_tones(main):
    """由 main 程序化推导 shadow/light/highlight（工单 v5 第 1 步）。

    规则：shadow = 各通道 ×0.55；light = ×1.35；highlight = ×1.7，封顶 255。
    微调（工单允许「推导后目检合理性可微调」）：采样 main 偏亮时 ×1.35/×1.7 会把
    通道顶到 255，洗成霓虹色（实测 sentinel/explorer 的 highlight 公式值变 #61FFFF/#FFFF44），
    此时该档改用「向白色混合」（light 25% / highlight 45%），保色相且保证四档亮度严格递增。
    """
    def scale(f):
        return tuple(min(255, round(c * f)) for c in main)

    def toward_white(ratio):
        return tuple(round(c + (255 - c) * ratio) for c in main)

    shadow = scale(0.55)
    light = scale(1.35)
    highlight = scale(1.7)
    if 255 in light:      # ×1.35 已顶格，公式失真，改向白混合
        light = toward_white(0.25)
    if 255 in highlight:  # ×1.7 顶格同理
        highlight = toward_white(0.45)
    return {"shadow": shadow, "main": main, "light": light, "highlight": highlight}


def hex_str(rgb):
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


def main(argv=None):
    ref_path = Path(argv[0]) if argv else DEFAULT_REF
    img = Image.open(ref_path).convert("RGB")
    print(f"原型图：{ref_path}（{img.size[0]}x{img.size[1]}）")

    results = {}
    for row in range(4):
        name, ref_rgb, hue_window = REFERENCE[row]
        best, diag = sample_row(img, row, hue_window)
        results[name] = best
        dist = sum((a - b) ** 2 for a, b in zip(best, ref_rgb)) ** 0.5
        print(f"\n[{name}] 采样众数 = {hex_str(best)}（参考 {hex_str(ref_rgb)}，色差 {dist:.1f}）")
        print(f"  {diag}")

    # 定档：众数若落在阴影/高光档（明显偏离官方参考、或同行存在更接近参考的中间档），
    # 取「色相窗口内最接近官方参考色的中间色调」——工单口径是参考值以实图采样微调，
    # 而非照搬面积最大的色块（平涂图里高光块面积常常最大）。
    # 逐族依据（来自上方前 5 精确色诊断）：
    #   分析家 #785D87 = 众数本身（INTJ/INTP/ENTP 三格主色一致，ENTJ 品红为官方异色款，排除）
    #   外交家 #3E8F6E = 中间档（众数 #53AF8A 是浅绿高光块；#3E8F6E 距官方绿 #33A474 最近）
    #   守护者 #399FB9 = ESFJ 外套主色（众数 #71CACC 是浅青高光；#399FB9 与官方 #4298B4 色差仅 13）
    #   探险家 #E4C728 = 众数本身（ISTP/ISFP/ESTP 主色，比官方 #E4AE3A 略偏柠檬黄，如实采用）
    CHOSEN = {
        "analyst_分析家_紫": (0x78, 0x5D, 0x87),
        "diplomat_外交家_绿": (0x3E, 0x8F, 0x6E),
        "sentinel_守护者_蓝": (0x39, 0x9F, 0xB9),
        "explorer_探险家_黄": (0xE4, 0xC7, 0x28),
    }

    print("\n定档 + 推导结果（palette.json families 候选值）：")
    for name, main_rgb in CHOSEN.items():
        tones = derive_tones(main_rgb)
        tag = "（= 众数）" if results[name] == main_rgb else f"（众数 {hex_str(results[name])}，定档取中间色调）"
        print(f"  [{name}]{tag}")
        for tone in ("main", "shadow", "light", "highlight"):
            print(f'    "{tone}": "{hex_str(tones[tone])}"')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
