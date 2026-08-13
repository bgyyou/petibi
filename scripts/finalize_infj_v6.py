# -*- coding: utf-8 -*-
"""
finalize_infj_v6.py — INFJ 重做：v5 候选 → 512×512 合规定稿形象图（覆盖原 infj.png）

与 finalize_portraits_v4.py 的区别：
  - 原 HOODED = {"intj", "infj", "isfp", "infp", "istj"} 把 infj 当作"戴兜帽成员"，
    跳过「中央头部区本族色 → 中性色」（因为头区本族色被视为服装兜帽）。
  - 但本次 INFJ 重做明确要求"真天鹅头"——头部只画鸟的羽毛（白/奶油），不应该出现
    任何外交家绿色像素。本脚本强制把 infj 走头部本族色→中性色步骤，
    把候选里可能残存的绿色阴影污染清理掉。
  - 其他步骤（网格吸附 / 抠背景 / 量化到色板 / 族色纯净 / main 主导 / 碎屑清理）
    全部沿用 finalize_portraits_v4 的实现。

用法：
  python scripts/finalize_infj_v6.py            # 默认选 infj_3（量化前像素分析得出的最优候选）
  python scripts/finalize_infj_v6.py --pick 4   # 选 infj_4

依赖：Pillow；复用 finalize_portraits_v4 与 pixelate 的色板加载函数。
"""

import argparse
import sys
from pathlib import Path

# Windows 控制台默认 GBK
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image

from pixelate import DEFAULT_PALETTE, load_palette
from finalize_portraits_v4 import (
    CANVAS, WHITE, MIN_COMPONENT, HEAD_X0, HEAD_X1, HEAD_Y0, HEAD_Y1,
    flood_background_mask, quantize_keep_white, remove_small_components,
    remap_head_own_family, unify_family_dominance, load_palette_groups,
)
from gen_portraits_v4 import PERSONALITIES

REPO_ROOT = Path(__file__).resolve().parent.parent
CONCEPTS_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "v5"
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"


def code_to_family(code):
    return {
        "intj": "analyst", "intp": "analyst", "entj": "analyst", "entp": "analyst",
        "infj": "diplomat", "infp": "diplomat", "enfj": "diplomat", "enfp": "diplomat",
        "istj": "sentinel", "isfj": "sentinel", "estj": "sentinel", "esfj": "sentinel",
        "istp": "explorer", "isfp": "explorer", "estp": "explorer", "esfp": "explorer",
    }[code]


def finalize_infj(candidate_path, out_path, grid):
    """infj 单张合规化：与 finalize_v4 流程一致，但强制头部本族色→中性色。"""
    code = "infj"
    family = code_to_family(code)
    img = Image.open(candidate_path).convert("RGB")

    # 第 2 步：像素网格吸附（BOX 缩到 grid × grid 再 NEAREST 放大到 512）
    small = img.resize((grid, grid), Image.BOX)
    snapped = small.resize((CANVAS, CANVAS), Image.NEAREST)

    # 第 3 步：背景掩码（洪水填充：白底 + 地面投影 + 签名水印）
    mask, white_count = flood_background_mask(snapped)

    # 第 4 步：量化到色板 + 族色纯净重映射（其他族色系 → 中性色）
    palette = load_palette(DEFAULT_PALETTE)
    families, neutrals, families_named = load_palette_groups()
    own = families[family]
    other = set().union(*(families[f] for f in families if f != family))
    out, remapped = quantize_keep_white(snapped, mask, palette, own, other, neutrals)

    # 第 4b 步：强制中央头部区本族色 → 中性色
    # （覆盖 finalize_v4 的 HOODED 跳过逻辑——新版天鹅是真鸟头，头部不许有外交家绿）
    head_fixed = remap_head_own_family(out, own, neutrals)

    # 第 4c 步：本族四色保序重映射，服装主视觉色钉到 family.main
    unified, mapping = unify_family_dominance(out, families_named[family])

    # 第 5 步：碎屑清理
    erased = remove_small_components(out, MIN_COMPONENT)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(out_path, "PNG")
    total = CANVAS * CANVAS
    print(f"[OK] {candidate_path.name} → {out_path.name}"
        f"（网格 {grid}，白底 {white_count * 100 // total}%，"
        f"族色重映射 {remapped}px，头区本族色→中性 {head_fixed}px，"
        f"main 统一 {unified}px，碎屑抹除 {erased}px）")


def main(argv=None):
    parser = argparse.ArgumentParser(description="INFJ 重做：v5 候选 → 合规定稿（强制头部本族色→中性色）")
    parser.add_argument("--pick", type=int, default=3,
                        help="候选序号（默认 3，对应 infj_3.png——量化前像素分析得出喙最集中的候选）")
    parser.add_argument("--grid", type=int, default=256,
                        help="像素网格边长（默认 256，即 512 画布上 2px 一格）")
    args = parser.parse_args(argv)

    candidate = CONCEPTS_DIR / f"infj_{args.pick}.png"
    if not candidate.exists():
        print(f"[FAIL] 候选不存在：{candidate}")
        return 1
    finalize_infj(candidate, PORTRAITS_DIR / "infj.png", args.grid)
    return 0


if __name__ == "__main__":
    sys.exit(main())