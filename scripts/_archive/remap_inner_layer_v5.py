# -*- coding: utf-8 -*-
"""
remap_inner_layer_v5.py — 「异色内搭 → 本族色」程序化修正（工单 v5 第 2 步的补救工具）

背景（istj 案例）：
  image-01 对「海狸 + 工装」顽固输出「背带裤 + 米色衬衫」两件套（v5 共 3 轮 6 张候选，
  不是衬衫异色就是服装灰蒙），owner 又明确点名 ISTJ 不许异色内搭。
  选定的 istj_3 候选背带裤是正蓝绿、只有衬衫（袖子/胸前 V）是米色，
  遂把衬衫区的中性色像素程序化改绘为本族色，比继续赌生成更可控。

做法：
  对 assets/art/portraits/<code>.png，把 y >= ymin（默认 0.455，即头部/口鼻区以下）且
  颜色命中 --colors 的像素，按「源色亮度 → 族色档位」保序改写为本族色：
  最亮的源色 → family.light，次亮 → family.main，第三 → family.shadow。
  （保序：改写后保留衬衫原有的明暗分界，不会糊成一整块。）

用法：
  python scripts/remap_inner_layer_v5.py istj --colors "#F2EDE4,#E6D3B3"
  python scripts/remap_inner_layer_v5.py istj --colors "#F2EDE4,#E6D3B3" --ymin 0.45 --dry-run

依赖：仅 Pillow；族色实时读 assets/style/palette.json。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import argparse
import json
from pathlib import Path

from PIL import Image

from remap_portraits_v5 import hex_to_rgb
from finalize_portraits_v4 import code_to_family

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

CANVAS = 512


def luminance(c):
    """感知亮度（Rec.601），用于源色与族色档位的保序配对。"""
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def load_family_tones(code, palette_path=PALETTE_PATH):
    """读色板，返回该人格本族的 {档位: RGB}（main/shadow/light/highlight）。"""
    data = json.loads(Path(palette_path).read_text(encoding="utf-8"))
    prefix = code_to_family(code)
    for key, value in data["families"].items():
        if key.split("_")[0] == prefix:
            return {name: hex_to_rgb(value[name]) for name in ("main", "shadow", "light", "highlight")}
    raise KeyError(f"families 里找不到族 {prefix}")


def main(argv=None):
    """入口：解析参数，逐像素保序改写内搭色。"""
    parser = argparse.ArgumentParser(description="异色内搭中性色 → 本族色保序改写（v5 补救）")
    parser.add_argument("code", help="人格代码（小写，如 istj）")
    parser.add_argument("--colors", required=True,
                        help="要改写的中性色 hex 列表，逗号分隔（如 \"#F2EDE4,#E6D3B3\"）")
    parser.add_argument("--ymin", type=float, default=0.455,
                        help="只处理该比例以下的像素（默认 0.455，护住脸/口鼻区的合法毛色）")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写盘")
    args = parser.parse_args(argv)

    sources = sorted((hex_to_rgb(h.strip()) for h in args.colors.split(",")), key=luminance, reverse=True)
    tones = load_family_tones(args.code)
    # 保序配对：最亮源色 → light，次亮 → main，第三 → shadow，更暗的统一 → shadow
    slots = ["light", "main", "shadow"]
    mapping = {}
    for i, src_color in enumerate(sources):
        mapping[src_color] = tones[slots[min(i, len(slots) - 1)]]

    png_path = PORTRAITS_DIR / f"{args.code}.png"
    img = Image.open(png_path).convert("RGB")
    src = img.load()
    y0 = int(CANVAS * args.ymin)
    counts = {}
    for y in range(y0, CANVAS):
        for x in range(CANVAS):
            c = src[x, y]
            if c in mapping:
                if not args.dry_run:
                    src[x, y] = mapping[c]
                counts[c] = counts.get(c, 0) + 1

    if counts and not args.dry_run:
        img.save(png_path, "PNG")
    detail = ", ".join(
        f"#{c[0]:02X}{c[1]:02X}{c[2]:02X}→#{mapping[c][0]:02X}{mapping[c][1]:02X}{mapping[c][2]:02X}×{n}"
        for c, n in sorted(counts.items()))
    tag = "（dry-run，未写盘）" if args.dry_run else ""
    print(f"{args.code}: 改写 {sum(counts.values())} 像素{tag}（{detail}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
