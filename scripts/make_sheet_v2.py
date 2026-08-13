# -*- coding: utf-8 -*-
"""
make_sheet_v2.py — 拼 16 人格 sprite 16 宫格目检图（M1 工单 v2 第 4 步）

输出 assets/art/sprite-sheet-v2.png：
  - 512×512，4×4 宫格，每格 128×128（32×32 sprite 放大 ×4，最近邻保持硬边）
  - 按族分行：分析家(紫) / 外交家(绿) / 守护者(蓝) / 探险家(黄)
  - 深灰底（#3A3A3A）：深色描边与白色毛发都能看清，兼顾两类边缘
  - 每格下方留 0 标签（保持纯图目检；人格顺序见 ROWS）

用法：python scripts/make_sheet_v2.py [sprite根目录] [输出路径]
依赖：仅 Pillow。
"""

import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent

# 按族分行的人格顺序（行 = 族：紫/绿/蓝/黄；列 = 族内由深到浅）
ROWS = [
    ["intj", "intp", "entj", "entp"],  # 分析家（紫族）
    ["infj", "infp", "enfj", "enfp"],  # 外交家（绿族）
    ["istj", "isfj", "estj", "esfj"],  # 守护者（蓝族）
    ["istp", "isfp", "estp", "esfp"],  # 探险家（黄族）
]

CELL = 128   # 每格边长（32px sprite × 4）
GRID = 4     # 4×4
BG = (58, 58, 58, 255)  # 深灰底：深色描边、白色毛发均可辨识


def make_sheet(sprites_root, out_path):
    """读取各人格 idle_0.png，放大 ×4 后按族拼成 512×512 目检图。"""
    sheet = Image.new("RGBA", (CELL * GRID, CELL * GRID), BG)
    missing = []
    for row, codes in enumerate(ROWS):
        for col, code in enumerate(codes):
            src = Path(sprites_root) / code / "idle_0.png"
            if not src.exists():
                missing.append(code)
                continue
            sprite = Image.open(src).convert("RGBA").resize((CELL, CELL), Image.NEAREST)
            sheet.paste(sprite, (col * CELL, row * CELL), sprite)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, "PNG")
    if missing:
        print(f"警告：缺少 sprite 的人格：{', '.join(missing)}")
    print(f"已输出：{out_path}（{CELL * GRID}x{CELL * GRID}，4x4 宫格）")


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else REPO_ROOT / "resources" / "sprites"
    out = sys.argv[2] if len(sys.argv) > 2 else REPO_ROOT / "assets" / "art" / "sprite-sheet-v2.png"
    make_sheet(root, out)
