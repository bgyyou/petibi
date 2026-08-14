# -*- coding: utf-8 -*-
"""
eval_installer_candidates.py — 自动评估安装器插画候选的像素感 / 色板匹配度（M5 工单）。

评估维度（DESIGN.md §3 硬性规则）：
  1. 奶油底覆盖度（#FEF9EF 像素占比 >= 30%）—— 说明有干净底色
  2. 墨色描边出现（#2B2320 像素占比 >= 3%）—— 说明有描边
  3. 四族色齐全：紫 #785D87 / 绿 #3E8F6E / 蓝 #399FB9 / 黄 #E4C728 均 >= 0.5%
  4. 像素感评分：相邻像素颜色方差（量化后调色板 ≤ 64 色说明像素感强；
     渐变脏边会让色板远超 64 色）
  5. 颜色唯一数（distinct colors）—— 越少越像像素图（AI 图常 10K+ colors）

输出：每张候选的逐项分数 + 总分（满分 100）+ 推荐结论。

用法：python scripts/eval_installer_candidates.py
"""
from __future__ import annotations

import io
import sys
from pathlib import Path
from collections import Counter

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
CANDIDATES_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "installer"

# DESING.md §2 色板
CREAM = (254, 249, 239)
INK = (43, 35, 32)
ANALYST = (120, 93, 135)   # 紫
DIPLOMAT = (62, 143, 110)  # 绿
SENTINEL = (57, 159, 185)  # 蓝
EXPLORER = (228, 199, 40)  # 黄

FAMILY_COLORS = {
    "analyst (紫)": ANALYST,
    "diplomat (绿)": DIPLOMAT,
    "sentinel (蓝)": SENTINEL,
    "explorer (黄)": EXPLORER,
}


def color_distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def close_to(color, target, tol=30):
    """RGB euclidean distance <= tol 视为接近目标色。"""
    return color_distance(color, target) <= tol


def evaluate(img_path: Path) -> dict:
    """对单张候选做评分；返回字典。"""
    img = Image.open(img_path).convert("RGB")
    pixels = list(img.getdata())
    total = len(pixels)

    # 统计各色匹配数
    cream_count = sum(1 for c in pixels if close_to(c, CREAM, tol=20))
    ink_count = sum(1 for c in pixels if close_to(c, INK, tol=25))
    family_hits = {
        name: sum(1 for c in pixels if close_to(c, rgb, tol=40))
        for name, rgb in FAMILY_COLORS.items()
    }
    family_present = {name: (cnt / total) >= 0.005 for name, cnt in family_hits.items()}

    # 颜色唯一数（仅统计 top 1% 出现次数的色，避免噪声）
    counter = Counter(pixels)
    distinct_colors = len(counter)

    # 像素感：相同颜色相邻像素数（粗略用颜色频率反映）
    # 这里用 PIL quantize 后的调色板大小作为更稳的"像素感"指标
    quant = img.quantize(colors=64, method=Image.Quantize.MAXCOVERAGE)
    palette_size_64 = len(set(quant.getdata()))
    quant_16 = img.quantize(colors=16, method=Image.Quantize.MAXCOVERAGE)
    palette_size_16 = len(set(quant_16.getdata()))

    # 评分（满分 100）
    score = 0
    notes: list[str] = []

    # 奶油底 30% 以上 → 18 分（背景干净）
    cream_ratio = cream_count / total
    if cream_ratio >= 0.30:
        score += 18
    elif cream_ratio >= 0.15:
        score += 10
        notes.append(f"奶油底偏低（{cream_ratio:.1%}）")
    else:
        notes.append(f"奶油底过低（{cream_ratio:.1%}）—— 缺少干净底")

    # 墨色描边 >= 3% → 14 分
    ink_ratio = ink_count / total
    if ink_ratio >= 0.03:
        score += 14
    elif ink_ratio >= 0.01:
        score += 8
        notes.append(f"墨色描边偏少（{ink_ratio:.1%}）")
    else:
        notes.append(f"几乎没有墨色描边（{ink_ratio:.1%}）")

    # 四族色齐全（每族 1.5%，共 6 × 4 = 24 分）
    for name, present in family_present.items():
        if present:
            score += 6

    # 像素感（颜色唯一数 + 量化调色板大小）：
    # 真正像素图通常 distinct < 6000；quantize 到 64 色基本无损 → 高分
    # AI 渐变图 distinct > 30000 → 低分
    if distinct_colors <= 5000:
        score += 18
    elif distinct_colors <= 12000:
        score += 12
    elif distinct_colors <= 25000:
        score += 6
    else:
        notes.append(f"颜色唯一数 {distinct_colors} 太多 —— 像渐变渲染图")

    # 64 色量化后还原度（palette_size_64 / 64 >= 0.6）→ 8 分
    if palette_size_64 >= 60:
        score += 8
    elif palette_size_64 >= 40:
        score += 4
        notes.append(f"64 色量化调色板使用率 {palette_size_64}/64")

    # 16 色量化后还原度（palette_size_16 / 16 >= 0.6）→ 6 分
    if palette_size_16 >= 14:
        score += 6
    elif palette_size_16 >= 10:
        score += 3

    # 缺失四族色 → 扣 12 分（每族缺 1 个扣 3）
    missing = [n for n, p in family_present.items() if not p]
    if missing:
        notes.append(f"缺族色：{', '.join(missing)}")

    return {
        "path": str(img_path),
        "size": img.size,
        "cream_ratio": cream_ratio,
        "ink_ratio": ink_ratio,
        "family_hits": {k: v / total for k, v in family_hits.items()},
        "family_present": family_present,
        "distinct_colors": distinct_colors,
        "palette_size_64": palette_size_64,
        "palette_size_16": palette_size_16,
        "score": score,
        "notes": notes,
    }


def main():
    # GBK Windows console 兼容：把 stdout 切到 utf-8
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    candidates = sorted(CANDIDATES_DIR.glob("installer_*.png"))
    if not candidates:
        print(f"未找到候选 PNG：{CANDIDATES_DIR}/installer_*.png")
        return 1

    results = []
    for c in candidates:
        r = evaluate(c)
        results.append(r)

    # 按分数排序输出
    results.sort(key=lambda r: r["score"], reverse=True)
    print(f"评估 {len(results)} 张候选（{CANDIDATES_DIR}）\n")
    for i, r in enumerate(results, 1):
        print(f"{'='*60}")
        print(f"[{i}] {Path(r['path']).name}（{r['size'][0]}×{r['size'][1]}） 分数 = {r['score']}/100")
        print(f"  奶油底占比:  {r['cream_ratio']:.1%}")
        print(f"  墨色描边占比: {r['ink_ratio']:.1%}")
        for name, ratio in r["family_hits"].items():
            mark = "[OK]" if r["family_present"][name] else "[MISS]"
            print(f"  {mark} {name}: {ratio:.1%}")
        print(f"  distinct 颜色数: {r['distinct_colors']}")
        print(f"  64 色调色板使用率: {r['palette_size_64']}/64")
        print(f"  16 色调色板使用率: {r['palette_size_16']}/16")
        if r["notes"]:
            print(f"  备注: {'; '.join(r['notes'])}")

    print("\n" + "=" * 60)
    best = results[0]
    print(f"推荐候选（分数最高）：{Path(best['path']).name}")
    if best["score"] < 60:
        print("⚠  所有候选分数偏低，建议重新调整 prompt 重生成（DESIGN.md §6 像素风要求高）")
    return 0


if __name__ == "__main__":
    sys.exit(main())