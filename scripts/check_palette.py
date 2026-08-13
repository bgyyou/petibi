# -*- coding: utf-8 -*-
"""
check_palette.py — sprite 色板合规校验脚本（M1 工单 v2 验收：颜色全在色板内）

功能：
  递归扫描指定目录（默认 resources/sprites/）下的所有 PNG，
  检查每个不透明像素的颜色是否落在 assets/style/palette.json 色板内
  （色板 v3「一族一色」：families 每族 main/shadow/light/highlight 4 色
   + neutrals 8 色 + outline，自动去重；personalities 仅族归属，无颜色）。

输出：每个 PNG 一行 OK / 越界色清单；末尾汇总。

退出码：全部合规 → 0；存在越界色 → 1（供验收拦截用）。

用法：
  python scripts/check_palette.py [目录...]

依赖：仅 Pillow。
"""

import json
import sys
from pathlib import Path

from PIL import Image

# 仓库根目录 = 本文件所在 scripts/ 的上一级，用它定位色板，保证任意工作目录下都能跑
REPO_ROOT = Path(__file__).resolve().parent.parent

# 色板路径与默认扫描目录（工单验收第 1 条）
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"
DEFAULT_DIRS = [REPO_ROOT / "resources" / "sprites"]


def load_palette_colors(palette_path=PALETTE_PATH):
    """递归收集色板 JSON 中全部 #RRGGBB 颜色，返回去重后的 (R,G,B) 集合。

    与 pixelate.py 的 load_palette 保持同一套解析逻辑（跳过 // 注释键），
    families（嵌套 dict 的族四色）/ neutrals / outline 全部纳入允许集；
    personalities 在色板 v3 中只剩 animal/family 文本，递归遍历自然采不到颜色。
    """
    data = json.loads(Path(palette_path).read_text(encoding="utf-8"))
    colors = set()

    def walk(value):
        if isinstance(value, str) and value.startswith("#") and len(value) == 7:
            try:
                colors.add((int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)))
            except ValueError:
                pass
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    for key, value in data.items():
        if key.startswith("//"):
            continue
        walk(value)
    return colors


def off_palette_colors(png_path, allowed):
    """统计单个 PNG 中不在色板内的不透明像素颜色，返回 {颜色: 像素数}。"""
    img = Image.open(png_path).convert("RGBA")
    counts = {}
    for r, g, b, a in img.getdata():
        if a == 0:
            continue  # 透明像素不参与色板校验
        if (r, g, b) not in allowed:
            counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    return counts


def main(argv=None):
    """扫描目录，逐文件判定并汇总，按结果决定退出码。"""
    dirs = [Path(d) for d in (argv if argv else DEFAULT_DIRS)]
    allowed = load_palette_colors()
    print(f"色板允许颜色数 = {len(allowed)}")

    bad_files = 0
    checked = 0
    for directory in dirs:
        if not directory.exists():
            print(f"目录不存在，跳过：{directory}")
            continue
        for png_path in sorted(directory.rglob("*.png")):
            checked += 1
            offenders = off_palette_colors(png_path, allowed)
            if offenders:
                bad_files += 1
                detail = ", ".join(f"#{r:02X}{g:02X}{b:02X}×{n}" for (r, g, b), n in sorted(offenders.items()))
                print(f"{png_path}: 越界色 {detail}")
            else:
                print(f"{png_path}: OK")
    print(f"检查完成：{checked} 个 PNG，越界文件 {bad_files} 个")
    if bad_files:
        print("检查不通过：存在色板外颜色，请用 scripts/pixelate.py 重新量化")
        return 1
    print("检查通过：全部颜色均在色板内（families + neutrals + outline）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
