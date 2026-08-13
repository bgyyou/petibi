# -*- coding: utf-8 -*-
"""
finalize_v2.py — 候选概念稿 → 定稿 sprite 的收尾管线（M1 工单 v2 第 2/3 步）

对每只人格执行：
  1. 调 pixelate.py 的 pixelate()：去白底 → 裁剪缩放 32×32 → 色板量化
  2. 清底部投影：概念图人物脚下的浅灰投影量化后会在内容最底部形成
     整行灰色横带（灰 #9A9A9A / 深灰 #555555），从底向上逐行删除
     "几乎全灰"的行，再清掉紧邻脚部、上下无依托的孤立灰像素
  3. 输出定稿到 assets/art/final_v2/<人格>.png
  4. 调 make_idle.py 生成 idle_0/idle_1 到 resources/sprites/<人格>/

选片表 PICKS：人格 → (候选序号, bg-tolerance)。白毛动物（天鹅/企鹅）调低容差防误抠。

用法：
  python scripts/finalize_v2.py            # 处理 PICKS 里全部人格
  python scripts/finalize_v2.py intj intp  # 只处理指定人格

依赖：仅 Pillow + 同目录 pixelate.py / make_idle.py。
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pixelate import pixelate, DEFAULT_PALETTE  # noqa: E402
from make_idle import make_idle_frames  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
CONCEPTS = REPO_ROOT / "assets" / "art" / "concepts" / "v2"
FINAL_DIR = REPO_ROOT / "assets" / "art" / "final_v2"
SPRITES_DIR = REPO_ROOT / "resources" / "sprites"

# 选片表：人格 → (候选文件序号, 背景容差)
# 容差说明：默认 30；有浅灰投影残留的可调低……不，投影是"比白深"，容差只管接近白的程度。
# 白毛动物（infj 天鹅 / isfj 企鹅）白毛接近白底，必须调低容差防止白毛被误抠。
PICKS = {
    "intj": (3, 30),
    "intp": (3, 30),
    "entj": (2, 30),
    "entp": (1, 30),
    "infj": (1, 20),
    "infp": (1, 30),
    "enfj": (2, 30),
    "enfp": (3, 25),
    "istj": (2, 30),
    "isfj": (1, 22),
    "estj": (1, 30),
    "esfj": (4, 30),
    "istp": (1, 30),
    "isfp": (3, 30),
    "estp": (2, 30),
    "esfp": (3, 30),
}

# 投影灰：量化后投影只会落到这两个中性灰色
SHADOW_GRAYS = {(0x9A, 0x9A, 0x9A), (0x55, 0x55, 0x55)}


def clean_shadow(img):
    """清理定稿底部的投影灰像素（概念图地面投影量化后的残留）。

    规则：
      1. 从内容最底行向上，整行不透明像素 ≥70% 是投影灰 → 整行删除，直到遇到正常行
      2. 再扫一遍底部 4 行：孤立的投影灰像素（正上方没有不透明非灰像素依托）一并删除
    只动底部区域，动物身上的灰毛（如海豚/象，多在躯干）不受影响。
    """
    img = img.copy()
    w, h = img.size
    px = img.load()

    def opaque(x, y):
        return px[x, y][3] > 0

    def is_gray(x, y):
        return px[x, y][:3] in SHADOW_GRAYS

    # 第 1 步：删底部"整行灰"横带；≤2 像素的行视为散点直接删除并继续向上
    for y in range(h - 1, -1, -1):
        row = [x for x in range(w) if opaque(x, y)]
        if not row:
            continue  # 跳过空行
        if len(row) <= 2:
            # 底部孤立散点（量化噪声/残点），删除后继续向上找投影带
            for x in row:
                px[x, y] = (0, 0, 0, 0)
            continue
        gray = sum(1 for x in row if is_gray(x, y))
        if gray >= max(1, int(len(row) * 0.7)):
            for x in row:
                px[x, y] = (0, 0, 0, 0)
        else:
            break  # 遇到正常内容行即停

    # 第 2 步：清底部 4 行内无依托的孤立灰像素（脚边投影残点）
    for y in range(h - 1, max(h - 5, -1), -1):
        for x in range(w):
            if opaque(x, y) and is_gray(x, y):
                above_ok = y > 0 and any(
                    opaque(x + dx, y - 1) and not is_gray(x + dx, y - 1) for dx in (-1, 0, 1)
                    if 0 <= x + dx < w
                )
                if not above_ok:
                    px[x, y] = (0, 0, 0, 0)
    return img


def finalize_one(code, idx, tolerance):
    """单只人格：pixelate → 清投影 → 存定稿 → 生成 idle 双帧。"""
    src = CONCEPTS / f"{code}_{idx}.png"
    if not src.exists():
        raise FileNotFoundError(f"候选不存在：{src}")
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    final_path = FINAL_DIR / f"{code}.png"

    # pixelate() 直接落盘后再读回清理（保持脚本间文件接口清晰）
    pixelate(str(src), str(final_path), bg_tolerance=tolerance)
    img = Image.open(final_path).convert("RGBA")
    img = clean_shadow(img)
    img.save(final_path, "PNG")

    make_idle_frames(str(final_path), SPRITES_DIR / code)
    print(f"[{code}] 定稿完成：{final_path.name}（候选 {idx}，容差 {tolerance}）")


def main(argv):
    codes = argv if argv else list(PICKS)
    for code in codes:
        idx, tolerance = PICKS[code]
        finalize_one(code, idx, tolerance)
    print(f"全部完成：{len(codes)} 只")


if __name__ == "__main__":
    main(sys.argv[1:])
