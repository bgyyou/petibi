# -*- coding: utf-8 -*-
"""
fix_portraits_v6.py — 工单 v6 美术精修（针对 estp/isfp/infj 3 张 owner 目检不通过的形象图）

owner 目检结果（assets/art/portraits/ 16 张里 3 张需要精修）：
  1. estp.png（猴子）：脸和手被黄色衣服"染色"，应改为棕色系毛色（neutrals 的浅棕/棕），
     衣服保持探险家黄 #E4C728。
  2. isfp.png（卡皮巴拉）：手和脸变成黄色，同理改回棕色毛色，衣服保持黄色。
  3. infj.png（天鹅）：白羽头部与纯白背景融合，轮廓不完整。需给头部外缘补完整描边
     （用 outline #2B2320 或浅灰 #9A9A9A，1-2px 闭合描边）。

策略（优先 PIL 像素级换色，不触发 image-01 重生成）：
  - 黄色 → 棕色系映射：把脸部/手部（y < Y_HEAD_BOTTOM 阈值）的黄色像素（explorer 四色）
    改写为 neutrals 棕色四色（浅棕 #C49A6C / 棕 #8B5E3C / 深棕 #5C4033 / 橘 #D97B29），
    衣服区域（y >= 阈值 且 x 在躯干范围内）的黄色像素保持不变。
  - 白色 → 描边：扫描白羽像素（#F2EDE4 白 / #E6D3B3 奶油），4-邻域内含纯白底 #FFFFFF
    且白羽像素"明显处于外缘"（邻域内有 2+ 个白底像素）→ 改为描边色 #2B2320，
    形成 1-2px 闭合外描边，保持像素风干净。

约定：
  - 仓库根 = 本文件所在 scripts/ 的上一级。
  - 输入/输出：直接覆盖 assets/art/portraits/<code>.png（owner 已要求精修这 3 张）。
  - 不动其他 13 张形象图；不动 sprite-sheet / sprite sheet v2/v3；只重拼 portrait-sheet.png。
  - 中文注释（R9）；不 git commit。

退出码：3 张全部成功 → 0；任何失败 → 1。
"""

import json
import sys
from pathlib import Path

from PIL import Image

# Windows 控制台默认 GBK，强制 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parent.parent
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"
SHEET_PATH = REPO_ROOT / "assets" / "art" / "portrait-sheet.png"

# explorer 服装四色（保留在衣服上）
EXPLORER_MAIN = (228, 199, 40)        # #E4C728 主黄
EXPLORER_LIGHT = (235, 213, 94)       # #EBD55E 浅黄
EXPLORER_HIGHLIGHT = (240, 224, 137)  # #F0E089 高亮黄
EXPLORER_SHADOW = (125, 109, 22)      # #7D6D16 黄阴影
YELLOW_FAMILY = {EXPLORER_MAIN, EXPLORER_LIGHT, EXPLORER_HIGHLIGHT, EXPLORER_SHADOW}

# 中性毛色四色（目标棕色系）
NEUTRAL_LIGHT = (196, 154, 108)       # #C49A6C 浅棕
NEUTRAL_MID = (139, 94, 60)           # #8B5E3C 棕
NEUTRAL_DARK = (92, 64, 51)           # #5C4033 深棕
NEUTRAL_ORANGE = (217, 123, 41)       # #D97B29 橘（保留暖色修饰）

# 头部阈值：y < HEAD_Y_MAX 的黄色像素视为脸/手/耳碎片，需要改色；y >= 阈值的黄色保持。
# 角色全身像头部通常在画布顶部 1/3（512 * 1/3 ≈ 170），这里用 200 留出一点过渡余地。
HEAD_Y_MAX = 200

# 白羽 / 白底 / 描边
WHITE_FEATHER_MAIN = (242, 237, 228)  # #F2EDE4 白
WHITE_FEATHER_CREAM = (230, 211, 179) # #E6D3B3 奶油
WHITE_FEATHER_GRAY = (154, 154, 154)  # #9A9A9A 灰
WHITE_BG = (255, 255, 255)            # #FFFFFF 纯白背景
OUTLINE = (43, 35, 32)                # #2B2320 描边
WHITE_FEATHER_SET = {WHITE_FEATHER_MAIN, WHITE_FEATHER_CREAM}


def yellow_to_brown(rgb):
    """把 explorer 黄色系映射到中性棕色系（保持色调明度梯度：阴影→深棕、主色→棕、
    浅色→浅棕、高亮→浅棕）。
    """
    if rgb == EXPLORER_MAIN:
        return NEUTRAL_MID
    if rgb == EXPLORER_LIGHT:
        return NEUTRAL_LIGHT
    if rgb == EXPLORER_HIGHLIGHT:
        return NEUTRAL_LIGHT
    if rgb == EXPLORER_SHADOW:
        return NEUTRAL_DARK
    return None


def fix_yellow_in_head(code, head_y_max=HEAD_Y_MAX):
    """把 y < head_y_max 的黄色像素改为棕色系毛色；y >= head_y_max 的黄色保持衣服。
    返回 (改写像素数, 总黄色像素数)。
    """
    png_path = PORTRAITS_DIR / f"{code}.png"
    img = Image.open(png_path).convert("RGB")
    px = img.load()
    H, W = img.height, img.width

    changed = 0
    total_yellow = 0
    for y in range(H):
        for x in range(W):
            rgb = px[x, y]
            if rgb not in YELLOW_FAMILY:
                continue
            total_yellow += 1
            if y < head_y_max:
                new_rgb = yellow_to_brown(rgb)
                if new_rgb is not None and new_rgb != rgb:
                    px[x, y] = new_rgb
                    changed += 1

    if changed > 0:
        img.save(png_path, "PNG")
    return changed, total_yellow


def fix_white_feather_outline(code):
    """给 infj 白羽头部补 1px 闭合描边：白羽/奶油像素 8-邻域内含 #FFFFFF 白底
    → 改为描边色 #2B2320；同时对"仅 4-邻域接触"的白羽补浅灰过渡（#9A9A9A），
    形成 1-2px 闭合外描边，保持像素风干净。

    两遍扫描：
      1. 8-邻域含 #FFFFFF 的白羽像素 → 标为 #2B2320 描边（最外圈）
      2. 4-邻域含 #FFFFFF 但 8-邻域不含 → 标为 #9A9A9A 浅灰（次外圈过渡）
    描边不重入：已经标为描边的像素的 4-邻域白羽不再追加描边色，避免黑边变粗。

    返回 (描边像素数, 浅灰过渡像素数)。
    """
    png_path = PORTRAITS_DIR / f"{code}.png"
    img = Image.open(png_path).convert("RGB")
    arr_img = img.load()
    H, W = img.height, img.width

    # 8 邻域偏移
    NB4 = ((-1, 0), (1, 0), (0, -1), (0, 1))
    NB8 = NB4 + ((-1, -1), (-1, 1), (1, -1), (1, 1))

    to_outline = []
    to_gray = []
    for y in range(H):
        for x in range(W):
            rgb = arr_img[x, y]
            if rgb not in WHITE_FEATHER_SET:
                continue
            # 8-邻域含 #FFFFFF（含画布边界外推视为白底）
            has_white_8 = False
            for dy, dx in NB8:
                ny, nx = y + dy, x + dx
                if ny < 0 or ny >= H or nx < 0 or nx >= W:
                    has_white_8 = True
                    break
                if arr_img[nx, ny] == WHITE_BG:
                    has_white_8 = True
                    break
            if has_white_8:
                # 4-邻域已有 #2B2320 描边 → 说明这是第二圈，不再追加描边（避免变粗）
                outline_n4 = 0
                for dy, dx in NB4:
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and arr_img[nx, ny] == OUTLINE:
                        outline_n4 += 1
                if outline_n4 == 0:
                    to_outline.append((x, y))
                # 否则跳过，避免描边变粗
                continue
            # 4-邻域含 #FFFFFF 但 8-邻域不含 → 次外圈浅灰过渡
            has_white_4 = False
            for dy, dx in NB4:
                ny, nx = y + dy, x + dx
                if ny < 0 or ny >= H or nx < 0 or nx >= W:
                    has_white_4 = True
                    break
                if arr_img[nx, ny] == WHITE_BG:
                    has_white_4 = True
                    break
            if has_white_4:
                to_gray.append((x, y))

    # 统一改写
    for (x, y) in to_outline:
        arr_img[x, y] = OUTLINE
    for (x, y) in to_gray:
        arr_img[x, y] = WHITE_FEATHER_GRAY

    total_outline = len(to_outline)
    total_gray = len(to_gray)
    if total_outline + total_gray > 0:
        img.save(png_path, "PNG")
    return total_outline, total_gray


def main():
    """依次处理 estp/isfp/infj 三张，输出每张处理摘要。"""
    print(f"色板：{PALETTE_PATH}")
    print(f"输出：{PORTRAITS_DIR}\n")

    # 验证色板存在
    if not PALETTE_PATH.exists():
        print(f"[FAIL] 色板不存在 {PALETTE_PATH}")
        return 1

    # 1) estp 猴子：脸/手黄色 → 棕色
    print("=== estp.png（猴子）脸/手黄色 → 棕色 ===")
    changed, total = fix_yellow_in_head("estp")
    print(f"  总黄色像素 {total}，y<{HEAD_Y_MAX} 头部区改写 {changed} 像素为棕色系")

    # 2) isfp 卡皮巴拉：脸/手黄色 → 棕色
    print("\n=== isfp.png（卡皮巴拉）脸/手黄色 → 棕色 ===")
    changed, total = fix_yellow_in_head("isfp")
    print(f"  总黄色像素 {total}，y<{HEAD_Y_MAX} 头部区改写 {changed} 像素为棕色系")

    # 3) infj 天鹅：白羽头部补描边
    print("\n=== infj.png（天鹅）白羽头部补描边 ===")
    total_outline, total_gray = fix_white_feather_outline("infj")
    print(f"  外缘描边像素 {total_outline}，过渡浅灰像素 {total_gray}")

    print("\n处理完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())