# -*- coding: utf-8 -*-
"""
eval_installer_final.py — 评估最终入选的 build/installer/installer-header.bmp
"""
from __future__ import annotations

import sys
from pathlib import Path
from collections import Counter

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALLER_DIR = REPO_ROOT / "build" / "installer"

CREAM = (254, 249, 239)
INK = (43, 35, 32)
ANALYST = (120, 93, 135)
DIPLOMAT = (62, 143, 110)
SENTINEL = (57, 159, 185)
EXPLORER = (228, 199, 40)

FAMILY_COLORS = {
    "analyst (紫)": ANALYST,
    "diplomat (绿)": DIPLOMAT,
    "sentinel (蓝)": SENTINEL,
    "explorer (黄)": EXPLORER,
}


def color_distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def close_to(color, target, tol=30):
    return color_distance(color, target) <= tol


def evaluate(img_path: Path) -> dict:
    img = Image.open(img_path).convert("RGB")
    pixels = list(img.getdata())
    total = len(pixels)

    cream_count = sum(1 for c in pixels if close_to(c, CREAM, tol=20))
    ink_count = sum(1 for c in pixels if close_to(c, INK, tol=25))
    family_hits = {
        name: sum(1 for c in pixels if close_to(c, rgb, tol=40))
        for name, rgb in FAMILY_COLORS.items()
    }
    family_present = {name: (cnt / total) >= 0.005 for name, cnt in family_hits.items()}

    counter = Counter(pixels)
    distinct_colors = len(counter)

    quant = img.quantize(colors=64, method=Image.Quantize.MAXCOVERAGE)
    palette_size_64 = len(set(quant.getdata()))

    score = 0
    notes: list[str] = []

    cream_ratio = cream_count / total
    if cream_ratio >= 0.20:
        score += 18
    elif cream_ratio >= 0.10:
        score += 10
        notes.append(f"奶油底偏低（{cream_ratio:.1%}）")

    ink_ratio = ink_count / total
    if ink_ratio >= 0.10:
        score += 14
    elif ink_ratio >= 0.05:
        score += 8
        notes.append(f"墨色偏少（{ink_ratio:.1%}）")

    for name, present in family_present.items():
        if present:
            score += 6

    if distinct_colors <= 200:
        score += 18
    elif distinct_colors <= 1000:
        score += 12
    elif distinct_colors <= 5000:
        score += 6
    else:
        notes.append(f"颜色唯一数 {distinct_colors} 过多")

    if palette_size_64 >= 50:
        score += 8
    elif palette_size_64 >= 30:
        score += 4

    return {
        "path": str(img_path),
        "size": img.size,
        "cream_ratio": cream_ratio,
        "ink_ratio": ink_ratio,
        "family_hits": {k: v / total for k, v in family_hits.items()},
        "family_present": family_present,
        "distinct_colors": distinct_colors,
        "palette_size_64": palette_size_64,
        "score": score,
        "notes": notes,
    }


def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    target = INSTALLER_DIR / "installer-header.png"
    if not target.exists():
        print(f"未找到：{target}")
        return 1

    r = evaluate(target)
    print(f"===  最终版安装器插画评估  ===")
    print(f"文件：{r['path']}")
    print(f"尺寸：{r['size'][0]}×{r['size'][1]}")
    print(f"分数：{r['score']}/100")
    print(f"\n  奶油底占比:   {r['cream_ratio']:.1%}")
    print(f"  墨色描边占比:  {r['ink_ratio']:.1%}")
    for name, ratio in r["family_hits"].items():
        mark = "[OK]" if r["family_present"][name] else "[MISS]"
        print(f"  {mark} {name}: {ratio:.1%}")
    print(f"\n  distinct 颜色数: {r['distinct_colors']}")
    print(f"  64 色调色板使用: {r['palette_size_64']}/64")
    if r["notes"]:
        print(f"\n  备注: {'; '.join(r['notes'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())