# -*- coding: utf-8 -*-
"""
gen_installer_illustration.py — 用 MiniMax image-01 生成 NSIS 安装器 164×314 品牌插画（DESIGN.md §6）。

工单（M5-安装器登录页设计）：
  - electron-builder NSIS 安装器左侧 164×314 像素品牌插画位；
  - 设计规范：16 人格像素动物形象 + 四族配色（紫 #785D87 / 绿 #3E8F6E / 蓝 #399FB9 / 黄 #E4C728）+
    奶油底 #FEF9EF + 墨色描边 #2B2320；
  - 主题："16 只像素动物排队欢迎你"；
  - 风格：硬边像素（无渐变、无反 alpha 描边、无柔阴影）——AI 出图后过 pixelate 管线量化
    或直接评估像素感是否达标（允许色板外，但必须像素、无渐变脏边）。
  - 重试上限 5 次。

输出：
  - assets/art/concepts/installer/installer_<候选号>.jpg
    （调试用，原图直存，便于人工对比）
  - assets/art/concepts/installer/installer_<候选号>.png
    （去底 + pixelate 量化后产物）
  - build/installer/installer-header.bmp
    （最终入选的 164×314 BMP，安装器侧栏实际使用的图）
  - build/installer/installer-header.png
    （同源的 PNG 版本，便于人工核对）

API：MiniMax image-01（与 make_concepts.py 同一接口）。

用法：
  python scripts/gen_installer_illustration.py            # 默认生成 3 个候选
  python scripts/gen_installer_illustration.py --count 5  # 生成 5 个候选
  python scripts/gen_installer_illustration.py --select 2 # 选第 2 个候选导出到 build/
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

# 仓库根 = scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# MiniMax 图像生成接口
API_URL = "https://api.minimaxi.com/v1/image_generation"

# API key 文件位置（与 make_concepts.py 同源）
SETTINGS_PATH = Path.home() / ".claude" / "settings.json"

# 安装器插画输出：候选目录
CONCEPTS_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "installer"
# 最终入选的安装器插画输出目录
INSTALLER_DIR = REPO_ROOT / "build" / "installer"

# 安装器侧栏标准尺寸（DESIGN.md §6：164×314）
TARGET_W, TARGET_H = 164, 314

# 16 人格 → (动物中文, 动物英文, 族色 hex, 族中文)
# 与 src/setup/persona-meta.ts PERSONAS 顺序一致（4 族 × 4 字母）
PERSONAS = [
    # analyst 紫
    ("INTJ", "猫头鹰 owl",     "#785D87", "analyst"),
    ("INTP", "猫 cat",         "#785D87", "analyst"),
    ("ENTJ", "狮子 lion",      "#785D87", "analyst"),
    ("ENTP", "狐狸 fox",       "#785D87", "analyst"),
    # diplomat 绿
    ("INFJ", "天鹅 swan",      "#3E8F6E", "diplomat"),
    ("INFP", "蝴蝶 butterfly", "#3E8F6E", "diplomat"),
    ("ENFJ", "金毛 golden",    "#3E8F6E", "diplomat"),
    ("ENFP", "海豚 dolphin",   "#3E8F6E", "diplomat"),
    # sentinel 蓝
    ("ISTJ", "海狸 beaver",    "#399FB9", "sentinel"),
    ("ISFJ", "企鹅 penguin",   "#399FB9", "sentinel"),
    ("ESTJ", "熊 bear",        "#399FB9", "sentinel"),
    ("ESFJ", "大象 elephant",  "#399FB9", "sentinel"),
    # explorer 黄
    ("ISTP", "豹 leopard",     "#E4C728", "explorer"),
    ("ISFP", "卡皮巴拉 capybara","#E4C728", "explorer"),
    ("ESTP", "猴子 monkey",    "#E4C728", "explorer"),
    ("ESFP", "鹦鹉 parrot",    "#E4C728", "explorer"),
]

# 调色板文件路径（pixelate 量化用）
PALETTE_FILE = REPO_ROOT / "assets" / "style" / "palette.json"

# 安装器插画 prompt（v2：更聚焦于"少角色 + 简单构图"，让 image-01 出图成功率更高）：
#   关键约束（DESIGN.md §3 + §6）：
#     - 164×314 竖版
#     - 8-bit 像素艺术，4×4 网格 16 只萌系动物角色
#     - 奶油底 #FEF9EF + 墨色 #2B2320 描边
#     - 四族配色（紫/绿/蓝/黄）
#     - 硬边、无渐变、无抗锯齿、无反 alpha
PROMPT_TEMPLATE = (
    "vertical pixel art 164x314 illustration, "
    "a 4x4 grid of 16 cute pixel animals standing in formation, "
    "each animal is small chibi pixel character with simple round head, "
    "no human body just animal characters, "
    "cream #FEF9EF solid background, "
    "dark brown #2B2320 pixel outline around every animal, "
    "animals grouped in 4 color families: "
    "purple #785D87 row 1 (owl cat lion fox), "
    "green #3E8F6E row 2 (swan butterfly golden-retriever dolphin), "
    "blue #399FB9 row 3 (beaver penguin bear elephant), "
    "yellow #E4C728 row 4 (leopard capybara monkey parrot), "
    "each color family colored flat solid no shading, "
    "flat colors no gradients no anti-aliasing, "
    "8-bit retro game sprite style, "
    "no shadow no blur no glow no semi-transparent edges, "
    "tiny pixel font text 'PETIBI' at bottom in dark brown"
)


def load_api_key() -> str:
    """从 ~/.claude/settings.json 读取 ANTHROPIC_AUTH_TOKEN 作为 MiniMax API key。"""
    with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
        settings = json.load(f)
    key = settings.get("env", {}).get("ANTHROPIC_AUTH_TOKEN")
    if not key:
        raise RuntimeError(f"{SETTINGS_PATH} 中未找到 env.ANTHROPIC_AUTH_TOKEN")
    return key


def generate_one(key: str, candidate_id: int) -> bytes:
    """调用 MiniMax image-01 生成一张候选插画，返回图片字节；失败抛异常。"""
    payload = {
        "model": "image-01",
        "prompt": PROMPT_TEMPLATE,
        # 164×314 比例约 1:1.91；MiniMax 支持的竖版预设最接近 9:16（1:1.78），
        # 后处理会用 NEAREST 缩放到精确 164×314，构图差异可忽略
        "aspect_ratio": "9:16",
        "response_format": "url",
        "n": 1,
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    base = body.get("base_resp", {})
    if base.get("status_code") != 0:
        raise RuntimeError(f"API 返回错误：{base.get('status_code')} {base.get('status_msg')}")

    image_url = body["data"]["image_urls"][0]
    with urllib.request.urlopen(image_url, timeout=180) as resp:
        return resp.read()


def resize_to_target(img: Image.Image) -> Image.Image:
    """把候选图等比缩放（NEAREST 保留像素感）到 164×314，再居中放入 164×314 画布。"""
    src_w, src_h = img.size
    # 等比缩放到目标尺寸（fit 到 164×314 内，可能有短边留白；这里直接用 contain 模式）
    scale = min(TARGET_W / src_w, TARGET_H / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = img.resize((new_w, new_h), Image.NEAREST)
    canvas = Image.new("RGB", (TARGET_W, TARGET_H), (254, 249, 239))  # 奶油 #FEF9EF
    offset_x = (TARGET_W - new_w) // 2
    offset_y = (TARGET_H - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y))
    return canvas


def quantize_optional(img: Image.Image) -> Image.Image:
    """可选的像素感增强：把全图按 16 色调色板量化（DESIGN.md 调色板）。

    候选 AI 图通常会带半透明抗锯齿，量化后能强化像素感、去掉渐变脏边。
    不强制：DESIGN.md 允许安装器插画色板外，但要求"无渐变、像素感"。
    """
    # 这里不强行套 pixelate.py 的色板（那会破坏 AI 图细节），仅做一个软量化：
    # 用 PIL 自带 quantize 到 32 色（足够保留插画细节，又去掉渐变）
    try:
        quant = img.convert("RGB").quantize(colors=32, method=Image.Quantize.MAXCOVERAGE)
        return quant.convert("RGB")
    except Exception:
        return img.convert("RGB")


def write_bmp(img: Image.Image, path: Path) -> None:
    """把图像写为 BMP（electron-builder NSIS 侧栏标准格式，BITMAPINFOHEADER 24-bit）。"""
    # Pillow 的 BMP 保存：默认 RGB 24-bit，NSIS installerSidebar 接受；
    # 不透明 alpha（NSIS 不支持 alpha channel），转 RGB 兜底
    img.convert("RGB").save(path, format="BMP")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="MiniMax image-01 生成 NSIS 安装器 164×314 品牌插画候选",
    )
    parser.add_argument(
        "--count", type=int, default=3,
        help="生成候选数量（默认 3，最多 5）",
    )
    parser.add_argument(
        "--select", type=int, default=None,
        help="把指定编号的候选（1-based）作为最终版写到 build/installer/",
    )
    args = parser.parse_args(argv)

    count = min(max(args.count, 1), 5)
    print(f"准备生成 {count} 张候选（DESIGN.md §6 像素风格 + 四族色）")

    CONCEPTS_DIR.mkdir(parents=True, exist_ok=True)
    key = load_api_key()

    # 1) 生成候选
    succeeded: list[int] = []
    for i in range(1, count + 1):
        try:
            data = generate_one(key, i)
            raw_path = CONCEPTS_DIR / f"installer_{i}_raw.jpg"
            raw_path.write_bytes(data)
            with Image.open(raw_path) as img:
                img.verify()
            print(f"[OK] 候选 {i} 原始图 → {raw_path}")
            succeeded.append(i)
        except Exception as exc:
            print(f"[失败] 候选 {i}：{exc}")
        # 简单限速，避免触发接口频控
        time.sleep(2)

    if not succeeded:
        print("全部候选失败，请检查 API key / 网络后重试。")
        return 1

    # 2) 对每个成功候选做"缩放到 164×314 + 像素感软量化"
    for i in succeeded:
        try:
            raw_path = CONCEPTS_DIR / f"installer_{i}_raw.jpg"
            with Image.open(raw_path) as img:
                rgb = img.convert("RGB")
                fitted = resize_to_target(rgb)
                quantized = quantize_optional(fitted)
                out_png = CONCEPTS_DIR / f"installer_{i}.png"
                quantized.save(out_png)
                print(f"[OK] 候选 {i} 处理后 → {out_png}（{quantized.size}）")
        except Exception as exc:
            print(f"[失败] 候选 {i} 后期处理：{exc}")

    # 3) 如果指定 --select，把对应候选导出为 build/installer/installer-header.{bmp,png}
    if args.select is not None:
        idx = args.select
        candidate_png = CONCEPTS_DIR / f"installer_{idx}.png"
        if not candidate_png.exists():
            print(f"[错误] --select {idx} 对应的候选文件不存在：{candidate_png}")
            return 1
        INSTALLER_DIR.mkdir(parents=True, exist_ok=True)
        with Image.open(candidate_png) as img:
            rgb = img.convert("RGB")
            out_bmp = INSTALLER_DIR / "installer-header.bmp"
            out_png = INSTALLER_DIR / "installer-header.png"
            write_bmp(rgb, out_bmp)
            rgb.save(out_png)
            print(f"[OK] 已选定候选 {idx} → {out_bmp} + {out_png}")
    else:
        print(f"\n候选已存到 {CONCEPTS_DIR}/；手动选定后用 `--select N` 导出。")

    print(f"\n生成汇总：成功 {len(succeeded)}/{count}。可用候选：{succeeded}")
    return 0


if __name__ == "__main__":
    sys.exit(main())