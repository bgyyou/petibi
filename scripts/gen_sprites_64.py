# -*- coding: utf-8 -*-
"""
gen_sprites_64.py — 由 512×512 形象图生成 64×64 全套 sprite 帧（T4+T5 一次性施工）

输出（resources/sprites/<type>/）：
  - base.png           64×64 基准帧（pixelate 衍生，1-bit alpha + 色板内）
  - idle_0.png         与 base 完全一致（呼吸基准帧）
  - idle_1.png         头/脚像素零差异、躯干带下移 1px（Shimeji 规范呼吸帧）
  - blink_0.png        闭眼帧（眼睛行像素替换为描边色）
  - blink_1.png        与 blink_0 一致（闭眼持续）
  - thinking_0.png     与 idle_0 一致（思考时复用 idle，晃动由 IPC 通知上层处理）
  - thinking_1.png     与 idle_1 一致

规则依据：
  - PRD §8.4 全系列共用色板 + 1-bit alpha
  - ISSUES P1-001 修复：idle 两帧"头部零差异 + 躯干 1px 下移"
  - ISSUES P1-004：64×64 画布 + 显示 ×2 = 128px（窗口不变）

依赖：仅 Pillow；复用 scripts/pixelate.py 的核心转换函数。
"""

import json
import sys
from pathlib import Path

from PIL import Image

# 复用 pixelate 的实现，避免重复逻辑
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pixelate import (  # noqa: E402
    DEFAULT_PALETTE,
    crop_to_content,
    load_palette,
    quantize_to_palette,
    remove_bg_by_corners,
    resize_into_canvas,
    threshold_alpha,
    has_alpha_channel,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
PORTRAITS_DIR = REPO_ROOT / "assets" / "art" / "portraits"
SPRITES_DIR = REPO_ROOT / "resources" / "sprites"

# 输出画布尺寸（PRD §8.4 升级 64×64 = 显示 128px 的一半）
CANVAS_SIZE = 64
# pixelate 的 MARGIN=2 写死，里面画布内缩 2px 边距
INNER = CANVAS_SIZE - 4  # 60

# 头/腿在内容包围盒中的行比例（沿用 make_idle.py 的 2.5 头身经验切分）
HEAD_RATIO = 0.45
LEG_RATIO = 0.22

# 16 人格清单
TYPES = [
    "intj", "intp", "entj", "entp",
    "infj", "infp", "enfj", "enfp",
    "istj", "isfj", "estj", "esfj",
    "istp", "isfp", "estp", "esfp",
]


def pixelate_64(input_path):
    """复刻 pixelate() 主流程但固定画布为 64×64，返回 RGBA Image。"""
    img = Image.open(input_path)
    had_alpha = has_alpha_channel(img)
    img = img.convert("RGBA")

    if had_alpha:
        img = threshold_alpha(img, 128)
    else:
        img = remove_bg_by_corners(img, 30)

    content = crop_to_content(img)
    if content is None:
        canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    else:
        canvas = resize_into_canvas(content, CANVAS_SIZE)

    palette = load_palette(DEFAULT_PALETTE)
    canvas = quantize_to_palette(canvas, palette)
    return canvas


def make_idle_1(base):
    """从 base 生成呼吸帧：头部像素 0 差异、躯干下移 1px、腿丢顶 1 行（脚不动）。
    实现与 make_idle.py 同源：head/leg_end 边界由 HEAD_RATIO/LEG_RATIO 比例切分。
    """
    img = base.copy()
    bbox = img.getbbox()
    if bbox is None:
        return img
    x0, y0, x1, y1 = bbox
    h = y1 - y0
    head_end = y0 + round(h * HEAD_RATIO)
    leg_start = y1 - round(h * LEG_RATIO)

    # 清空躯干 + 腿区域，稍后用移位后的内容回填
    for y in range(head_end, y1):
        for x in range(x0, x1):
            img.putpixel((x, y), (0, 0, 0, 0))

    # 躯干下移 1px：源取 [head_end-1, leg_start)，多借头底 1 行保证与头部衔接不断裂
    torso = base.crop((x0, head_end - 1, x1, leg_start))
    img.paste(torso, (x0, head_end), torso)

    # 腿丢顶行：源取 [leg_start+1, y1)，贴回原位 [leg_start+1, y1)——脚不动、腿短 1px
    legs = base.crop((x0, leg_start + 1, x1, y1))
    img.paste(legs, (x0, leg_start + 1), legs)
    return img


def load_outline_rgb():
    """读色板中的描边色，返回 (r, g, b) 整数元组。"""
    data = json.loads(DEFAULT_PALETTE.read_text(encoding="utf-8"))
    h = data["outline"].lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def find_eye_rows(base, outline_rgb):
    """自动定位眼睛行：在头部区域内寻找"暗像素密集且与亮像素交替"的行（典型眼睛行）。
    返回疑似眼睛行的 y 坐标列表。
    """
    bbox = base.getbbox()
    if bbox is None:
        return []
    x0, y0, x1, y1 = bbox
    head_end = y0 + round((y1 - y0) * HEAD_RATIO)

    candidates = []
    for y in range(y0, head_end):
        row = [base.getpixel((x, y)) for x in range(x0, x1)]
        # 眼睛像素 = 颜色接近 outline 或全黑的离散像素；
        # 统计"暗像素与亮像素交替"的数量（眼周白底）。
        dark = 0
        for px in row:
            if px[3] == 0:
                continue
            r, g, b, _ = px
            dr = abs(r - outline_rgb[0]) + abs(g - outline_rgb[1]) + abs(b - outline_rgb[2])
            if dr < 60:  # 接近描边色
                dark += 1
        # 同时要求该行有白底（动物脸通常偏亮）
        light = sum(1 for px in row if px[3] > 0 and px[0] > 180 and px[1] > 180 and px[2] > 180)
        if dark >= 2 and light >= 4:
            candidates.append((y, dark, light))

    # 取 dark 数量前 2 高的行（眼睛通常占 1-2 行）
    candidates.sort(key=lambda t: (-t[1], t[2]))
    return [y for y, _, _ in candidates[:2]]


def make_blink(base, outline_rgb):
    """闭眼帧：在眼睛行上把所有不透明像素替换为描边色（绘一道横线 = 闭眼）。"""
    img = base.copy()
    eye_rows = find_eye_rows(base, outline_rgb)
    if not eye_rows:
        # 检测失败时退回 base（保守兜底，不让闭眼帧缺失）
        return img
    for y in eye_rows:
        bbox = img.getbbox()
        if bbox is None:
            continue
        x0, _, x1, _ = bbox
        for x in range(x0, x1):
            px = img.getpixel((x, y))
            if px[3] > 0:
                img.putpixel((x, y), (outline_rgb[0], outline_rgb[1], outline_rgb[2], 255))
    return img


def process_type(type_, outline_rgb):
    """处理单个人格：生成 64×64 全套帧并写入目录。"""
    portrait_path = PORTRAITS_DIR / f"{type_}.png"
    if not portrait_path.exists():
        print(f"  [跳过] {portrait_path} 不存在")
        return False

    out_dir = SPRITES_DIR / type_
    out_dir.mkdir(parents=True, exist_ok=True)

    base = pixelate_64(portrait_path)
    base.save(out_dir / "base.png", "PNG")

    idle_0 = base.copy()  # 呼吸基准帧 = base 原样
    idle_1 = make_idle_1(base)  # 躯干下移 1px

    blink = make_blink(base, outline_rgb)

    idle_0.save(out_dir / "idle_0.png", "PNG")
    idle_1.save(out_dir / "idle_1.png", "PNG")
    blink.save(out_dir / "blink_0.png", "PNG")
    blink.save(out_dir / "blink_1.png", "PNG")
    # thinking 直接复用 idle（任务允许"可选 1px 轻摇"，这里保持帧内容一致，
    # 真正的"thinking"视觉差异交给动画节奏/UI 指示器，避免 sprite 边缘锯齿）
    idle_0.save(out_dir / "thinking_0.png", "PNG")
    idle_1.save(out_dir / "thinking_1.png", "PNG")
    return True


def main():
    """主入口：遍历 16 人格，逐个生成全套 64×64 sprite 帧。"""
    outline_rgb = load_outline_rgb()
    print(f"描边色 = {outline_rgb}")
    n_ok = 0
    for t in TYPES:
        print(f"== {t} ==")
        if process_type(t, outline_rgb):
            n_ok += 1
    print(f"\n完成：{n_ok}/{len(TYPES)} 个人格 sprite 已生成到 resources/sprites/")
    return 0 if n_ok == len(TYPES) else 1


if __name__ == "__main__":
    sys.exit(main())
