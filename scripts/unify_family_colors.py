# -*- coding: utf-8 -*-
"""
unify_family_colors.py — 族内颜色统一到 main（色板 v3「一族一色」迁移脚本）

背景：
  色板 v3 把"族内每人格不同明度"改为"一族一色"：同族 4 个人格的服装主色
  必须完全对齐为 family.main；shadow 为全族统一阴影色；light / highlight
  仅作高光点缀。旧 sprite 里 light/highlight 曾被用作服装主体色，需改写。

功能：
  遍历 resources/sprites/<16 人格>/ 下的所有 PNG，逐像素精确匹配：
    - 颜色 == 该人格所在族的 light 或 highlight → 改写为 main
    - main / shadow / outline / neutrals / 透明像素 → 保持不变
  （sprite 颜色本来就在色板内，逐像素精确匹配即可，不做最近邻。）

  处理完成后自带族内一致性校验：
    - 全族不再出现 light / highlight 像素
    - 逐族抽查前两个不同人格的 main 色像素存在且色值完全相同

用法：
  python scripts/unify_family_colors.py [--sprites-root resources/sprites] [--dry-run]

退出码：处理且校验全部通过 → 0；校验失败 → 1。

依赖：仅 Pillow。
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文/符号乱码与 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 仓库根目录 = 本文件所在 scripts/ 的上一级，保证任意工作目录下都能跑
REPO_ROOT = Path(__file__).resolve().parent.parent

# 色板路径与默认 sprite 根目录
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
DEFAULT_SPRITES_ROOT = REPO_ROOT / "resources" / "sprites"


def hex_to_rgb(hex_color):
    """'#RRGGBB' → (R, G, B) 整数元组。"""
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def load_family_map(palette_path=PALETTE_PATH):
    """读取色板 v3，返回 {人格代码(小写): {"family": 族键, "main": RGB, "shadow": RGB,
    "light": RGB, "highlight": RGB}}。

    families 的键形如 "analyst_分析家_紫"，personalities 里的 family 字段是
    英文前缀（如 "analyst"），按下划线第一段对齐。
    """
    data = json.loads(Path(palette_path).read_text(encoding="utf-8"))

    # 族英文前缀 → 四色 RGB
    families = {}
    for key, value in data["families"].items():
        prefix = key.split("_")[0]
        families[prefix] = {name: hex_to_rgb(value[name]) for name in ("main", "shadow", "light", "highlight")}

    result = {}
    for code, info in data["personalities"].items():
        prefix = info["family"]
        if prefix not in families:
            raise KeyError(f"personalities.{code}.family={prefix} 在 families 中找不到对应族")
        entry = {"family": prefix}
        entry.update(families[prefix])
        result[code.lower()] = entry
    return result


def unify_png(png_path, fam, dry_run=False):
    """把单个 PNG 中命中族 light/highlight 的不透明像素改写为 main。

    返回 (命中改写像素数, 总像素数)；dry_run 时只统计不写盘。
    """
    img = Image.open(png_path).convert("RGBA")
    targets = {fam["light"], fam["highlight"]}
    main = fam["main"]
    changed = 0

    pixels = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue  # 透明像素不参与
            if (r, g, b) in targets:
                pixels[x, y] = (main[0], main[1], main[2], a)
                changed += 1

    if changed and not dry_run:
        img.save(png_path, "PNG")
    return changed, img.width * img.height


def count_colors(png_path, colors):
    """统计 PNG 中指定颜色集合各色的不透明像素数，返回 {RGB: 像素数}。"""
    img = Image.open(png_path).convert("RGBA")
    counts = {c: 0 for c in colors}
    pixels = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = pixels[x, y]
            if a and (r, g, b) in counts:
                counts[(r, g, b)] += 1
    return counts


def verify_family_consistency(family_map, sprites_root):
    """族内一致性校验：处理后 light/highlight 应为 0，且同族人格 main 色像素存在且色值一致。

    逐族统计各人格的 main / light / highlight 像素数，再抽查族内 main 像素
    最多的两个人格：main 像素数 > 0，且两人格的 main RGB 完全相同
    （本来取自同一色板字段，这里验证的是改写后图中确实存在该色）。
    个别人格（如服装以 shadow 为主色的 INTJ）main 像素可为 0，只作提示不算失败。
    返回是否全部通过。
    """
    ok = True
    # 按族分组人格
    by_family = {}
    for code, fam in sorted(family_map.items()):
        by_family.setdefault(fam["family"], []).append(code)

    for family, codes in sorted(by_family.items()):
        fam = family_map[codes[0]]
        watched = [fam["main"], fam["light"], fam["highlight"]]
        print(f"[{family}] main=#{fam['main'][0]:02X}{fam['main'][1]:02X}{fam['main'][2]:02X}")
        per_code = {}
        for code in codes:
            root = Path(sprites_root) / code
            totals = {c: 0 for c in watched}
            for png_path in sorted(root.glob("*.png")):
                counts = count_colors(png_path, watched)
                for c, n in counts.items():
                    totals[c] += n
            per_code[code] = totals
            print(f"  {code}: main×{totals[fam['main']]}, light×{totals[fam['light']]}, highlight×{totals[fam['highlight']]}")
            if totals[fam["light"]] or totals[fam["highlight"]]:
                print(f"  [FAIL] {code} 仍残留 light/highlight 像素")
                ok = False
            if totals[fam["main"]] == 0:
                print(f"  [提示] {code} 无 main 色像素（服装可能以 shadow 为主色）")
        # 抽查族内 main 像素最多的两个人格：main 色像素存在且色值完全相同（同一 RGB 元组即同色值）
        a, b = sorted(codes, key=lambda c: per_code[c][fam["main"]], reverse=True)[:2]
        if per_code[a][fam["main"]] == 0 or per_code[b][fam["main"]] == 0:
            print(f"  [FAIL] 抽查 {a}/{b}：main 色像素缺失")
            ok = False
        else:
            print(f"  [OK] 抽查 {a}/{b}：main 色像素均存在，色值完全相同 #{fam['main'][0]:02X}{fam['main'][1]:02X}{fam['main'][2]:02X}")
    return ok


def main(argv=None):
    """命令行入口：逐人格逐帧统一族色，随后做族内一致性校验。"""
    parser = argparse.ArgumentParser(description="色板 v3 一族一色：族内 light/highlight → main")
    parser.add_argument("--sprites-root", default=str(DEFAULT_SPRITES_ROOT),
                        help="sprite 根目录（默认 resources/sprites）")
    parser.add_argument("--palette", default=str(PALETTE_PATH),
                        help="色板 JSON 路径（默认 assets/style/palette.json）")
    parser.add_argument("--dry-run", action="store_true", help="只统计将改写的像素，不写盘")
    args = parser.parse_args(argv)

    sprites_root = Path(args.sprites_root)
    family_map = load_family_map(args.palette)

    total_changed = 0
    total_frames = 0
    for code, fam in sorted(family_map.items()):
        code_dir = sprites_root / code
        if not code_dir.is_dir():
            print(f"警告：缺少目录 {code_dir}，跳过")
            continue
        for png_path in sorted(code_dir.glob("*.png")):
            changed, _ = unify_png(png_path, fam, dry_run=args.dry_run)
            total_changed += changed
            total_frames += 1
            tag = "（dry-run）" if args.dry_run else ""
            print(f"{code}/{png_path.name}: 改写 {changed} 像素{tag}")
    print(f"处理完成：{total_frames} 帧，共改写 {total_changed} 像素"
          f"{'（dry-run，未写盘）' if args.dry_run else ''}")

    if args.dry_run:
        return 0

    print("族内一致性校验：")
    if verify_family_consistency(family_map, sprites_root):
        print("校验通过：各族均无 light/highlight 残留，族内 main 色一致")
        return 0
    print("校验不通过：见上方 ✗ 项")
    return 1


if __name__ == "__main__":
    sys.exit(main())
