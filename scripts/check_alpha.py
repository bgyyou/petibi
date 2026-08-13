# -*- coding: utf-8 -*-
"""
check_alpha.py — sprite 资产 1-bit alpha 合规检查脚本（红线 R2 / PRD §8.3）

功能：
  递归扫描指定目录（默认 assets/ 和 resources/sprites/）下的所有 PNG，
  检查是否存在半透明像素（0 < alpha < 255）。
  半透明像素是"白边"的根源：抗锯齿边缘在深色壁纸上会显示为白雾，
  因此 PRD §8.4 规定 alpha 只允许全透明 / 全不透明。

输出：
  每个 PNG 一行检查结果；末尾汇总"半透明像素总数 = N"。

退出码：
  N = 0 → 退出 0（合规）；N > 0 → 退出 1（供 CI / 验收拦截用）。

用法：
  python scripts/check_alpha.py                # 扫描默认目录
  python scripts/check_alpha.py <目录...>      # 扫描指定目录（可多个）

依赖：仅 Pillow。
"""

import argparse
import sys
from pathlib import Path

from PIL import Image

# 仓库根目录 = 本文件所在 scripts/ 的上一级；默认扫描目录基于它定位，
# 保证从任意工作目录运行都扫同一批资产
REPO_ROOT = Path(__file__).resolve().parent.parent

# 默认扫描目录（工单要求：assets/ 和 resources/sprites/）
DEFAULT_DIRS = [REPO_ROOT / "assets", REPO_ROOT / "resources" / "sprites"]


def count_semitransparent_pixels(png_path):
    """统计单个 PNG 中半透明像素（0 < alpha < 255）的数量。

    统一转成 RGBA 再统计：无 alpha 通道的图（如 RGB 模式 PNG）
    转换后 alpha 全为 255，自然计 0，无需特判。
    用 tobytes() 逐像素读取，避开 Pillow 新版对 getdata() 的弃用警告。
    """
    img = Image.open(png_path).convert("RGBA")
    data = img.tobytes()
    count = 0
    # RGBA 每像素 4 字节，第 4 字节即 alpha
    for i in range(3, len(data), 4):
        if 0 < data[i] < 255:
            count += 1
    return count


def scan_directories(dirs):
    """扫描多个目录下的全部 PNG，逐文件打印结果，返回半透明像素总数。"""
    total = 0
    for directory in dirs:
        directory = Path(directory)
        if not directory.exists():
            # 目录不存在不视为错误（如 resources/sprites/ 可能尚未创建），打印提示即可
            print(f"目录不存在，跳过：{directory}")
            continue
        # rglob 递归匹配所有 .png（不区分大小写后缀在 Windows 上天然兼容）
        for png_path in sorted(directory.rglob("*.png")):
            n = count_semitransparent_pixels(png_path)
            total += n
            status = "OK" if n == 0 else f"半透明像素 = {n}"
            print(f"{png_path}: {status}")
    return total


def main(argv=None):
    """命令行入口：解析目录参数，扫描并按汇总结果决定退出码。"""
    parser = argparse.ArgumentParser(description="检查 PNG 是否存在半透明像素（1-bit alpha 合规检查，红线 R2）")
    parser.add_argument("dirs", nargs="*",
                        help="要扫描的目录（可多个；缺省为 assets/ 和 resources/sprites/）")
    args = parser.parse_args(argv)

    dirs = args.dirs if args.dirs else DEFAULT_DIRS
    total = scan_directories(dirs)

    print(f"半透明像素总数 = {total}")
    if total == 0:
        print("检查通过：全部 PNG 均为 1-bit alpha")
        return 0
    print("检查不通过：存在半透明像素，请用 scripts/pixelate.py 重新处理")
    return 1


if __name__ == "__main__":
    sys.exit(main())
