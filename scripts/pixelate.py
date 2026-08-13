# -*- coding: utf-8 -*-
"""
pixelate.py — 即梦概念稿 → 合规像素 sprite 转换脚本（PRD §8.3 美术管线第 2 步）

功能流程：
  1. 读入任意尺寸 / 任意色彩模式的图片（PNG / JPG 等）
  2. 背景处理（二选一，自动判断）：
     - 图片带 alpha 通道：把 alpha 阈值化为 1-bit（>= 阈值 → 255 全不透明，否则 → 0 全透明）
     - 图片无 alpha 通道：取四角像素均值作为背景色，与之相近（容差可调）的区域置为透明
  3. 按非透明内容包围盒裁剪，等比缩放后居中放入目标画布（默认 32×32，四周留 2px 边距）
  4. 每个不透明像素量化到 assets/style/palette.json 中距离最近的颜色
     （色板 v3「一族一色」：4 族 × {main, shadow, light, highlight} + neutrals 8 色
      + 统一描边色 outline；personalities 已无 main 字段，只记录族归属）
  5. 输出 RGBA PNG，alpha 严格只有 0 / 255 两种值（红线 R2 / PRD §8.4 硬规范：
     半透明像素会在深色壁纸上产生白边，属原理性缺陷，必须根治）

用法：
  python scripts/pixelate.py input.png -o output.png [--size 32] [--alpha-threshold 128] [--bg-tolerance 30]

依赖：仅 Pillow。
"""

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image

# 仓库根目录 = 本文件所在 scripts/ 的上一级；用它定位色板，保证任意工作目录下都能跑
REPO_ROOT = Path(__file__).resolve().parent.parent

# 默认色板路径（PRD §8.4：全系列共用一块 16 色限定色板）
DEFAULT_PALETTE = REPO_ROOT / "assets" / "style" / "palette.json"

# 默认输出画布尺寸（设计方向变更后 PRD §8.4 定为 32×32，显示 ×4 = 128px；
# 旧的 48×48 规范作废，但可通过 --size 48 兼容旧资产）
DEFAULT_CANVAS_SIZE = 32

# 画布四周留白边距（工单要求留 2px 边距，即内容区最大 44×44）
MARGIN = 2


def load_palette(palette_path):
    """读取色板 JSON，返回去重后的 (R, G, B) 元组列表。

    色板文件结构（色板 v3「一族一色」，见 assets/style/palette.json）：
      - "//" 开头的注释键：跳过
      - families：{族名: {"main": "#RRGGBB", "shadow": ..., "light": ..., "highlight": ...}}，
        每族 4 色嵌套 dict（同族 4 人格服装主色统一为 main）
      - personalities：{人格: {"animal": ..., "family": ...}}，v3 已无 main 颜色字段
      - neutrals：{名称: "#RRGGBB"}，动物头毛色/肤色
      - outline："#RRGGBB"，统一描边色
    解析方式：递归遍历所有值（dict / list 均下钻），收集一切 "#RRGGBB" 形式的字符串
    （族四色、中性色、描边色全部纳入量化目标），最后按出现顺序去重。
    """
    with open(palette_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    hex_colors = []

    def walk(value):
        """递归收集 #RRGGBB 形式的颜色字符串。"""
        if isinstance(value, str):
            h = value.lstrip("#")
            if value.startswith("#") and len(h) == 6:
                try:
                    int(h, 16)
                except ValueError:
                    return
                hex_colors.append(value)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    for key, value in data.items():
        # 跳过注释键（如 "//"、"//personalities"）
        if key.startswith("//"):
            continue
        walk(value)

    # 按出现顺序去重后转成 (R, G, B) 整数元组
    rgb_colors = []
    seen = set()
    for hex_color in hex_colors:
        h = hex_color.lstrip("#")
        rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
        if rgb not in seen:
            seen.add(rgb)
            rgb_colors.append(rgb)
    return rgb_colors


def has_alpha_channel(img):
    """判断原始图片是否带有真正的透明信息。

    - RGBA / LA：自带 alpha 通道
    - P（调色板模式）：透明信息存在 info["transparency"] 里
    - RGB / L 等：无透明信息（如 JPG 读出来一定是 RGB）
    """
    if img.mode in ("RGBA", "LA"):
        return True
    if img.mode == "P" and "transparency" in img.info:
        return True
    return False


def threshold_alpha(img, threshold):
    """把 RGBA 图像的 alpha 通道阈值化为 1-bit：>= threshold → 255，否则 → 0。

    这一步是"根治白边"的关键：即梦出图的抗锯齿边缘是半透明像素，
    直接阈值化后边缘要么全留要么全去，不会再有半透明白雾。
    透明像素的 RGB 同时清零，避免残留颜色干扰后续量化与显示。
    """
    pixels = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = pixels[x, y]
            if a >= threshold:
                # 保留颜色，alpha 拉满为全不透明
                pixels[x, y] = (r, g, b, 255)
            else:
                # 整像素丢弃：颜色清零 + 全透明
                pixels[x, y] = (0, 0, 0, 0)
    return img


def remove_bg_by_corners(img, tolerance):
    """无 alpha 通道时的背景去除：以四角像素均值为背景色，相近区域置透明。

    适用于白底 / 纯色底概念图（如即梦默认白底 JPG）。
    距离用 RGB 欧氏距离，<= tolerance 判定为背景。
    """
    pixels = img.load()
    w, h = img.size

    # 取四角像素颜色求均值作为背景色估计
    corners = [
        pixels[0, 0],
        pixels[w - 1, 0],
        pixels[0, h - 1],
        pixels[w - 1, h - 1],
    ]
    bg_r = sum(c[0] for c in corners) // 4
    bg_g = sum(c[1] for c in corners) // 4
    bg_b = sum(c[2] for c in corners) // 4

    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            # 当前像素与背景色的欧氏距离
            dist = math.sqrt((r - bg_r) ** 2 + (g - bg_g) ** 2 + (b - bg_b) ** 2)
            if dist <= tolerance:
                # 判定为背景：颜色清零 + 全透明
                pixels[x, y] = (0, 0, 0, 0)
            else:
                # 判定为内容：alpha 拉满为全不透明
                pixels[x, y] = (r, g, b, 255)
    return img


def crop_to_content(img):
    """按非透明内容包围盒裁剪；完全没有内容时返回 None。"""
    # getbbox() 返回非零区域的包围盒；全透明图所有通道都为 0，返回 None
    bbox = img.getbbox()
    if bbox is None:
        return None
    return img.crop(bbox)


def resize_into_canvas(content, canvas_size):
    """把内容图等比缩放到内容区（(size-2*2) × (size-2*2)）内，居中放入 size×size 透明画布。

    缩放用最近邻（NEAREST），保持像素风的硬边缘，不产生插值杂色。
    小于内容区的图也会等比放大填满，保证输出规格统一。
    """
    box = canvas_size - MARGIN * 2  # 内容区边长（32 画布时为 28）
    w, h = content.size

    # 等比缩放比例：以内容区能完整容纳为准
    scale = min(box / w, box / h)
    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))
    resized = content.resize((new_w, new_h), Image.NEAREST)

    # 新建全透明画布，把缩放后的内容居中贴入
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    offset_x = (canvas_size - new_w) // 2
    offset_y = (canvas_size - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized)
    return canvas


def quantize_to_palette(img, palette):
    """把每个不透明像素映射到色板中欧氏距离最近的颜色；透明像素保持不变。"""
    pixels = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                # 透明像素无需量化
                continue
            # 在 16 色中找欧氏距离最近的颜色
            best = min(palette, key=lambda c: (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2)
            pixels[x, y] = (best[0], best[1], best[2], 255)
    return img


def pixelate(input_path, output_path, alpha_threshold=128, bg_tolerance=30,
             palette_path=DEFAULT_PALETTE, canvas_size=DEFAULT_CANVAS_SIZE,
             no_resize=False):
    """完整转换流程：读图 → 背景处理 → 裁剪 → 缩放入画布 → 色板量化 → 存 PNG。

    no_resize=True 时（M1 形象图 v4 大画布模式）：跳过"裁剪内容 + 缩放居中入画布"，
    保留原图画布尺寸与构图，只做背景处理 + 色板量化（工单 v4 第 3 步：
    可复用 pixelate.py 思路但不缩放，只把颜色映射到色板）。
    """
    img = Image.open(input_path)

    # 记录原图是否有透明信息，再统一转成 RGBA 处理
    had_alpha = has_alpha_channel(img)
    img = img.convert("RGBA")

    # 第 2 步：背景处理，两条路线都保证结束后 alpha 只有 0 / 255
    if had_alpha:
        img = threshold_alpha(img, alpha_threshold)
    else:
        img = remove_bg_by_corners(img, bg_tolerance)

    if no_resize:
        # 大画布模式：不动尺寸与构图，直接以原图作为画布
        canvas = img
    else:
        # 第 3 步：裁剪内容并缩放入目标画布；全透明图直接输出空画布
        content = crop_to_content(img)
        if content is None:
            canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
            print(f"警告：{input_path} 背景处理后无可见内容，输出全透明画布")
        else:
            canvas = resize_into_canvas(content, canvas_size)

    # 第 4 步：量化到限定色板（族四色 + neutrals + 描边色，见 load_palette）
    palette = load_palette(palette_path)
    canvas = quantize_to_palette(canvas, palette)

    # 第 5 步：输出 PNG（RGBA，alpha 只含 0/255）
    canvas.save(output_path, "PNG")
    w, h = canvas.size
    print(f"已输出：{output_path}（{w}x{h}，限定色板，1-bit alpha）")


def main(argv=None):
    """命令行入口：解析参数并调用 pixelate()。"""
    parser = argparse.ArgumentParser(description="即梦概念稿 → 合规像素 sprite（默认 32x32 / 限定色板 / 1-bit alpha）")
    parser.add_argument("input", help="输入图片路径（PNG/JPG 等）")
    parser.add_argument("-o", "--output", required=True, help="输出 PNG 路径")
    parser.add_argument("--size", type=int, default=DEFAULT_CANVAS_SIZE,
                        help=f"输出画布边长（默认 {DEFAULT_CANVAS_SIZE}，旧规范 48 可用 --size 48）")
    parser.add_argument("--alpha-threshold", type=int, default=128,
                        help="有 alpha 通道时的 1-bit 化阈值（默认 128）")
    parser.add_argument("--bg-tolerance", type=int, default=30,
                        help="无 alpha 通道时的背景色容差（默认 30）")
    parser.add_argument("--palette", default=str(DEFAULT_PALETTE),
                        help="色板 JSON 路径（默认 assets/style/palette.json）")
    parser.add_argument("--no-resize", action="store_true",
                        help="不裁剪不缩放，保留原图画布与构图，只做背景处理 + 色板量化（M1 形象图 v4 大画布模式）")
    args = parser.parse_args(argv)

    pixelate(args.input, args.output, args.alpha_threshold, args.bg_tolerance,
             args.palette, args.size, args.no_resize)
    return 0


if __name__ == "__main__":
    sys.exit(main())
