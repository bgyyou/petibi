# -*- coding: utf-8 -*-
"""
make_concepts.py — 用 MiniMax 图像生成 API 批量产出 16 人格概念图（工单第 2 步）

用途：
  按 assets/style/character-design.md 的设计说明为 16 只人格角色生成概念参考图，
  存到 assets/art/concepts/<人格小写>.jpg（该目录已 gitignore，不进公开仓库）。
  概念图只用于定姿势 / 配色 / 气质的参考，不作为最终 sprite 素材——
  PRD §8.3 规定透明 sprite 必须原生像素绘制（AI 出图 + 抠图会产生白边，属原理性缺陷）。

凭证：
  API key 读 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN（与 Claude Code 共用的 MiniMax key）。

用法：
  python scripts/make_concepts.py            # 生成全部 16 只
  python scripts/make_concepts.py intj entp  # 只生成指定人格

依赖：Pillow（下载后校验图片可打开）、标准库 urllib。
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# 概念图输出目录（已 gitignore）
CONCEPTS_DIR = REPO_ROOT / "assets" / "art" / "concepts"

# MiniMax 开放平台图像生成接口（工单第 2 步指定）
API_URL = "https://api.minimaxi.com/v1/image_generation"

# API key 文件位置（工单指定：~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN）
SETTINGS_PATH = Path.home() / ".claude" / "settings.json"

# 16 人格 → (动物中文, 动物英文, 主色)，与 assets/style/palette.json 一致
PERSONALITIES = {
    "intj": ("猫头鹰", "owl", "#3B2A4A"),
    "intp": ("猫", "cat", "#6B4E8E"),
    "entj": ("狮子", "lion", "#9B7EC4"),
    "entp": ("狐狸", "fox", "#C9B4E0"),
    "infj": ("天鹅", "swan", "#1F4433"),
    "infp": ("蝴蝶", "butterfly", "#3E7C59"),
    "enfj": ("金毛犬", "golden retriever dog", "#6FAF88"),
    "enfp": ("海豚", "dolphin", "#A8D5BA"),
    "istj": ("海狸", "beaver", "#1F3A5F"),
    "isfj": ("企鹅", "penguin", "#33608F"),
    "estj": ("熊", "bear", "#5B8FC7"),
    "esfj": ("大象", "elephant", "#9DC3E6"),
    "istp": ("豹", "leopard", "#6B4A1F"),
    "isfp": ("卡皮巴拉", "capybara", "#A8763E"),
    "estp": ("猴子", "monkey", "#D4A55F"),
    "esfp": ("鹦鹉", "parrot", "#F0CE9B"),
}

# 概念图 prompt 模板：对应设计文档 §0 的"兽首人身 + 像素风 + 白底"约束
PROMPT_TEMPLATE = (
    "cute pixel art game sprite, full body front view, "
    "chibi humanoid character with a {animal_en} head (animal head, human body, Animal Crossing NPC style), "
    "wearing clothes in main color {main_hex}, big head small body (2.5 head-body ratio), "
    "clean dark brown outline, flat colors, retro 16-bit pixel style, "
    "plain solid white background, centered, single character"
)


def load_api_key():
    """从 ~/.claude/settings.json 读取 ANTHROPIC_AUTH_TOKEN 作为 MiniMax API key。"""
    with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
        settings = json.load(f)
    key = settings.get("env", {}).get("ANTHROPIC_AUTH_TOKEN")
    if not key:
        raise RuntimeError(f"{SETTINGS_PATH} 中未找到 env.ANTHROPIC_AUTH_TOKEN")
    return key


def generate_one(key, personality, animal_en, main_hex):
    """调用 MiniMax 图像接口生成单只概念图，返回图片字节；失败抛异常。"""
    payload = {
        "model": "image-01",
        "prompt": PROMPT_TEMPLATE.format(animal_en=animal_en, main_hex=main_hex),
        "aspect_ratio": "1:1",
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
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    base = body.get("base_resp", {})
    if base.get("status_code") != 0:
        raise RuntimeError(f"API 返回错误：{base.get('status_code')} {base.get('status_msg')}")

    image_url = body["data"]["image_urls"][0]
    with urllib.request.urlopen(image_url, timeout=120) as resp:
        return resp.read()


def main(argv=None):
    """批量生成入口：逐只调用 API，下载校验后落盘，最后汇总成功/失败清单。"""
    args = argv if argv is not None else sys.argv[1:]
    targets = [p.lower() for p in args] if args else list(PERSONALITIES.keys())

    key = load_api_key()
    CONCEPTS_DIR.mkdir(parents=True, exist_ok=True)

    succeeded, failed = [], []
    for p in targets:
        animal_cn, animal_en, main_hex = PERSONALITIES[p]
        out_path = CONCEPTS_DIR / f"{p}.jpg"
        try:
            data = generate_one(key, p, animal_en, main_hex)
            out_path.write_bytes(data)
            # 用 PIL 打开校验：确认下载到的是可解码图片，而不是错误页/截断内容
            with Image.open(out_path) as img:
                img.verify()
            print(f"[OK] {p}（{animal_cn}）→ {out_path}")
            succeeded.append(p)
        except Exception as exc:  # 网络/鉴权/解码失败都如实记录，不中断后续
            print(f"[失败] {p}（{animal_cn}）：{exc}")
            failed.append(p)
        # 简单限速，避免触发接口频控
        time.sleep(1)

    print(f"\n汇总：成功 {len(succeeded)} / {len(targets)}")
    if failed:
        print(f"失败清单：{', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
