# -*- coding: utf-8 -*-
"""
test_art_tools.py — 美术工具脚本（pixelate.py / check_alpha.py）自动化测试

用 PIL 程序生成四类边界测试图（不用现成图片，保证可复现）：
  1. semi_edge.png    —— 带半透明边的 RGBA PNG（验证 check_alpha 能抓出半透明）
  2. white_bg.jpg     —— 白底 JPG（无 alpha，验证四角容差去背景）
  3. transparent.png  —— 纯透明 PNG（验证不崩溃、输出全透明画布）
  4. small.png        —— 小于 48px 的图（验证等比放大到 48×48 画布）

验证点：
  - check_alpha：含半透明的目录退出码为 1 且抓出数量 > 0；干净目录退出码为 0
  - pixelate：输出为 48×48 RGBA；alpha 严格只有 0/255（红线 R2）；
    所有不透明像素颜色严格落在 assets/style/palette.json 的 16 色内

运行：
  python scripts/tests/test_art_tools.py
依赖：仅 Pillow（与脚本本身一致）。
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

# 仓库根目录 = 本文件上两级（scripts/tests/ → scripts/ → 仓库根）
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PIXELATE = REPO_ROOT / "scripts" / "pixelate.py"
CHECK_ALPHA = REPO_ROOT / "scripts" / "check_alpha.py"
PALETTE_PATH = REPO_ROOT / "assets" / "style" / "palette.json"


def load_palette_colors():
    """读取限定色板，返回 (R, G, B) 集合，用于校验 pixelate 输出。

    色板结构含 families（16 族色）、personalities（人格主色）、outline（描边色），
    与 pixelate.load_palette 同口径：递归收集全部 #RRGGBB 字符串。
    """
    with open(PALETTE_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    hex_colors = []

    def walk(value):
        """递归收集 #RRGGBB 形式的颜色字符串（跳过注释键由调用处保证）。"""
        if isinstance(value, str) and value.startswith("#") and len(value) == 7:
            hex_colors.append(value)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    for key, value in data.items():
        if key.startswith("//"):  # 跳过注释键
            continue
        walk(value)

    colors = set()
    for h in hex_colors:
        h = h.lstrip("#")
        colors.add((int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)))
    return colors


def make_test_images(tmp):
    """在临时目录里生成四类测试图，返回 {名字: 路径} 字典。"""
    paths = {}

    # 1. 带半透明边的 PNG：中心实心不透明圆，外围一圈 alpha=128 的过渡环（模拟抗锯齿边缘）
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    px = img.load()
    for y in range(64):
        for x in range(64):
            dx, dy = x - 32, y - 32
            dist = (dx * dx + dy * dy) ** 0.5
            if dist <= 20:
                px[x, y] = (200, 100, 60, 255)   # 实心主体
            elif dist <= 24:
                px[x, y] = (200, 100, 60, 128)   # 半透明过渡环（check_alpha 要抓的就是它）
    paths["semi_edge"] = tmp / "semi_edge.png"
    img.save(paths["semi_edge"])

    # 2. 白底 JPG：纯白背景 + 中央色块（JPG 无 alpha，走四角容差去背景路线）
    img = Image.new("RGB", (96, 80), (255, 255, 255))
    px = img.load()
    for y in range(30, 50):
        for x in range(38, 58):
            px[x, y] = (90, 60, 140)
    paths["white_bg"] = tmp / "white_bg.jpg"
    img.save(paths["white_bg"], "JPEG", quality=95)

    # 3. 纯透明 PNG：所有像素 alpha = 0
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    paths["transparent"] = tmp / "transparent.png"
    img.save(paths["transparent"])

    # 4. 小于 48px 的图：16×12 的实心不透明色块（无半透明，是"干净"样本）
    img = Image.new("RGBA", (16, 12), (0, 0, 0, 0))
    px = img.load()
    for y in range(2, 10):
        for x in range(2, 14):
            px[x, y] = (60, 130, 90, 255)
    paths["small"] = tmp / "small.png"
    img.save(paths["small"])

    return paths


def run(script, *args):
    """以子进程运行脚本，返回 (退出码, 标准输出)。

    Windows 控制台默认 GBK，脚本里的中文输出按 GBK 编码会解码失败，
    因此给子进程设置 PYTHONUTF8=1 强制 UTF-8 输出，并以 errors="replace" 兜底。
    """
    env = dict(os.environ, PYTHONUTF8="1")
    result = subprocess.run(
        [sys.executable, str(script), *[str(a) for a in args]],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )
    return result.returncode, result.stdout + result.stderr


def assert_true(cond, msg):
    """简易断言：不满足就抛异常，附带说明。"""
    if not cond:
        raise AssertionError(msg)


def iter_rgba(img):
    """逐像素产出 (R, G, B, A)，用 tobytes() 避开 Pillow 新版对 getdata() 的弃用警告。"""
    data = img.convert("RGBA").tobytes()
    for i in range(0, len(data), 4):
        yield data[i], data[i + 1], data[i + 2], data[i + 3]


def check_pixelate_output(output_path, palette_colors, expected_size=48):
    """校验 pixelate 输出的硬规范：expected_size 见方、RGBA、alpha ∈ {0,255}、颜色全在限定色板内。"""
    assert_true(output_path.exists(), f"输出文件不存在：{output_path}")
    img = Image.open(output_path)
    assert_true(img.size == (expected_size, expected_size),
                f"输出尺寸应为 {expected_size}×{expected_size}，实际 {img.size}")
    assert_true(img.mode == "RGBA", f"输出模式应为 RGBA，实际 {img.mode}")
    for r, g, b, a in iter_rgba(img):
        assert_true(a in (0, 255), f"发现半透明像素 alpha={a}（违反红线 R2）")
        if a == 255:
            assert_true((r, g, b) in palette_colors,
                        f"颜色 {(r, g, b)} 不在 16 色板内")


def main():
    """测试主流程：生成图 → 跑两个脚本 → 逐项断言。全部通过打印 PASS。"""
    palette_colors = load_palette_colors()
    # 色板至少包含 16 族色（另有 16 个人格主色与之重复、1 个 outline 描边色）
    assert_true(len(palette_colors) >= 16, f"色板应至少含 16 族色，实际 {len(palette_colors)} 色")

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        paths = make_test_images(tmp)

        # ---------- check_alpha：含半透明的目录 ----------
        code, out = run(CHECK_ALPHA, tmp)
        assert_true(code == 1, f"含半透明图，check_alpha 应退出 1，实际 {code}\n{out}")
        assert_true("半透明像素总数 = 0" not in out, "应抓出半透明像素，但总数为 0")
        print("[OK] check_alpha 抓出半透明边的 PNG（退出码 1）")

        # ---------- check_alpha：干净目录（只放合规图） ----------
        clean_dir = tmp / "clean"
        clean_dir.mkdir()
        # small.png 只有 0/255 两种 alpha，复制过去当干净样本
        clean_png = clean_dir / "small.png"
        clean_png.write_bytes(paths["small"].read_bytes())
        code, out = run(CHECK_ALPHA, clean_dir)
        assert_true(code == 0, f"干净目录，check_alpha 应退出 0，实际 {code}\n{out}")
        assert_true("半透明像素总数 = 0" in out, "干净目录汇总应为 0")
        print("[OK] check_alpha 对合规图退出码 0")

        # ---------- pixelate：带半透明边的 PNG（--size 48 保持旧规范断言） ----------
        out1 = tmp / "out_semi.png"
        code, out = run(PIXELATE, paths["semi_edge"], "-o", out1, "--size", "48")
        assert_true(code == 0, f"pixelate 运行失败：{out}")
        check_pixelate_output(out1, palette_colors)
        # 阈值化后不得再有 alpha=128，且主体应保留（存在不透明像素）
        # tobytes() 取第 4 字节（alpha）序列，避开 getdata() 的弃用警告
        alpha_bytes = Image.open(out1).convert("RGBA").tobytes()[3::4]
        has_opaque = any(a == 255 for a in alpha_bytes)
        assert_true(has_opaque, "主体被误删，输出全透明")
        print("[OK] pixelate 处理带半透明边的 PNG（1-bit alpha + 限定色板）")

        # ---------- pixelate：白底 JPG（--size 48 保持旧规范断言） ----------
        out2 = tmp / "out_white.png"
        code, out = run(PIXELATE, paths["white_bg"], "-o", out2, "--size", "48")
        assert_true(code == 0, f"pixelate 运行失败：{out}")
        check_pixelate_output(out2, palette_colors)
        img = Image.open(out2)
        # 白色背景应被去除：画布四角必须是透明的（中央色块碰不到角落）
        for corner in [(0, 0), (47, 0), (0, 47), (47, 47)]:
            assert_true(img.getpixel(corner)[3] == 0, f"白底未去除，角点 {corner} 不透明")
        # 中央色块应保留为不透明
        assert_true(img.getpixel((24, 24))[3] == 255, "白底图的主体色块丢失")
        print("[OK] pixelate 白底 JPG 去背景正常（四角透明、主体保留）")

        # ---------- pixelate：纯透明 PNG（--size 48 保持旧规范断言） ----------
        out3 = tmp / "out_transparent.png"
        code, out = run(PIXELATE, paths["transparent"], "-o", out3, "--size", "48")
        assert_true(code == 0, f"pixelate 运行失败：{out}")
        check_pixelate_output(out3, palette_colors)
        # 纯透明输入应输出全透明画布：逐字节检查 alpha 序列全为 0（tobytes 避开 getdata 弃用警告）
        alpha_bytes = Image.open(out3).convert("RGBA").tobytes()[3::4]
        assert_true(all(a == 0 for a in alpha_bytes), "纯透明输入应输出全透明画布")
        print("[OK] pixelate 纯透明 PNG 正常（输出全透明 48×48 画布）")

        # ---------- pixelate：小于 48px 的图（--size 48 保持旧规范断言） ----------
        out4 = tmp / "out_small.png"
        code, out = run(PIXELATE, paths["small"], "-o", out4, "--size", "48")
        assert_true(code == 0, f"pixelate 运行失败：{out}")
        check_pixelate_output(out4, palette_colors)
        # 小图等比放大后应有内容且居中：中心像素不透明，四边 2px 边距透明
        img = Image.open(out4)
        assert_true(img.getpixel((24, 24))[3] == 255, "小图放大后中心无内容")
        assert_true(img.getpixel((0, 24))[3] == 0, "小图放大后未留边距（左边缘不透明）")
        assert_true(img.getpixel((47, 24))[3] == 0, "小图放大后未留边距（右边缘不透明）")
        print("[OK] pixelate 小于 48px 的图等比放大居中（含 2px 边距）")

        # ---------- pixelate：默认 --size 32（新画布规范，PRD §8.4 32×32） ----------
        out5 = tmp / "out_default32.png"
        code, out = run(PIXELATE, paths["semi_edge"], "-o", out5)
        assert_true(code == 0, f"pixelate 默认尺寸运行失败：{out}")
        check_pixelate_output(out5, palette_colors, expected_size=32)
        print("[OK] pixelate 默认输出 32×32 画布（--size 默认值已从 48 改为 32）")

    print("\n全部测试通过：PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
