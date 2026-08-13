# -*- coding: utf-8 -*-
"""
remap_portraits_v5.py — 16 张定稿形象图的族色「旧四档 → 新四档」程序化重映射（工单 v5 第 2 步）

背景：
  palette.json v4（色板版本号）把四族 main 更新为 R-C.png 采样值，shadow/light/highlight
  随之重新推导。v4 定稿的形象图里服装色还是旧族色，色板更新后即成「色板外颜色」，
  必须逐像素改写为新族色。

适用条件（工单口径）：服装色相本身正确、只是深浅/色调不对的图。
  服装被其他颜色稀释的图（如 ISTJ 棕色围裙、ISFJ 白围裙）重映射救不回来，
  需走 image-01 重生成，不在本脚本处理范围（由 finalize_portraits_v4.py 对 concepts/v5 候选处理）。

做法：
  逐像素精确匹配旧族四色（v3 色板值，硬编码自 palette.json 更新前的 families），
  按档位一一替换为新族对应档（shadow→shadow、main→main、light→light、highlight→highlight）。
  毛色（neutrals）、描边、纯白背景不动。像素数不变 → 旧图「main 主导」性质自动保持。

用法：
  python scripts/remap_portraits_v5.py              # 处理全部 16 张
  python scripts/remap_portraits_v5.py --dry-run    # 只统计不写盘
  python scripts/remap_portraits_v5.py intj enfp    # 只处理指定人格

依赖：仅 Pillow；新色值实时读 assets/style/palette.json。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import json
from pathlib import Path

from PIL import Image

from gen_portraits_v4 import PERSONALITIES

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

# 旧族四色（色板 v3，palette.json 被 v5 更新前的 families 值，硬编码留存用于精确匹配）
OLD_FAMILIES = {
    "analyst":  {"shadow": "#3B2A4A", "main": "#6B4E8E", "light": "#9B7EC4", "highlight": "#C9B4E0"},
    "diplomat": {"shadow": "#1F4433", "main": "#3E7C59", "light": "#6FAF88", "highlight": "#A8D5BA"},
    "sentinel": {"shadow": "#1F3A5F", "main": "#33608F", "light": "#5B8FC7", "highlight": "#9DC3E6"},
    "explorer": {"shadow": "#6B4A1F", "main": "#A8763E", "light": "#D4A55F", "highlight": "#F0CE9B"},
}


def hex_to_rgb(h):
    """'#RRGGBB' → (R, G, B)。"""
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def build_remap_table(palette_path=PALETTE_PATH):
    """从新色板读四族新四色，与 OLD_FAMILIES 按档位配对，返回 {旧 RGB: 新 RGB} 映射表。"""
    data = json.loads(Path(palette_path).read_text(encoding="utf-8"))
    new_families = {}
    for key, value in data["families"].items():
        prefix = key.split("_")[0]
        new_families[prefix] = {name: hex_to_rgb(value[name]) for name in ("main", "shadow", "light", "highlight")}

    table = {}
    for prefix, old_four in OLD_FAMILIES.items():
        if prefix not in new_families:
            raise KeyError(f"新色板 families 里找不到族 {prefix}")
        for tone, old_hex in old_four.items():
            old_rgb = hex_to_rgb(old_hex)
            new_rgb = new_families[prefix][tone]
            if old_rgb != new_rgb:
                table[old_rgb] = new_rgb
    return table


def remap_png(png_path, table, dry_run=False):
    """单张重映射：命中旧族色的像素改写为新色，返回 (改写像素数, 命中各旧色计数)。"""
    img = Image.open(png_path).convert("RGB")
    src = img.load()
    changed = 0
    per_color = {}
    for y in range(img.height):
        for x in range(img.width):
            c = src[x, y]
            if c in table:
                src[x, y] = table[c]
                changed += 1
                per_color[c] = per_color.get(c, 0) + 1
    if changed and not dry_run:
        img.save(png_path, "PNG")
    return changed, per_color


def main(argv=None):
    """入口：构建映射表，逐张重映射并汇总。"""
    args = [a.lower() for a in (argv if argv is not None else sys.argv[1:])]
    dry_run = "--dry-run" in args
    codes = [a for a in args if not a.startswith("--")] or list(PERSONALITIES.keys())

    table = build_remap_table()
    print(f"映射表 {len(table)} 条（旧 → 新）：")
    for old, new in sorted(table.items()):
        print(f"  #{old[0]:02X}{old[1]:02X}{old[2]:02X} → #{new[0]:02X}{new[1]:02X}{new[2]:02X}")

    total = 0
    for code in codes:
        png_path = PORTRAITS_DIR / f"{code}.png"
        if not png_path.exists():
            print(f"[跳过] {code}：{png_path} 不存在")
            continue
        changed, per_color = remap_png(png_path, table, dry_run=dry_run)
        total += changed
        tag = "（dry-run）" if dry_run else ""
        detail = ", ".join(f"#{c[0]:02X}{c[1]:02X}{c[2]:02X}×{n}" for c, n in sorted(per_color.items()))
        print(f"[OK] {code}: 改写 {changed} 像素{tag}（{detail}）")
    print(f"完成：共改写 {total} 像素{'（dry-run，未写盘）' if dry_run else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
