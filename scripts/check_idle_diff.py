#!/usr/bin/env python3
# 【文件说明】桌宠 idle 两帧像素差异分析（M4-P0 修复 P1-001）：
#   - 对比 resources/sprites/<type>/idle_0.png 与 idle_1.png；
#   - 找出差异像素的包围盒（bbox），判断是否仅躯干 1px 位移（视觉上像抽搐）；
#   - 给出修复建议（重新对齐 idle 帧，让呼吸幅度收敛、身体对齐）。
#
# 使用方式：python scripts/check_idle_diff.py [type]    默认 intj
# 输出：
#   - 两帧尺寸、模式、alpha 通道；
#   - 差异像素总数 + 包围盒；
#   - 差异像素按行分布（找出"上半脸/下半脸+身体"分界）；
#   - 修复建议（动画错位可能性 + 建议收敛范围）。

import sys
from pathlib import Path

from PIL import Image, ImageChops


def analyze(type_: str = 'intj') -> int:
    """分析指定人格的 idle 两帧；返回非零退出码表示有问题。"""
    sprite_dir = Path(__file__).resolve().parent.parent / 'resources' / 'sprites' / type_
    f0_path = sprite_dir / 'idle_0.png'
    f1_path = sprite_dir / 'idle_1.png'
    if not f0_path.exists() or not f1_path.exists():
        print(f'[check_idle_diff] 缺少 sprite 文件：{f0_path} 或 {f1_path}')
        return 1

    img0 = Image.open(f0_path).convert('RGBA')
    img1 = Image.open(f1_path).convert('RGBA')
    w0, h0 = img0.size
    w1, h1 = img1.size
    print(f'[check_idle_diff] {type_} idle_0 = {w0}x{h0}, idle_1 = {w1}x{h1}')
    if (w0, h0) != (w1, h1):
        print(f'[check_idle_diff] ⚠️  两帧尺寸不一致 — 抖动源之一（重新生成时务必对齐画布）')
        return 2

    # 逐像素差异
    diff = ImageChops.difference(img0, img1)
    bbox = diff.getbbox()
    if not bbox:
        print(f'[check_idle_diff] {type_} 两帧完全一致（无差异像素）')
        return 0

    # 把差异像素位置枚举出来
    px0 = img0.load()
    px1 = img1.load()
    px_diff = diff.load()
    diff_positions: list[tuple[int, int, tuple, tuple]] = []
    for y in range(h0):
        for x in range(w0):
            r, g, b, a = px_diff[x, y]
            if a > 0 or r > 0 or g > 0 or b > 0:
                diff_positions.append((x, y, px0[x, y], px1[x, y]))
    n_diff = len(diff_positions)
    print(f'[check_idle_diff] {type_} 差异像素总数 = {n_diff} ({n_diff / (w0 * h0) * 100:.1f}% 像素变化)')
    print(f'[check_idle_diff] 包围盒 = {bbox} (left={bbox[0]}, top={bbox[1]}, right={bbox[2]}, bottom={bbox[3]})')

    # 行分布：差异像素按 y 分组，看差异是不是集中在身体下半部分
    by_y: dict[int, int] = {}
    for x, y, _, _ in diff_positions:
        by_y[y] = by_y.get(y, 0) + 1
    y_min = min(by_y.keys())
    y_max = max(by_y.keys())
    print(f'[check_idle_diff] 差异行范围 y=[{y_min},{y_max}]，占总行 {y_max - y_min + 1}/{h0}')

    # 计算"上半区 vs 下半区"差异像素比例（按 0.5h 切分）
    half = h0 // 2
    upper = sum(v for y, v in by_y.items() if y < half)
    lower = sum(v for y, v in by_y.items() if y >= half)
    print(f'[check_idle_diff] 上半区差异像素 = {upper}, 下半区差异像素 = {lower}')
    if upper > 0 and lower > 0:
        ratio = upper / max(1, lower)
        print(f'[check_idle_diff] 上/下比例 = {ratio:.2f}（>0.3 表示上半脸也在动）')

    # 推断问题：
    # 1. 包围盒左右相等（bbox[2]-bbox[0] == w0）：整行像素都在变 → sprite 整张图被画在不同位置；
    #    病因：上一帧与下一帧的水平基线不同（呼吸幅度 > 1px）。
    # 2. 差异只在下半部分（y >= half）：下半身在抽动（典型呼吸动画 bug）；
    #    病因：身体躯干或脚部 sprite 没对齐锚点。
    full_width = bbox[2] - bbox[0] == w0 - 1
    if full_width:
        print('[check_idle_diff] 推断：差异跨越整张图宽度 → sprite 在 y 轴被整体平移（典型"呼吸幅度 > 1px"）')
    if lower > upper and upper < max(1, n_diff // 5):
        print('[check_idle_diff] 推断：差异集中在下半身 → 身体呼吸幅度未收敛（建议将呼吸幅度限制在 1px 以内）')

    # 输出修复建议
    print()
    print('=== 修复建议（M5 动画迭代）===')
    print('1. 让 idle 帧的"基准点"（脚底/地面线 y 坐标）严格一致；')
    print('   重新导出时把整张 sprite 贴到画布底部，y 坐标 0..31 → 1..32 之类，')
    print('   不要让身体在两帧之间整体上浮或下沉超过 1px。')
    print('2. 呼吸幅度收敛到 1px 以内：当前帧多 1px → 下一帧少 1px 而不是反过来。')
    print('3. 头部不要相对身体移动：上半脸（含眼睛/表情）必须严格静止，')
    print('   只允许眼睛眨（blink）/ 嘴形（happy）等局部动画。')
    print('4. 若使用了 make_characters.py 自动生成，检查其 y_offset 是否随帧变化；')
    print('   锚点应固定在脚本里，不要随 PRNG 抖动。')
    return 0


if __name__ == '__main__':
    t = sys.argv[1] if len(sys.argv) > 1 else 'intj'
    raise SystemExit(analyze(t))