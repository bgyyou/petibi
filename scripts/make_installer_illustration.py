# -*- coding: utf-8 -*-
"""
make_installer_illustration.py — NSIS 安装器 164×314 品牌插画（M5 工单升级版）。

设计依据：docs/DESIGN.md §6 — NSIS 安装器左侧 164×314 像素品牌插画位，
主题："16 只像素动物排队欢迎你"。本版用 resources/sprites/<type>/base.png
64×64 base sprite 作素材，落地为：

  ┌──────────────────────────┐  ← 164
  │ [logo] PETIBI            │   28  标题栏（DESIGN.md §6：自绘窗口标题栏调性）
  ├──────────────────────────┤
  │ [16 sprite grid 4×4]     │  258  4 族 × 4 人格
  │  [每格族色顶条 + 类型]   │       每族一行，共 4 行
  │                          │
  ├──────────────────────────┤
  │ PETIBI 16人格全家福     │   28  品牌条
  └──────────────────────────┘  ← 314

风格契约（DESIGN.md §3 硬性规则）：
  - 无圆角 / 无渐变 / 无柔阴影；
  - 边框统一 3px #2B2320；
  - 强调色只用四族色；
  - 像素 sprite 用 NEAREST 缩放，硬边保留；
  - 装饰：像素星星 + 像素分隔线 + 像素文字。

输出：
  - build/installer/installer-header.bmp   （electron-builder NSIS 侧栏标准格式）
  - build/installer/installer-header.png   （同源 PNG，便于人工核对）

依赖：仅 Pillow。

用法：python scripts/make_installer_illustration.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 仓库根 = scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# 输入：64×64 base sprite（resources/sprites/<type>/base.png）
SPRITES_DIR = REPO_ROOT / "resources" / "sprites"

# 输出：installer 资源
OUT_DIR = REPO_ROOT / "build" / "installer"

# 安装器插画尺寸（DESIGN.md §6 / electron-builder NSIS 侧栏）
HEADER_W, HEADER_H = 164, 314

# 设计令牌（DESIGN.md §2 / §3）
INK = (43, 35, 32)            # #2B2320 描边/正文
CREAM = (254, 249, 239)       # #FEF9EF 奶油底
PAPER = (255, 255, 255)       # #FFFFFF 纸白
MUTE = (139, 134, 128)        # #8B8680 辅助文字

# 四族强调色（DESIGN.md §2）
FAMILY_FG = {
    "analyst":  (120, 93, 135),   # #785D87 紫
    "diplomat": (62, 143, 110),   # #3E8F6E 绿
    "sentinel": (57, 159, 185),   # #399FB9 蓝
    "explorer": (228, 199, 40),   # #E4C728 黄
}
# 四族底纹（DESIGN.md §2 强调色族色之外的浅底）
FAMILY_BG = {
    "analyst":  (241, 235, 246),  # #f1ebf6
    "diplomat": (232, 243, 236),  # #e8f3ec
    "sentinel": (230, 238, 247),  # #e6eef7
    "explorer": (251, 242, 220),  # #fbf2dc
}

# 16 人格顺序：4 族 × 4 字母，与 src/setup/persona-meta.ts PERSONAS 完全一致
PERSONAS = [
    # analyst 紫
    ("intj", "INTJ", "analyst"),
    ("intp", "INTP", "analyst"),
    ("entj", "ENTJ", "analyst"),
    ("entp", "ENTP", "analyst"),
    # diplomat 绿
    ("infj", "INFJ", "diplomat"),
    ("infp", "INFP", "diplomat"),
    ("enfj", "ENFJ", "diplomat"),
    ("enfp", "ENFP", "diplomat"),
    # sentinel 蓝
    ("istj", "ISTJ", "sentinel"),
    ("isfj", "ISFJ", "sentinel"),
    ("estj", "ESTJ", "sentinel"),
    ("esfj", "ESFJ", "sentinel"),
    # explorer 黄
    ("istp", "ISTP", "explorer"),
    ("isfp", "ISFP", "explorer"),
    ("estp", "ESTP", "explorer"),
    ("esfp", "ESFP", "explorer"),
]


def load_font(size: int) -> ImageFont.ImageFont:
    """挑一个能渲染像素风的系统字体；找不到就退到默认。"""
    candidates = [
        "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/cour.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/System/Library/Fonts/Menlo.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_pixel_title_bar(draw: ImageDraw.ImageDraw, height: int) -> None:
    """顶部 28px 自绘标题栏（DESIGN.md §6 调性：奶油底 + Petibi 像素 logo + 标题）。"""
    # 底色
    draw.rectangle([0, 0, HEADER_W - 1, height - 1], fill=CREAM)
    # 3px 墨色底边
    draw.rectangle([0, height - 3, HEADER_W - 1, height - 1], fill=INK)

    # Petibi 像素 logo：8×8 像素方块
    # 左侧 4×4 紫 + 右侧 4×4 绿 的双层像素块
    logo_x, logo_y = 8, (height - 8) // 2 - 2
    # 描边方块
    draw.rectangle([logo_x - 1, logo_y - 1, logo_x + 17, logo_y + 9], outline=INK, width=1)
    # 内部 4×4 像素矩阵：2 行紫，2 行绿
    for ry in range(2):
        for rx in range(2):
            draw.rectangle(
                [logo_x + rx * 4, logo_y + ry * 4,
                 logo_x + rx * 4 + 3, logo_y + ry * 4 + 3],
                fill=FAMILY_FG["analyst"],
            )
    for ry in range(2, 4):
        for rx in range(2):
            draw.rectangle(
                [logo_x + rx * 4, logo_y + ry * 4,
                 logo_x + rx * 4 + 3, logo_y + ry * 4 + 3],
                fill=FAMILY_FG["diplomat"],
            )

    # "PETIBI" 文字（像素风等宽字体）
    font_title = load_font(11)
    draw.text((32, (height - 11) // 2 - 1), "PETIBI", fill=INK, font=font_title)


def render_pixel_sprite_cell(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
    type_lower: str,
    type_upper: str,
    family: str,
    x: int,
    y: int,
    cell_w: int,
    cell_h: int,
    label_h: int,
    sprite_size: int,
) -> None:
    """在指定 (x, y) 画一个 4×4 网格里的单格。

    格子结构（自上而下）：
      - 族色顶条 3px
      - sprite 32×32 居中
      - 类型标签区 12px 高（黑底白字）
      - 整格描边 1px #2B2320
    """
    fg = FAMILY_FG[family]
    bg = FAMILY_BG[family]

    # 整格底色（族色底纹，浅底）
    draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], fill=bg)
    # 整格描边（细线，避免占满 3px 在小格子里比例失衡）
    draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=INK, width=1)

    # 族色顶条：3px
    draw.rectangle([x + 1, y + 1, x + cell_w - 2, y + 3], fill=fg)

    # sprite 居中粘贴（用 base.png）
    sprite_x = x + (cell_w - sprite_size) // 2
    sprite_y = y + 5  # 顶条下方留 2px
    sprite_path = SPRITES_DIR / type_lower / "base.png"
    if sprite_path.exists():
        try:
            sprite = Image.open(sprite_path).convert("RGBA")
            # NEAREST 缩放到 sprite_size
            scaled = sprite.resize((sprite_size, sprite_size), Image.NEAREST)
            canvas.paste(scaled, (sprite_x, sprite_y), scaled)
        except Exception as err:
            # sprite 缺失时画一个简单 placeholder
            print(f"warn: sprite {type_lower} 读取失败：{err}", file=sys.stderr)
            draw.rectangle(
                [sprite_x, sprite_y, sprite_x + sprite_size - 1, sprite_y + sprite_size - 1],
                fill=MUTE,
            )
    else:
        # sprite 缺失占位
        draw.rectangle(
            [sprite_x, sprite_y, sprite_x + sprite_size - 1, sprite_y + sprite_size - 1],
            fill=MUTE,
        )

    # 类型标签区：底部 12px 高（黑底白字 MBTI 缩写）
    label_y = y + cell_h - label_h
    draw.rectangle([x + 1, label_y, x + cell_w - 2, y + cell_h - 2], fill=INK)
    font_label = load_font(8)
    # 居中文本：用 textbbox 取宽高做 offset
    bbox = draw.textbbox((0, 0), type_upper, font=font_label)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = x + (cell_w - tw) // 2
    ty = label_y + (label_h - th) // 2 - 1
    draw.text((tx, ty), type_upper, fill=CREAM, font=font_label)


def render_pixel_footer(draw: ImageDraw.ImageDraw, y_top: int, height: int) -> None:
    """底部品牌条：黑底 + "PETIBI · 16人格全家福" 白字 + 像素装饰点阵。"""
    # 黑底
    draw.rectangle([0, y_top, HEADER_W - 1, y_top + height - 1], fill=INK)
    # 顶边线 1px 紫（DESIGN.md §3 装饰可用四族色）
    draw.rectangle([0, y_top, HEADER_W - 1, y_top], fill=FAMILY_FG["analyst"])

    font_brand = load_font(10)
    text = "PETIBI . 16 personality family"
    bbox = draw.textbbox((0, 0), text, font=font_brand)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (HEADER_W - tw) // 2
    ty = y_top + (height - th) // 2 - 1
    draw.text((tx, ty), text, fill=CREAM, font=font_brand)

    # 装饰：左右两侧 4×4 像素点（紫绿蓝黄四族色）
    for i, color in enumerate(FAMILY_FG.values()):
        # 左 4 列
        lx = 4 + i * 2
        ly = y_top + 4
        draw.rectangle([lx, ly, lx + 1, ly + 1], fill=color)
        # 右 4 列
        rx = HEADER_W - 4 - 4 * 2 + i * 2
        ry = y_top + 4
        draw.rectangle([rx, ry, rx + 1, ry + 1], fill=color)


def render_header() -> Image.Image:
    """渲染安装器 164×314 品牌插画。"""
    canvas = Image.new("RGB", (HEADER_W, HEADER_H), CREAM)
    draw = ImageDraw.Draw(canvas)

    # 顶部自绘标题栏（DESIGN.md §6 调性）
    title_h = 28
    render_pixel_title_bar(draw, title_h)

    # 4×4 网格区
    grid_top = title_h
    grid_bottom = HEADER_H - 28  # 留 28 给底部品牌条
    grid_h = grid_bottom - grid_top

    # 4 行 × 4 列；列间距 4px、行间距 4px；每格 36×h
    cols = 4
    rows = 4
    cell_w = 36
    col_gap = 4
    row_gap = 4
    # 水平居中：grid_w = 4*36 + 3*4 = 156 → 左右各 4px
    grid_w = cols * cell_w + (cols - 1) * col_gap
    grid_x_start = (HEADER_W - grid_w) // 2
    # 行高 = (grid_h - 3 * row_gap) / 4
    cell_h = (grid_h - (rows - 1) * row_gap) // rows
    label_h = 12
    sprite_size = min(cell_w - 4, cell_h - label_h - 5)

    for idx, (type_lower, type_upper, family) in enumerate(PERSONAS):
        col = idx % cols
        row = idx // cols
        x = grid_x_start + col * (cell_w + col_gap)
        y = grid_top + row * (cell_h + row_gap)
        render_pixel_sprite_cell(
            canvas, draw, type_lower, type_upper, family,
            x, y, cell_w, cell_h, label_h, sprite_size,
        )

    # 底部品牌条
    render_pixel_footer(draw, grid_bottom, 28)

    # 整体外框 1px（DESIGN.md §3 边框统一 3px 但 164 宽装 1px 外框更协调）
    draw.rectangle([0, 0, HEADER_W - 1, HEADER_H - 1], outline=INK, width=1)

    return canvas


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    canvas = render_header()

    # BMP：electron-builder NSIS 侧栏标准格式（24-bit RGB，无 alpha）
    out_bmp = OUT_DIR / "installer-header.bmp"
    canvas_rgb = canvas.convert("RGB")
    canvas_rgb.save(out_bmp, format="BMP")

    # PNG：同源调试图，便于人工核对
    out_png = OUT_DIR / "installer-header.png"
    canvas_rgb.save(out_png)

    print(f"安装器插画（M5 工单 164×314 像素版）已生成：")
    print(f"  BMP: {out_bmp}")
    print(f"  PNG: {out_png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())