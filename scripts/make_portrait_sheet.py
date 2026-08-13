# -*- coding: utf-8 -*-
"""
make_portrait_sheet.py — 16 张定稿形象图拼 4×4 sprite-sheet（工单 v4 第 6 步）

注意顺序约束（工单红字）：必须在 16 张 assets/art/portraits/<code>.png 全部定稿后
才允许执行本脚本拼接 assets/art/portrait-sheet.png。

布局：4×4，每格 512×512，整图 2048×2048，白底；顺序按 palette.json personalities
（即 INTJ→…→ESFP，逐行从左到右）。

用法：python scripts/make_portrait_sheet.py
依赖：仅 Pillow。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码与 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from pathlib import Path

from PIL import Image

from gen_portraits_v4 import PERSONALITIES

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"
SHEET_PATH = REPO_ROOT / "assets" / "art" / "portrait-sheet.png"

# 单格边长与行列数（工单：4×4）
CELL = 512
COLS = ROWS = 4


def main():
    """校验 16 张齐全后拼接 4×4 sheet。"""
    codes = list(PERSONALITIES.keys())
    missing = [c for c in codes if not (PORTRAITS_DIR / f"{c}.png").exists()]
    if missing:
        print(f"定稿不齐，禁止拼 sheet（工单顺序约束）。缺失：{', '.join(missing)}")
        return 1

    sheet = Image.new("RGB", (CELL * COLS, CELL * ROWS), (255, 255, 255))
    for idx, code in enumerate(codes):
        img = Image.open(PORTRAITS_DIR / f"{code}.png").convert("RGB")
        if img.size != (CELL, CELL):
            print(f"[FAIL] {code}.png 尺寸 {img.size}，要求 {CELL}x{CELL}")
            return 1
        x = (idx % COLS) * CELL
        y = (idx // COLS) * CELL
        sheet.paste(img, (x, y))
        print(f"[OK] 贴入 {code} → 格 ({idx % COLS}, {idx // COLS})")

    sheet.save(SHEET_PATH, "PNG")
    print(f"已输出：{SHEET_PATH}（{CELL * COLS}x{CELL * ROWS}，4x4）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
