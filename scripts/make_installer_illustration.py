# -*- coding: utf-8 -*-
"""
make_installer_illustration.py — 生成 NSIS 安装器品牌插画占位图（T3 工单第 6 条）

工单约定：
  - electron-builder 的 NSIS 安装器有"左侧 164×314 像素插画位"，DESIGN.md §6 要求
    像素风 16 人格全家福 sprite 排列图；
  - 正式 AI 插画后续单独出稿替换，本脚本先用 PIL 把 16 人格 portrait 拼成 164×314 sprite
    网格作为占位图，避免 UI 返工阻塞在等美术上；
  - 同时输出 256×256 的 .ico（installerIcon / uninstallerIcon）。

输入：
  - assets/art/portraits/<type>.png （M1 已生成的 16 人格 512×512 形象图）
  - assets/style/palette.json （DESIGN.md §2 色板，含四族色）

输出：
  - build/installer/installer-header.bmp  （164×314 BMP，安装器侧栏插画）
  - build/installer/icon.ico             （256×256 ICO，安装器 / 卸载器图标）
  - build/installer/installer-header.png （调试用 PNG，开发者参考）

依赖：
  - Pillow（pip install Pillow），纯 Python。
  - 仓库 root 仓库已有 scripts/ 目录，本脚本放在 scripts/ 下。

用法：
  python scripts/make_installer_illustration.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Pillow 导入；缺依赖时给出友好提示
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("缺少依赖 Pillow，请先 pip install Pillow", file=sys.stderr)
    raise

# 仓库根 = scripts/ 的上一级（沿用 check_comments.py 的约定）
REPO_ROOT = Path(__file__).resolve().parent.parent

# 输入：16 人格 portrait
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"

# 调色板：DESIGN.md §2
PALETTE_FILE = REPO_ROOT / "assets" / "style" / "palette.json"

# 输出：installer 资源
OUT_DIR = REPO_ROOT / "build" / "installer"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 16 人格顺序：与 src/setup/persona-meta.ts PERSONAS 完全一致（4 族 × 4 字母）
PERSONAS = [
    # analyst（紫系）
    ("INTJ", "analyst"), ("INTP", "analyst"),
    ("ENTJ", "analyst"), ("ENTP", "analyst"),
    # diplomat（绿系）
    ("INFJ", "diplomat"), ("INFP", "diplomat"),
    ("ENFJ", "diplomat"), ("ENFP", "diplomat"),
    # sentinel（蓝系）
    ("ISTJ", "sentinel"), ("ISFJ", "sentinel"),
    ("ESTJ", "sentinel"), ("ESFJ", "sentinel"),
    # explorer（黄系）
    ("ISTP", "explorer"), ("ISFP", "explorer"),
    ("ESTP", "explorer"), ("ESFP", "explorer"),
]

# 安装器插画尺寸（DESIGN.md §6：164×314 NSIS 侧栏）
HEADER_W, HEADER_H = 164, 314


def load_palette() -> dict:
    """读取调色板，缺字段则 fallback 到 DESIGN.md §2 硬编码值。"""
    try:
        with PALETTE_FILE.open(encoding="utf-8") as fh:
            data = json.load(fh)
        return data
    except (OSError, json.JSONDecodeError):
        # fallback：硬编码 DESIGN.md 色板
        return {
            "ink": "#2B2320",
            "cream": "#FEF9EF",
            "paper": "#FFFFFF",
            "mute": "#8B8680",
            "families": {
                "analyst":  {"fg": "#785D87", "bg": "#f1ebf6"},
                "diplomat": {"fg": "#3E8F6E", "bg": "#e8f3ec"},
                "sentinel": {"fg": "#399FB9", "bg": "#e6eef7"},
                "explorer": {"fg": "#E4C728", "bg": "#fbf2dc"},
            },
        }


def hex_to_rgb(hex_str: str) -> tuple:
    """把 #RRGGBB 转 (R, G, B)；缺 # 前缀自动补。"""
    s = hex_str.strip()
    if s.startswith("#"):
        s = s[1:]
    if len(s) != 6:
        return (43, 35, 32)
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def make_pixel_canvas(w: int, h: int, bg: tuple) -> Image.Image:
    """新建 RGB 画布，填充奶油底色。"""
    return Image.new("RGB", (w, h), bg)


def paste_portrait(canvas: Image.Image, portrait: Image.Image, x: int, y: int, size: int) -> None:
    """把 portrait 等比缩放到 size×size，粘贴到 canvas (x, y)；保留像素感（NEAREST）。"""
    thumb = portrait.convert("RGB").resize((size, size), Image.NEAREST)
    canvas.paste(thumb, (x, y))


def render_header(palette: dict) -> Image.Image:
    """
    渲染安装器左侧插画（164×314）：
      - 顶部 4×32px 标题栏（奶油底 + 墨色 3px 边框 + Petibi 字样）
      - 中部 4×4 sprite 网格（每个 sprite 32×32，间距 4）
      - 底部留白 + "Petibi" 字样（用系统默认字体，无像素字体 fallback 即可）
    """
    ink = hex_to_rgb(palette.get("ink", "#2B2320"))
    cream = hex_to_rgb(palette.get("cream", "#FEF9EF"))
    paper = hex_to_rgb(palette.get("paper", "#FFFFFF"))
    families = palette.get("families", {})

    canvas = make_pixel_canvas(HEADER_W, HEADER_H, cream)
    draw = ImageDraw.Draw(canvas)

    # 顶部标题栏：高度 28
    draw.rectangle([0, 0, HEADER_W - 1, 27], fill=cream, outline=ink, width=2)
    # 像素 logo：8x8 grid + 4 种族色块（mini version）
    logo_x, logo_y = 8, 10
    color_set = [
        hex_to_rgb(families.get("analyst", {}).get("fg", "#785D87")),
        hex_to_rgb(families.get("diplomat", {}).get("fg", "#3E8F6E")),
        hex_to_rgb(families.get("sentinel", {}).get("fg", "#399FB9")),
        hex_to_rgb(families.get("explorer", {}).get("fg", "#E4C728")),
    ]
    for i in range(4):
        draw.rectangle([logo_x + i * 3, logo_y, logo_x + i * 3 + 2, logo_y + 2],
                       fill=color_set[i])
    # 标题文字：用 PIL 默认字体，PETIBI 字号 12
    try:
        font_title = ImageFont.truetype("arial.ttf", 11)
    except OSError:
        font_title = ImageFont.load_default()
    draw.text((24, 8), "PETIBI", fill=ink, font=font_title)

    # 4×4 sprite 网格：每格 32×32，间距 4，行间距 6
    grid_top = 36
    cell_w = 32
    cell_h = 36  # 32 sprite + 4 间隔
    grid_x_start = (HEADER_W - cell_w * 4 - 4 * 3) // 2  # 居中

    for idx, (type_, family) in enumerate(PERSONAS):
        col = idx % 4
        row = idx // 4
        x = grid_x_start + col * (cell_w + 4)
        y = grid_top + row * cell_h

        # 卡片底色：族色 bg（DESIGN.md §2）
        family_bg_hex = families.get(family, {}).get("bg", "#f1ebf6")
        family_bg = hex_to_rgb(family_bg_hex)
        draw.rectangle([x, y, x + cell_w - 1, y + cell_w - 1],
                       fill=family_bg, outline=ink, width=1)

        # 贴 sprite：缩放到 28×28 居中在 32×32 卡片里
        portrait_path = PORTRAITS_DIR / f"{type_.lower()}.png"
        if portrait_path.exists():
            try:
                paste_portrait(canvas, Image.open(portrait_path),
                               x + 2, y + 2, cell_w - 4)
            except Exception as err:
                # 个别文件读不动就跳到 fallback
                print(f"warn: portrait {type_} 读取失败：{err}", file=sys.stderr)
                draw.text((x + 8, y + 10), type_, fill=ink, font=font_title)
        else:
            # fallback：用文字占位
            draw.text((x + 6, y + 10), type_, fill=ink, font=font_title)

    # 底部品牌字样
    try:
        font_brand = ImageFont.truetype("arial.ttf", 13)
    except OSError:
        font_brand = ImageFont.load_default()
    draw.text((24, HEADER_H - 22), "16 人格全家福", fill=ink, font=font_brand)

    # 整体加一圈 3px 墨色边框（DESIGN.md §5）
    draw.rectangle([1, 1, HEADER_W - 2, HEADER_H - 2], outline=ink, width=2)
    return canvas


def render_icon(palette: dict) -> Image.Image:
    """
    渲染 256×256 应用图标（ICO 多分辨率源）：
      - 奶油底 + 4 色 4×4 像素方块 + "P" 字母
      - 用 PIL 缩放到 16/32/48/64/128/256 写进 ICO
    """
    ink = hex_to_rgb(palette.get("ink", "#2B2320"))
    cream = hex_to_rgb(palette.get("cream", "#FEF9EF"))
    families = palette.get("families", {})

    canvas = make_pixel_canvas(256, 256, cream)
    draw = ImageDraw.Draw(canvas)

    # 整体 3px 墨色边框
    draw.rectangle([2, 2, 253, 253], outline=ink, width=4)

    # 8×8 像素 logo（中心对齐）：4 族色块
    grid_top = 64
    cell_size = 16
    grid_x_start = (256 - cell_size * 8) // 2
    color_set = [
        hex_to_rgb(families.get("analyst", {}).get("fg", "#785D87")),
        hex_to_rgb(families.get("diplomat", {}).get("fg", "#3E8F6E")),
        hex_to_rgb(families.get("sentinel", {}).get("fg", "#399FB9")),
        hex_to_rgb(families.get("explorer", {}).get("fg", "#E4C728")),
    ]
    # 第 1/3 行：紫绿，第 2/4 行：蓝黄
    pattern = [0, 1, 0, 1, 0, 1, 0, 1,
               2, 3, 2, 3, 2, 3, 2, 3,
               0, 1, 0, 1, 0, 1, 0, 1,
               2, 3, 2, 3, 2, 3, 2, 3]
    for idx, color_idx in enumerate(pattern):
        col = idx % 8
        row = idx // 8
        x = grid_x_start + col * cell_size
        y = grid_top + row * cell_size
        # 用 border 隔开
        draw.rectangle([x + 1, y + 1, x + cell_size - 2, y + cell_size - 2],
                       fill=color_set[color_idx])

    # 底部 P 字样
    try:
        font_p = ImageFont.truetype("arialbd.ttf", 28)
    except OSError:
        try:
            font_p = ImageFont.truetype("arial.ttf", 28)
        except OSError:
            font_p = ImageFont.load_default()
    draw.text((110, 208), "PETIBI", fill=ink, font=font_p)
    return canvas


def write_ico(base: Image.Image, ico_path: Path) -> None:
    """把 256×256 源图标写到多分辨率 .ico（Pillow 自动写入 16/32/48/64/128/256）。"""
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(ico_path, format="ICO", sizes=sizes)


def main() -> int:
    palette = load_palette()
    print(f"调色板已读取（ink={palette.get('ink', '?')}）")

    # 1) 安装器插画
    header_img = render_header(palette)
    header_png = OUT_DIR / "installer-header.png"
    header_bmp = OUT_DIR / "installer-header.bmp"
    header_img.save(header_png)
    header_img.save(header_bmp, format="BMP")
    print(f"安装器插画已生成：{header_png} ({header_img.size}) + .bmp")

    # 2) 应用图标（多分辨率 ICO）
    icon_img = render_icon(palette)
    icon_ico = OUT_DIR / "icon.ico"
    write_ico(icon_img, icon_ico)
    print(f"应用图标已生成：{icon_ico} ({icon_img.size})")

    # 3) 同时输出一份小尺寸 PNG 作为兜底（如果 electron-builder 取不到 .ico）
    icon_png = OUT_DIR / "icon.png"
    icon_img.save(icon_png)
    print(f"应用图标 PNG 兜底：{icon_png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())