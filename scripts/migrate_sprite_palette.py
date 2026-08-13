# -*- coding: utf-8 -*-
"""
migrate_sprite_palette.py — 把 resources/sprites/ 下 PNG 的旧族色精确替换为新族色

背景：
  palette.json 已从 v3（旧族四色）更新为原型图采样定档的新族四色，但
  resources/sprites/<16 人格>/ 与 placeholder/ 下的 32×32 / 48×48 sprite
  还是旧族色，导致 check_palette.py 报「越界」。本脚本一次性把旧色改写
  为同档位新色（shadow→shadow、main→main、light→light、highlight→highlight）。

做法：
  - 旧四族色硬编码（色板 v3 值），四族共 16 色，两两无重叠；
  - 新四族色实时读 assets/style/palette.json 的 families，避免再硬编码；
  - 逐像素精确匹配 RGB：命中旧色则改写为对应档位的新色，alpha 原样保留；
  - 毛色 / 描边 / 中性色 / 透明像素一律不动；
  - 缺省递归处理 resources/sprites/ 下所有 PNG（含 placeholder 子目录）。

幂等性：
  旧 16 色与新 16 色互不相交，第二遍运行不会有旧色可匹配 → 0 改写。

用法：
  python scripts/migrate_sprite_palette.py                # 处理默认目录
  python scripts/migrate_sprite_palette.py --dry-run      # 只统计不写盘
  python scripts/migrate_sprite_palette.py <目录>...      # 处理指定目录（可多个）

退出码：处理完成 → 0；参数错误 / 文件缺失 → 1。

依赖：仅 Pillow。
"""

import json
import sys
from pathlib import Path

from PIL import Image

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文/符号乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 仓库根目录 = 本文件所在 scripts/ 的上一级，保证任意工作目录下都能跑
REPO_ROOT = Path(__file__).resolve().parent.parent

# 色板路径与默认 sprite 根目录（工单要求处理含 placeholder 的全部子目录）
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
DEFAULT_SPRITES_ROOT = REPO_ROOT / "resources" / "sprites"

# 旧四族色（色板 v3 的 families 值，硬编码留存用于精确匹配）。
# 顺序固定为 shadow / main / light / highlight，与新色板 families 的档位一一对应。
OLD_FAMILIES = {
    "analyst":  {"shadow": "#3B2A4A", "main": "#6B4E8E", "light": "#9B7EC4", "highlight": "#C9B4E0"},
    "diplomat": {"shadow": "#1F4433", "main": "#3E7C59", "light": "#6FAF88", "highlight": "#A8D5BA"},
    "sentinel": {"shadow": "#1F3A5F", "main": "#33608F", "light": "#5B8FC7", "highlight": "#9DC3E6"},
    "explorer": {"shadow": "#6B4A1F", "main": "#A8763E", "light": "#D4A55F", "highlight": "#F0CE9B"},
}


def hex_to_rgb(h):
    """'#RRGGBB' → (R, G, B) 整数元组。"""
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def build_remap_table(palette_path=PALETTE_PATH):
    """从新色板读四族新色，与 OLD_FAMILIES 按档位配对，返回 {旧 RGB: 新 RGB} 映射表。

    若旧色与新色恰好相等（旧值未被本次 v5 更新改动）则跳过该条，
    避免无意义的写盘与干扰幂等性判断。
    """
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


def migrate_png(png_path, table, dry_run=False):
    """单张 PNG 重映射：命中旧族色的不透明像素改写为新色（alpha 原样保留）。

    返回 (改写像素数, 命中各旧色计数, 改写各新色计数)。
    """
    img = Image.open(png_path).convert("RGBA")
    src = img.load()
    changed = 0
    per_old = {}
    per_new = {}
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = src[x, y]
            if a == 0:
                continue  # 透明像素不参与
            key = (r, g, b)
            if key in table:
                new_rgb = table[key]
                src[x, y] = (new_rgb[0], new_rgb[1], new_rgb[2], a)
                changed += 1
                per_old[key] = per_old.get(key, 0) + 1
                per_new[new_rgb] = per_new.get(new_rgb, 0) + 1

    if changed and not dry_run:
        img.save(png_path, "PNG")
    return changed, per_old, per_new


def iter_sprite_pngs(roots):
    """逐个扫描根目录，产出 PNG 绝对路径（按路径排序，输出稳定）。"""
    for root in roots:
        root = Path(root)
        if not root.exists():
            print(f"目录不存在，跳过：{root}")
            continue
        for png_path in sorted(root.rglob("*.png")):
            yield png_path


def main(argv=None):
    """命令行入口：构建映射表，递归处理每个 PNG，汇总改写量并按 --dry-run 决定是否写盘。"""
    args = list(argv if argv is not None else sys.argv[1:])
    dry_run = "--dry-run" in args
    roots = [Path(a) for a in args if not a.startswith("--")]
    if not roots:
        roots = [DEFAULT_SPRITES_ROOT]

    table = build_remap_table()
    print(f"映射表 {len(table)} 条（旧 → 新）：")
    for old, new in sorted(table.items()):
        print(f"  #{old[0]:02X}{old[1]:02X}{old[2]:02X} → #{new[0]:02X}{new[1]:02X}{new[2]:02X}")

    total_changed = 0
    total_files = 0
    touched_files = 0
    for png_path in iter_sprite_pngs(roots):
        total_files += 1
        changed, per_old, per_new = migrate_png(png_path, table, dry_run=dry_run)
        total_changed += changed
        if changed:
            touched_files += 1
            detail = ", ".join(
                f"#{c[0]:02X}{c[1]:02X}{c[2]:02X}×{n}" for c, n in sorted(per_old.items())
            )
            tag = "（dry-run）" if dry_run else ""
            print(f"[OK] {png_path}: 改写 {changed} 像素{tag}（{detail}）")
    print(
        f"处理完成：扫描 {total_files} 个 PNG，触及 {touched_files} 个，"
        f"共改写 {total_changed} 像素{'（dry-run，未写盘）' if dry_run else ''}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
