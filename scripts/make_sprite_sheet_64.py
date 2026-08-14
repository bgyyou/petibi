# -*- coding: utf-8 -*-
"""
make_sprite_sheet_64.py — 由 16 人格 base 拼 16 宫格 sprite-sheet-64.png

用途（T4 验收）：owner 一图看遍 16 只 64×64 桌宠基准帧，目检细节可读性。

布局：4 行 × 4 列，每人格一格。格子按 PRD §8.2 人格映射表的顺序排列：
  分析家（紫）：INTJ / INTP / ENTJ / ENTP
  外交家（绿）：INFJ / INFP / ENFJ / ENFP
  守护者（蓝）：ISTJ / ISFJ / ESTJ / ESFJ
  探险家（黄）：ISTP / ISFP / ESTP / ESFP

输出：
  assets/art/sprite-sheet-64.png
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
SPRITES_DIR = REPO_ROOT / "resources" / "sprites"
OUTPUT_PATH = REPO_ROOT / "assets" / "art" / "sprite-sheet-64.png"

# 4 行 × 4 列：按 PRD §8.2 人格族分块顺序
TYPES = [
    # 分析家
    "intj", "intp", "entj", "entp",
    # 外交家
    "infj", "infp", "enfj", "enfp",
    # 守护者
    "istj", "isfj", "estj", "esfj",
    # 探险家
    "istp", "isfp", "estp", "esfp",
]

# 标签（人格缩写，与格子一一对应）
LABELS = [t.upper() for t in TYPES]

# 网格参数：每格 128×128（64×64 源 × 2 放大，方便目检）
CELL = 128
COLS = 4
ROWS = 4
PAD = 8  # 格子与格子之间的间距（像素）
LABEL_H = 24  # 顶部人格标签条高度
MARGIN = 16  # 画布四周留白
BG = (254, 249, 239)  # 与 design.md 主背景一致（#FEF9EF）


def main():
    """主入口：拼 16 宫格 sprite-sheet-64.png。"""
    sheet_w = MARGIN * 2 + COLS * CELL + (COLS - 1) * PAD
    sheet_h = MARGIN * 2 + ROWS * (CELL + LABEL_H) + (ROWS - 1) * PAD
    sheet = Image.new("RGB", (sheet_w, sheet_h), BG)
    draw = ImageDraw.Draw(sheet)

    # 优先尝试找一个系统等宽像素字体；找不到就用默认字体
    font = None
    for candidate in [
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/cour.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    ]:
        if Path(candidate).exists():
            try:
                font = ImageFont.truetype(candidate, 14)
                break
            except OSError:
                continue
    if font is None:
        font = ImageFont.load_default()

    for idx, (type_, label) in enumerate(zip(TYPES, LABELS)):
        col = idx % COLS
        row = idx // COLS
        x = MARGIN + col * (CELL + PAD)
        y = MARGIN + row * (CELL + LABEL_H + PAD)

        # 标签条
        draw.rectangle([x, y, x + CELL, y + LABEL_H], fill=(43, 35, 32))  # outline 色
        draw.text((x + 8, y + 4), label, fill=(254, 249, 239), font=font)

        # 64×64 base 放大到 128×128（NEAREST 保持像素硬边）
        base_path = SPRITES_DIR / type_ / "base.png"
        if not base_path.exists():
            print(f"  [跳过] {base_path} 不存在")
            continue
        base = Image.open(base_path).convert("RGBA")
        scaled = base.resize((CELL, CELL), Image.NEAREST)
        sheet.paste(scaled, (x, y + LABEL_H), scaled)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUTPUT_PATH, "PNG")
    print(f"已输出：{OUTPUT_PATH}（{sheet_w}x{sheet_h}，16 宫格 × 128px）")


if __name__ == "__main__":
    main()
