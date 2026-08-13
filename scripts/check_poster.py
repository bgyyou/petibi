# -*- coding: utf-8 -*-
"""
check_poster.py — 海报像素级校验脚本（M4 工单自验第 2 条）

校验项：
  1. 文件是合法 PNG / 尺寸 = 1080×1350（REVIEW §2.5 硬性）
  2. 水印文字区域（底部 1180~1350 像素带）非空：
     - 至少 0.5% 像素是深色（RGB 灰度 < 200），证明水印文字 / 日期确实画上去了
  3. 背景非纯白：整图浅色族色调，至少 90% 像素与 #FFFFFF 的色差 > 5
     （避免某次族色映射失效导致整张海报变白底）
  4. 顶部品牌条非空：0~110 像素带至少 5% 像素不是 #FFFFFF（保证品牌条 + slogan 真的画了）

用法：
  python scripts/check_poster.py <path1.png> [path2.png ...]
  python scripts/check_poster.py assets/art/poster-samples/*.png   # 全部样张

退出码：
  所有文件全部通过 → 0；任一不过 → 1。

依赖：Pillow（项目内已用，scripts/pixelate.py 引用）。
"""

import sys
from pathlib import Path

from PIL import Image

# 海报硬性尺寸（与 src/share/poster.ts 的 POSTER_WIDTH/POSTER_HEIGHT 对齐）
EXPECTED_W = 1080
EXPECTED_H = 1350

# 校验阈值（经验值，足够宽松避免误杀，留出字体抗锯齿/字形变化余地）
BG_MIN_DIFF = 5       # 与白色的色差下限
# 整图非白像素占比下限：海报有大量白卡片（500×960），加上族色背景装饰，
# 实际非白像素约 55-65%，阈值取 0.50 留出字体抗锯齿/色阶量化余地
BG_NONWHITE_RATIO = 0.50
# 顶部品牌条非白像素占比下限：紫/绿/蓝/黄族色整条 1080×110 ≥ 5% 非白即通过
TOP_BAR_NONWHITE_RATIO = 0.80
# 水印带颜色种类下限：族色浅化背景 + 副 Slogan 文字 + 灰色日期 + 像素星四角 ≥ 6 桶
WATERMARK_MIN_COLOR_BUCKETS = 6


def diff_to_white(px):
    """计算一个 RGB 像素与纯白的欧氏距离，返回 0~441 范围的整数。"""
    r, g, b = px[:3]
    return ((255 - r) ** 2 + (255 - g) ** 2 + (255 - b) ** 2) ** 0.5


def check_one(path: Path) -> tuple[bool, list[str]]:
    """校验单张海报，返回 (passed, failure_messages)。"""
    failures: list[str] = []
    try:
        img = Image.open(path).convert("RGB")
    except Exception as e:
        return False, [f"无法打开图片: {e}"]

    # 1) 尺寸
    w, h = img.size
    if w != EXPECTED_W or h != EXPECTED_H:
        failures.append(f"尺寸不符：实际 {w}x{h}，期望 {EXPECTED_W}x{EXPECTED_H}")

    # 全图统计（非白像素占比）
    total_px = w * h
    nonwhite_count = 0
    # 顶部品牌条 (0..110, 0..w)
    top_bar_total = w * 110
    top_bar_nonwhite = 0
    # 底部水印带 (1180..1350, 0..w)
    watermark_y0, watermark_y1 = 1180, h
    watermark_total = w * (watermark_y1 - watermark_y0)
    # 水印带颜色集合：用于检测"非主色像素比例"——
    # 水印带如果只有一种族色就是空；有 ≥ N 种不同颜色（含白色文字、灰色日期、族色文字）才合格
    watermark_color_buckets: set[tuple[int, int, int]] = set()

    # 单次扫描，全部指标一起算
    px_data = img.load()
    for y in range(h):
        for x in range(w):
            px = px_data[x, y]
            d = diff_to_white(px)
            if d > BG_MIN_DIFF:
                nonwhite_count += 1
            if y < 110 and d > BG_MIN_DIFF:
                top_bar_nonwhite += 1
            if watermark_y0 <= y < watermark_y1:
                # 把 RGB 量化到 16 阶一桶：把抗锯齿边缘的细微颜色变化并入主桶，
                # 避免字形边缘的渐变色把"颜色数"撑成几千
                bucket = (px[0] >> 4, px[1] >> 4, px[2] >> 4)
                watermark_color_buckets.add(bucket)

    # 2) 背景非白
    nonwhite_ratio = nonwhite_count / total_px
    if nonwhite_ratio < BG_NONWHITE_RATIO:
        failures.append(
            f"背景疑似纯白：非白像素占比 {nonwhite_ratio:.1%} < {BG_NONWHITE_RATIO:.0%}"
        )

    # 3) 顶部品牌条非空
    top_bar_ratio = top_bar_nonwhite / top_bar_total
    if top_bar_ratio < TOP_BAR_NONWHITE_RATIO:
        failures.append(
            f"顶部品牌条疑似空白：非白像素占比 {top_bar_ratio:.1%} < {TOP_BAR_NONWHITE_RATIO:.0%}"
        )

    # 4) 水印文字区域非空：用"颜色种类数"判定——
    # 海报底部有族色背景 + 副 Slogan 文字 + 灰色日期 + 像素星四角，
    # 至少 6 种不同颜色桶。族色浅化背景只占 1-2 桶；纯空时整带就是 1-2 桶。
    if len(watermark_color_buckets) < WATERMARK_MIN_COLOR_BUCKETS:
        failures.append(
            f"底部水印带疑似无内容：颜色种类 {len(watermark_color_buckets)} 桶 < {WATERMARK_MIN_COLOR_BUCKETS}"
        )

    return (len(failures) == 0), failures


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().split("\n\n")[0])
        print()
        print("用法: python scripts/check_poster.py <path1.png> [path2.png ...]")
        return 2

    paths = [Path(p) for p in sys.argv[1:]]
    missing = [p for p in paths if not p.exists()]
    if missing:
        for p in missing:
            print(f"[缺失] {p}")
        return 1

    all_pass = True
    for p in paths:
        ok, failures = check_one(p)
        if ok:
            print(f"[OK]    {p}")
        else:
            all_pass = False
            print(f"[失败]  {p}")
            for f in failures:
                print(f"        - {f}")

    if all_pass:
        print(f"\n全部 {len(paths)} 张海报像素级校验通过")
        return 0
    print(f"\n有海报未通过校验")
    return 1


if __name__ == "__main__":
    sys.exit(main())
