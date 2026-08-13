# -*- coding: utf-8 -*-
"""
gen_infj_v6.py — INFJ 重做：image-01 专门生成「真天鹅头」候选（owner 不满意 v4 的「鹅头像帽子」）

任务：
  owner 对 INFJ 当前版本不满意：之前的 prompt 用了 "long elegant shawl robe"，
  模型把「披肩」画成了「头上的兜帽」，鹅头被当成装饰。本脚本只生成 infj，
  prompt 强化：必须真的是天鹅头本身（白羽圆头 + 橘喙 + 黑喙基），
  不是兜帽、不是帽子、不是头饰、不是面具、不是人类戴鸟头套。

输出：assets/art/concepts/v5/infj_<n>.png（与 v5 重生成目录并列，不覆盖）
重试：每轮一张，独立候选号 1-5，最多 5 轮。

用法：python scripts/gen_infj_v6.py --n 5

依赖：Pillow、标准库 urllib；复用 make_concepts 的 API_URL / load_api_key。
"""

import argparse
import json
import sys
import time
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image

# Windows 控制台默认 GBK，强制 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 复用 make_concepts 的 API 配置与 key 读取
from make_concepts import API_URL, load_api_key

# 仓库根目录
REPO_ROOT = Path(__file__).resolve().parent.parent
# 输出到 v5 候选目录（与 v5 重生成并列）
CONCEPTS_V5_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "v5"

# 外交家绿 #3E8F6E（palette.json families.diplomat.main，工单 v5 基准）
OUTLINE_HEX = "#2B2320"
MAIN_HEX = "#3E8F6E"  # 外交家绿
COLOR_NAME = "emerald green, not olive, not yellowish, not teal, not mint"

# 天鹅头部精确描述（要解决"像帽子"的反馈）：精简版以满足 1500 字符上限
#   - 强调"bird head itself"，否定 hood/hat/mask/costume
#   - 解剖学标志：white feathers + orange beak + black cere（喙基）+ eyes on sides
ANIMAL_BLOCK = (
    "a real swan BIRD HEAD (the head itself is a swan, white feathered), "
    "white #F2EDE4 round head with feathered texture, "
    "orange #D97B29 beak with black #2B2320 cere at beak base, "
    "small dark brown #5C4033 eyes on the sides, "
    "long curved S-shape white neck, "
    "NOT a hood, NOT a hat, NOT a mask, NOT a costume, NOT a human face wearing a bird mask"
)

# 服装：不带披肩/兜帽的款式（v4 教训："long elegant shawl robe" 被画成头巾/兜帽）
CLOTHES_BLOCK = (
    "a long open overcoat with V-neck collar, no hood, no scarf, no shawl over the head"
)

# Prompt 模板（在 v5 模板基础上加天鹅解剖 + 否定兜帽）—— 严格控制在 1500 字符内
PROMPT_TEMPLATE = (
    "detailed pixel art character portrait, 512x512, crisp pixels, no anti-aliasing, "
    "cute chibi anthropomorphic swan, "
    + ANIMAL_BLOCK
    + ", "
    + f"the character wears {CLOTHES_BLOCK}, "
    f"wearing solid {MAIN_HEX} outfit, entire outfit is {COLOR_NAME} (exactly hex {MAIN_HEX}), "
    "no white undershirt, no cream shirt, clothes must be emerald green, not brown, not gray, not white, "
    "feathers: white #F2EDE4 with cream #E6D3B3 shading only, dark brown eyes, "
    "visible pixel clusters, rich feather/fabric detail, 2.5 head-body, full body, front view, centered, standing, "
    f"clean dark brown outline {OUTLINE_HEX}, flat cel shading, "
    "plain solid white background #FFFFFF, no scenery, no shadow under character, "
    "single character, retro 16-bit pixel game art"
)


def generate_one(key, n):
    """调用 MiniMax image-01 生成一张 infj 候选，返回 PIL Image；失败抛异常。"""
    payload = {
        "model": "image-01",
        "prompt": PROMPT_TEMPLATE,
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
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    base = body.get("base_resp", {})
    if base.get("status_code") != 0:
        raise RuntimeError(f"API 返回错误：{base.get('status_code')} {base.get('status_msg')}")

    image_url = body["data"]["image_urls"][0]
    with urllib.request.urlopen(image_url, timeout=180) as resp:
        raw = resp.read()
    img = Image.open(BytesIO(raw))
    img.load()
    return img


def main(argv=None):
    """逐轮调用 API 生成 infj 候选；最多 5 轮，独立候选号 1-N。"""
    parser = argparse.ArgumentParser(description="INFJ 重做：image-01 生成真天鹅头候选")
    parser.add_argument("--n", type=int, default=5, help="生成候选数（默认 5，上限 5）")
    parser.add_argument("--start", type=int, default=1, help="候选起始序号（默认 1）")
    args = parser.parse_args(argv)

    n = min(args.n, 5)  # 工单要求：重试上限 5 次

    key = load_api_key()
    CONCEPTS_V5_DIR.mkdir(parents=True, exist_ok=True)

    succeeded, failed = [], []
    for i in range(args.start, args.start + n):
        out_path = CONCEPTS_V5_DIR / f"infj_{i}.png"
        try:
            img = generate_one(key, i)
            img.convert("RGB").save(out_path, "PNG")
            with Image.open(out_path) as check:
                check.verify()
            print(f"[OK] infj_{i}（swan，{img.size[0]}x{img.size[1]}）→ {out_path.name}")
            succeeded.append(out_path.name)
        except Exception as exc:
            print(f"[失败] infj_{i}：{exc}")
            failed.append(out_path.name)
        time.sleep(1)

    print(f"\n汇总：成功 {len(succeeded)} / {n}")
    if failed:
        print(f"失败清单：{', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())