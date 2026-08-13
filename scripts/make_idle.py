# -*- coding: utf-8 -*-
"""
make_idle.py — 由 32×32 定稿 sprite 生成 idle 呼吸双帧（M1 工单 v2 第 3 步）

规则（对齐 assets/style/character-design.md §0）：
  - 帧 0（idle_0.png）：原样输出定稿图
  - 帧 1（idle_1.png）：头不动、脚不动，躯干 + 手臂整体下移 1px，腿从顶端压缩短 1px
  - 两帧包围盒完全一致（底部脚的位置不变，顶部头不变）

分段方式（按内容包围盒的比例切，适配 AI 生成稿的实际几何）：
  头部 = 包围盒顶部 45% 行；腿 = 包围盒底部 22% 行；其余为躯干带。
  躯干带下移 1px（向上多借 1 行避免头身之间开出透明缝），
  腿部丢掉最顶 1 行、脚保持原位——腿即从顶端缩短 1px。

用法：
  python scripts/make_idle.py 定稿.png 输出目录     # 生成 idle_0.png / idle_1.png

依赖：仅 Pillow。
"""

import sys
from pathlib import Path

from PIL import Image

# 头部 / 腿部在内容包围盒中的行比例（2.5 头身 Q 版的经验切分）
HEAD_RATIO = 0.45
LEG_RATIO = 0.22


def make_idle_frames(src_path, out_dir):
    """读入定稿 sprite，输出 idle_0.png（原样）与 idle_1.png（呼吸帧）。"""
    img = Image.open(src_path).convert("RGBA")
    bbox = img.getbbox()
    if bbox is None:
        raise RuntimeError(f"{src_path} 没有可见内容")
    x0, y0, x1, y1 = bbox
    h = y1 - y0

    # 行分界：头部 [y0, head_end)，躯干 [head_end, leg_start)，腿 [leg_start, y1)
    head_end = y0 + round(h * HEAD_RATIO)
    leg_start = y1 - round(h * LEG_RATIO)

    frame1 = img.copy()
    # 清空躯干 + 腿区域，稍后用移位后的内容回填
    for y in range(head_end, y1):
        for x in range(x0, x1):
            frame1.putpixel((x, y), (0, 0, 0, 0))

    # 躯干带下移 1px：源取 [head_end-1, leg_start)，多借头底 1 行保证与头部衔接不断裂
    torso = img.crop((x0, head_end - 1, x1, leg_start))
    frame1.paste(torso, (x0, head_end), torso)

    # 腿丢顶行：源取 [leg_start+1, y1)，贴回原位 [leg_start+1, y1)——脚不动、腿短 1px
    legs = img.crop((x0, leg_start + 1, x1, y1))
    frame1.paste(legs, (x0, leg_start + 1), legs)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    img.save(out_dir / "idle_0.png", "PNG")
    frame1.save(out_dir / "idle_1.png", "PNG")
    print(f"已输出 {out_dir}/idle_0.png, idle_1.png（包围盒 {bbox}，头/{head_end} 腿/{leg_start}）")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法：python scripts/make_idle.py 定稿.png 输出目录")
        sys.exit(1)
    make_idle_frames(sys.argv[1], sys.argv[2])
