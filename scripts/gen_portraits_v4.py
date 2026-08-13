# -*- coding: utf-8 -*-
"""
gen_portraits_v4.py — 用 MiniMax image-01 批量生成 16 人格精美像素形象图候选（工单 v4 第 1-2 步）

与 v2 概念图脚本（make_concepts.py）的区别：
  - v2 是 32×32 sprite 的"概念参考图"，本轮 v4 交付的是 512×512 展示级精细像素形象图
    （owner 原话："说的是像素风，不是低像素风——人物细节要做得很精美，只是风格是像素风而已"）
  - prompt 关键词按工单 v4 第 1 步：必须含 "detailed pixel art"、"512x512"、
    "crisp pixels, no anti-aliasing"、指定动物 + 毛色 + 服装色 hex、纯白背景
  - 毛色严格规避四族色（绿/黄/紫/蓝），只用 palette.json neutrals 组：
      ENFP 海豚：蓝 → 灰色系；ESFP 鹦鹉：绿 → 红橘系（金刚鹦鹉方向）；
      ISFJ 企鹅：深灰+白；INFJ 天鹅：白/奶油（其余同理，见 PERSONALITIES）
  - 人格色系只体现在服装：服装主色 = 该族 family.main（一族一色，同族 4 人完全同色）

输出：assets/art/concepts/v4/<人格小写>_<候选序号>.png（concepts 目录已 gitignore）

凭证：复用 make_concepts.load_api_key（~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN）

用法：
  python scripts/gen_portraits_v4.py                 # 全部 16 只，每只 2 候选
  python scripts/gen_portraits_v4.py intj enfp       # 只生成指定人格
  python scripts/gen_portraits_v4.py intj --n 3      # 指定候选数

依赖：Pillow、标准库 urllib；复用 make_concepts 的 API key 读取与 API_URL。
"""

import sys

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文乱码与 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import argparse
import json
import time
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image

from make_concepts import API_URL, load_api_key

# 仓库根目录 = 本文件所在 scripts/ 的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# v4 候选图输出目录（concepts 已 gitignore，不进公开仓库）
CONCEPTS_V4_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "v4"

# 统一描边色（palette.json outline），prompt 中明确要求模型使用
OUTLINE_HEX = "#2B2320"

# 16 人格设计表：动物英文 / 毛色描述（只用 neutrals 色，带 hex 引导模型）
#               / 服装描述 / 服装主色（family.main）/ 服装色名（prompt 强调用）
# 族色：analyst 紫 #6B4E8E / diplomat 绿 #3E7C59 / sentinel 蓝 #33608F / explorer 琥珀 #A8763E
PERSONALITIES = {
    # ── 分析家（紫 #6B4E8E）────────────────────────────
    "intj": dict(animal_en="owl",
                 fur="brown feathers #8B5E3C with a cream #E6D3B3 facial disc and dark brown #5C4033 feather tufts",
                 clothes="a hooded scholar robe",
                 main="#6B4E8E", color_name="purple"),
    "intp": dict(animal_en="cat",
                 fur="gray fur #9A9A9A with dark gray #555555 stripes and a white #F2EDE4 muzzle",
                 clothes="a loose hoodie with rolled-up sleeves",
                 main="#6B4E8E", color_name="purple"),
    "entj": dict(animal_en="lion",
                 fur="light brown #C49A6C face fur with a full dark brown #5C4033 mane",
                 clothes="a formal suit jacket with a tie",
                 main="#6B4E8E", color_name="purple"),
    "entp": dict(animal_en="fox",
                 fur="orange #D97B29 fur with a white #F2EDE4 chest and dark brown #5C4033 ear tips",
                 clothes="a casual jacket with popped collar",
                 main="#6B4E8E", color_name="purple"),
    # ── 外交家（绿 #3E7C59）────────────────────────────
    "infj": dict(animal_en="swan",
                 fur="white #F2EDE4 feathers with cream #E6D3B3 shading",
                 clothes="a long elegant shawl robe",
                 main="#3E7C59", color_name="green"),
    # 试跑教训（infp v1/v2 共 4 张全是"人脸女孩 + 蝴蝶翅膀"，兽首要求没达成）→
    # 毛色段直接描述蝴蝶头部结构（复眼/触角/吻管），并双重否定人脸/人发
    "infp": dict(animal_en="butterfly",
                 fur="a real insect butterfly head with big dark brown #5C4033 compound eyes, "
                     "two curly antennae on top and a tiny proboscis, absolutely no human face, no human hair, "
                     "large orange #D97B29 and cream #E6D3B3 patterned butterfly wings growing from the back "
                     "(strictly no blue, no purple, no green on the wings)",
                 clothes="a loose cozy sweater",
                 main="#3E7C59", color_name="green"),
    # 试跑教训（enfj v1/v2 共 4 张开衫全是橄榄绿/黄绿，量化时被误判成探险家琥珀色
    # 遭到中性化，衣服变棕）→ 色名强调 forest green 并否定 olive/yellow 色调
    "enfj": dict(animal_en="golden retriever dog",
                 fur="cream #E6D3B3 and light brown #C49A6C fur with floppy ears",
                 clothes="a warm cardigan over a shirt",
                 main="#3E7C59", color_name="forest green, not olive, not yellowish, not teal"),
    "enfp": dict(animal_en="bottlenose dolphin",
                 fur="gray #9A9A9A skin with a white #F2EDE4 belly, dolphin rostrum snout and dorsal fin "
                     "(strictly no blue, no blue-gray skin)",
                 clothes="a sporty track jacket",
                 main="#3E7C59", color_name="green"),
    # ── 守护者（蓝 #33608F）────────────────────────────
    "istj": dict(animal_en="beaver",
                 fur="brown #8B5E3C fur with dark brown #5C4033 paws",
                 clothes="a work apron over a shirt",
                 main="#33608F", color_name="blue"),
    "isfj": dict(animal_en="penguin",
                 fur="dark gray #555555 and white #F2EDE4 plumage (strictly black-and-white penguin colors, no blue)",
                 clothes="a neat nurse-style dress with an apron",
                 main="#33608F", color_name="blue"),
    # 试跑教训（estj v1 2 张熊毛偏橘红，量化后头部成亮橘色）→ 毛色改深棕系并否定橘色
    "estj": dict(animal_en="bear",
                 fur="dark brown #5C4033 and brown #8B5E3C fur with a cream #E6D3B3 muzzle "
                     "(strictly no orange, no reddish fur)",
                 clothes="a strict uniform jacket with epaulettes",
                 main="#33608F", color_name="blue"),
    "esfj": dict(animal_en="elephant",
                 fur="gray #9A9A9A skin with light cream #E6D3B3 inner ears",
                 clothes="a friendly vest over a shirt",
                 main="#33608F", color_name="blue"),
    # ── 探险家（琥珀 #A8763E）──────────────────────────
    "istp": dict(animal_en="leopard",
                 fur="light brown #C49A6C fur with dark brown #5C4033 rosette spots (strictly no yellow)",
                 clothes="a mechanic work jacket with a wrench in hand",
                 main="#A8763E", color_name="amber"),
    "isfp": dict(animal_en="capybara",
                 fur="light brown #C49A6C and brown #8B5E3C fur",
                 clothes="a painter smock holding a paintbrush",
                 main="#A8763E", color_name="amber"),
    "estp": dict(animal_en="monkey",
                 fur="brown #8B5E3C fur with a cream #E6D3B3 face",
                 clothes="a sporty tracksuit jacket",
                 main="#A8763E", color_name="amber"),
    "esfp": dict(animal_en="parrot",
                 fur="orange #D97B29 and white #F2EDE4 feathers, scarlet macaw style head "
                     "(strictly no green, no blue, no yellow feathers)",
                 clothes="a flashy stage performer jacket",
                 main="#A8763E", color_name="amber"),
}

# 形象图 prompt 模板（工单 v4 第 1 步关键词全覆盖）：
# "detailed pixel art"、"512x512"、"crisp pixels, no anti-aliasing"、动物 + 毛色 + 服装色 hex、纯白背景。
# 16 张构图统一：Q 版 2.5 头身、正面全身、居中、白底、单角色。
# 试跑教训（intj/enfp 各 2 张，v1 模板）：
#   - 服装色被模型忽略（紫袍画成棕色）→ 服装颜色用「色名 + exact hex + 否定其他色」三重强调
#   - 猫头鹰画成"戴兜帽的小孩" → 强调 "real animal head, not a hood/mask, no human face"
#   - 海豚毛色出蓝 → 毛色描述加 strictly no blue；动物改 bottlenose dolphin 并指定吻部/背鳍
#   - 蓝眼睛 → 统一指定 dark brown eyes（头部不许出现四族色系）
#   - 四张都有地面灰色椭圆投影 → "absolutely no shadow under the character, no ground shadow ellipse"
PROMPT_TEMPLATE = (
    "detailed pixel art character portrait, 512x512 canvas, crisp pixels, no anti-aliasing, "
    "cute chibi anthropomorphic {animal_en} character, a real {animal_en} head "
    "(animal head on humanoid body, Animal Crossing NPC style, not a hood, not a mask, no human face), "
    "the character wears {clothes}, the clothing's dominant color is solid {color_name} "
    "(exactly hex {main_hex}), the clothes must be {color_name}, not brown, not gray, not any other color, "
    "fur and skin colors: {fur}, dark brown eyes, "
    "visible pixel clusters, rich details (fur texture, fabric folds, expressive face) rendered in pixel shading, "
    "2.5 head-body ratio, full body, front view, centered, standing pose, "
    "clean dark brown outline {outline_hex}, flat cel shading with 3-4 tones per area, "
    "plain solid white background #FFFFFF, no scenery, no gradient, "
    "absolutely no shadow under the character, no ground shadow ellipse, "
    "single character, retro 16-bit pixel game art, highly detailed pixel art masterpiece"
)


def generate_one(key, code, spec):
    """调用 MiniMax image-01 生成单张候选，返回 PIL Image；失败抛异常。"""
    prompt = PROMPT_TEMPLATE.format(
        animal_en=spec["animal_en"],
        fur=spec["fur"],
        clothes=spec["clothes"],
        main_hex=spec["main"],
        color_name=spec["color_name"],
        outline_hex=OUTLINE_HEX,
    )
    payload = {
        "model": "image-01",
        "prompt": prompt,
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
    # 统一解码为 PIL Image（API 可能返回 jpg/png，后续统一存 PNG 便于管线处理）
    img = Image.open(BytesIO(raw))
    img.load()
    return img


def main(argv=None):
    """批量生成入口：逐人格逐候选调用 API，落盘后校验可打开，最后汇总。"""
    parser = argparse.ArgumentParser(description="MiniMax image-01 生成 16 人格 v4 精细像素形象图候选")
    parser.add_argument("codes", nargs="*", help="只生成指定人格（小写代码，如 intj enfp）；缺省全部 16 只")
    parser.add_argument("--n", type=int, default=2, help="每只候选数（默认 2，工单要求 2-3）")
    args = parser.parse_args(argv)

    targets = [c.lower() for c in args.codes] if args.codes else list(PERSONALITIES.keys())
    for c in targets:
        if c not in PERSONALITIES:
            print(f"未知人格代码：{c}")
            return 2

    key = load_api_key()
    CONCEPTS_V4_DIR.mkdir(parents=True, exist_ok=True)

    succeeded, failed = [], []
    for code in targets:
        spec = PERSONALITIES[code]
        for i in range(1, args.n + 1):
            out_path = CONCEPTS_V4_DIR / f"{code}_{i}.png"
            try:
                img = generate_one(key, code, spec)
                # RGBA/RGB 统一转 RGB 存 PNG（白底概念稿，无 alpha 需求）
                img.convert("RGB").save(out_path, "PNG")
                with Image.open(out_path) as check:
                    check.verify()
                print(f"[OK] {code}_{i}（{spec['animal_en']}，{img.size[0]}x{img.size[1]}）→ {out_path.name}")
                succeeded.append(out_path.name)
            except Exception as exc:  # 网络/鉴权/解码失败如实记录，不中断后续
                print(f"[失败] {code}_{i}（{spec['animal_en']}）：{exc}")
                failed.append(out_path.name)
            # 简单限速，避免触发接口频控
            time.sleep(1)

    print(f"\n汇总：成功 {len(succeeded)} / {len(targets) * args.n}")
    if failed:
        print(f"失败清单：{', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
