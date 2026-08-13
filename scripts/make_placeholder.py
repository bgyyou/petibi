# -*- coding: utf-8 -*-
"""
make_placeholder.py — 生成 M1 桌宠原型用的占位 sprite（PRD §8.4 / M1 工单）

功能：
  用 PIL 程序绘制一只 48×48 的纯色圆角小怪兽（分析家家族紫色系，
  颜色全部取自 assets/style/palette.json），输出三状态占位动画帧：
    idle   2 帧：身体上下差 1px，模拟呼吸感
    blink  2 帧：眼睛睁开 / 闭合成一条线
    happy  2 帧：微笑弧线 / 张嘴大笑 + 眯眼
  输出到 resources/sprites/placeholder/，透明背景、严格 1-bit alpha
  （PIL ImageDraw 无抗锯齿，alpha 只会是 0 或 255，天然满足红线 R2）。

用法：
  python scripts/make_placeholder.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

# 仓库根目录 = 本文件所在 scripts/ 的上一级，保证从任意工作目录运行都写同一位置
REPO_ROOT = Path(__file__).resolve().parent.parent

# 输出目录：工单约定 resources/sprites/placeholder/
OUT_DIR = REPO_ROOT / "resources" / "sprites" / "placeholder"

# 画布尺寸（PRD §8.4 硬规范：48×48）
CANVAS = 48

# 颜色取自 assets/style/palette.json 的 analyst_分析家_紫 家族四档明度
# （占位图也遵守统一色板规范，方便日后直接对照替换正式稿）
COLOR_OUTLINE = "#3B2A4A"  # 最深：1px 描边 / 瞳孔 / 嘴
COLOR_BODY = "#6B4E8E"     # 次深：身体主色
COLOR_BELLY = "#9B7EC4"    # 次浅：肚皮 / 耳朵内衬
COLOR_EYE = "#C9B4E0"      # 最浅：眼白


def new_canvas():
    """新建一张 48×48 全透明 RGBA 画布（alpha 全 0，后续绘制只产生 255，天然 1-bit）。"""
    return Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))


def draw_body(img, top_offset=0):
    """画小怪兽身体：圆角矩形 + 两只耳朵 + 肚皮。

    top_offset 用于 idle 呼吸感：帧 1 比帧 0 整体下移 1px（身体压扁一拍）。
    """
    draw = ImageDraw.Draw(img)
    # 身体：圆角矩形，范围 (9, 12+top_offset) ~ (39, 42)，圆角半径 8，
    # 填充主色并描 1px 深色边（PRD §8.4：统一 1px 深色描边）
    draw.rounded_rectangle(
        [9, 12 + top_offset, 39, 42],
        radius=8,
        fill=COLOR_BODY,
        outline=COLOR_OUTLINE,
        width=1,
    )
    # 左耳：小三角形（头顶左侧三个点），右耳对称
    draw.polygon([(13, 12 + top_offset), (17, 5 + top_offset), (20, 12 + top_offset)], fill=COLOR_BODY)
    draw.polygon([(28, 12 + top_offset), (31, 5 + top_offset), (35, 12 + top_offset)], fill=COLOR_BODY)
    # 耳朵也补 1px 深色描边（只画轮廓线，不覆盖填充）
    draw.line([(13, 12 + top_offset), (17, 5 + top_offset), (20, 12 + top_offset)], fill=COLOR_OUTLINE, width=1)
    draw.line([(28, 12 + top_offset), (31, 5 + top_offset), (35, 12 + top_offset)], fill=COLOR_OUTLINE, width=1)
    # 肚皮：身体下半部分的浅色椭圆，模拟 2.5 头身 Q 版的肚子
    draw.ellipse([15, 28 + top_offset, 33, 40], fill=COLOR_BELLY)
    return draw


def draw_eyes_open(draw, top_offset=0):
    """画睁开的双眼：浅色眼白方块 + 深色 2×2 瞳孔。"""
    # 左右眼各一个 5×5 眼白矩形
    draw.rectangle([16, 21 + top_offset, 20, 25 + top_offset], fill=COLOR_EYE)
    draw.rectangle([28, 21 + top_offset, 32, 25 + top_offset], fill=COLOR_EYE)
    # 瞳孔 2×2，放在眼白靠下位置（视线朝前下方，显得呆萌）
    draw.rectangle([17, 23 + top_offset, 18, 24 + top_offset], fill=COLOR_OUTLINE)
    draw.rectangle([29, 23 + top_offset, 30, 24 + top_offset], fill=COLOR_OUTLINE)


def draw_eyes_closed(draw, top_offset=0):
    """画闭合的双眼：两条 1px 深色横线（blink 帧用）。"""
    draw.line([(16, 23 + top_offset), (20, 23 + top_offset)], fill=COLOR_OUTLINE, width=1)
    draw.line([(28, 23 + top_offset), (32, 23 + top_offset)], fill=COLOR_OUTLINE, width=1)


def draw_eyes_happy(draw, top_offset=0):
    """画开心眯起的双眼：两个 ∩ 形上半圆弧（happy_1 用）。"""
    # PIL 角度从 3 点钟方向顺时针计；180°→360° 正好描出上半圆（∩）
    draw.arc([16, 21 + top_offset, 21, 26 + top_offset], start=180, end=360, fill=COLOR_OUTLINE)
    draw.arc([27, 21 + top_offset, 32, 26 + top_offset], start=180, end=360, fill=COLOR_OUTLINE)


def draw_mouth_flat(draw, top_offset=0):
    """画待机嘴：一条 1px 短横线。"""
    draw.line([(21, 33 + top_offset), (27, 33 + top_offset)], fill=COLOR_OUTLINE, width=1)


def draw_mouth_smile(draw, top_offset=0):
    """画微笑嘴：下半圆弧（0°→180° 顺时针走 3 点钟→6 点钟→9 点钟，即底部半圆）。"""
    draw.arc([19, 30 + top_offset, 29, 38 + top_offset], start=0, end=180, fill=COLOR_OUTLINE)


def draw_mouth_open(draw, top_offset=0):
    """画张嘴大笑：填充的下半圆（chord 弦形，happy_1 用）。"""
    draw.chord([20, 31 + top_offset, 28, 39 + top_offset], start=0, end=180, fill=COLOR_OUTLINE)


def save(img, name):
    """把一帧保存到输出目录（确保目录存在；RGBA PNG 保留透明背景）。"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img.save(OUT_DIR / name)
    print(f"已生成 {OUT_DIR / name}")


def main():
    """生成三状态共 6 帧占位 sprite。"""
    # idle 帧 0：基准姿态（睁眼 + 平嘴）
    img = new_canvas()
    draw = draw_body(img, top_offset=0)
    draw_eyes_open(draw)
    draw_mouth_flat(draw)
    save(img, "idle_0.png")

    # idle 帧 1：身体下移 1px，与帧 0 来回播放形成呼吸感
    img = new_canvas()
    draw = draw_body(img, top_offset=1)
    draw_eyes_open(draw, top_offset=1)
    draw_mouth_flat(draw, top_offset=1)
    save(img, "idle_1.png")

    # blink 帧 0：睁眼（与 idle_0 同姿态，作为眨眼的"睁"帧）
    img = new_canvas()
    draw = draw_body(img)
    draw_eyes_open(draw)
    draw_mouth_flat(draw)
    save(img, "blink_0.png")

    # blink 帧 1：闭眼成两条线
    img = new_canvas()
    draw = draw_body(img)
    draw_eyes_closed(draw)
    draw_mouth_flat(draw)
    save(img, "blink_1.png")

    # happy 帧 0：睁眼 + 微笑弧线
    img = new_canvas()
    draw = draw_body(img)
    draw_eyes_open(draw)
    draw_mouth_smile(draw)
    save(img, "happy_0.png")

    # happy 帧 1：眯眼 ∩∩ + 张嘴大笑
    img = new_canvas()
    draw = draw_body(img)
    draw_eyes_happy(draw)
    draw_mouth_open(draw)
    save(img, "happy_1.png")


if __name__ == "__main__":
    main()
