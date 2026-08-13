# -*- coding: utf-8 -*-
"""
gen_portraits_v5.py — v5 颜色对齐：重生成「服装被其他颜色稀释」的 6 只形象图候选（工单 v5 第 2 步）

背景：
  owner 原话："服装部分人格是什么颜色，服装就是什么颜色"，并点名 ISFJ（白围裙）、
  ISTJ（棕围裙）的内搭稀释主色问题。逐张目检后同问题的还有 entp（白内搭）、
  istp（深棕内搭）、esfp（白前襟）、enfj（浅薄荷内搭），共 6 只走 image-01 重生成。

与 gen_portraits_v4.py 的区别：
  - 服装色更新为 v5 采样基准色（紫 #785D87 / 绿 #3E8F6E / 蓝绿 #399FB9 / 金黄 #E4C728）
  - prompt 按工单写死："wearing solid <hex> outfit, entire outfit is <颜色名>,
    no inner layer of other colors"，并对 v4 出问题的具体内搭逐项否定
    （白围裙/棕围裙/白内搭/深棕内搭/薄荷内搭）
  - 候选输出到 assets/art/concepts/v5/（不动 v4 候选）
  - 毛色规范不变（neutrals，避开四族色），沿用 v4 返工教训的毛色描述

用法：
  python scripts/gen_portraits_v5.py              # 全部 6 只，每只 2 候选
  python scripts/gen_portraits_v5.py istj --n 3   # 只生成 istj，3 候选
  python scripts/gen_portraits_v5.py --start 3    # 候选序号从 3 开始（不覆盖已有候选）

依赖：Pillow、标准库 urllib；复用 make_concepts 的 API_URL / load_api_key。
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

# v5 候选图输出目录（concepts 已 gitignore）
CONCEPTS_V5_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "v5"

# 统一描边色（palette.json outline）
OUTLINE_HEX = "#2B2320"

# v5 重生成的 6 只设计表：动物 / 毛色（neutrals，沿用 v4 定稿描述）
#   / 服装（纯色封闭款，逐项否定 v4 出现的异色内搭）/ 服装主色（v5 采样基准）/ 色名强调
PERSONALITIES_V5 = {
    "entp": dict(animal_en="fox",
                 fur="orange #D97B29 fur with a white #F2EDE4 muzzle and dark brown #5C4033 ear tips",
                 clothes="a fully zipped casual track jacket with a popped collar, the jacket is closed "
                         "covering the whole chest and belly",
                 no_inner="no white inner shirt, no cream undershirt, the jacket must not be open",
                 main="#785D87", color_name="purple"),
    "enfj": dict(animal_en="golden retriever dog",
                 fur="cream #E6D3B3 and light brown #C49A6C fur with floppy ears",
                 clothes="a fully buttoned warm cardigan, closed all the way up covering the chest",
                 no_inner="no visible undershirt, no mint inner layer, no light-colored inner shirt",
                 # v4 教训：enfj 开衫出过橄榄绿/黄绿 → 色名继续带否定
                 main="#3E8F6E", color_name="emerald green, not olive, not yellowish, not teal, not mint"),
    "istj": dict(animal_en="beaver",
                 fur="brown #8B5E3C fur with dark brown #5C4033 paws",
                 # 第 3 轮教训（第 1-2 轮 4 张全是「背带裤/工装 + 米色衬衫」，
                 # work/coverall/jumpsuit 都触发两件套 archetype）→ 换成 v4 intp 验证过
                 # 能出纯色的「拉链夹克拉到顶 + 同色长裤」公式，并逐件否定背带裤/衬衫
                 clothes="a plain work jacket zipped all the way up to the collar, "
                         "with matching trousers, jacket and trousers are the same teal blue",
                 no_inner="no overalls, no apron, no jumpsuit, no shirt underneath, no cream sleeves, "
                          "no beige shirt, the sleeves are teal blue",
                 main="#399FB9", color_name="teal blue"),
    "isfj": dict(animal_en="penguin",
                 fur="dark gray #555555 and white #F2EDE4 plumage (strictly black-and-white penguin colors, "
                     "white feathers only on the face, the belly is covered by the dress)",
                 # 第 2 轮教训（v5 第 1 轮 2 张都带白围裙/白腹片；企鹅白肚子和围裙视觉上
                 # 无法区分）→ 写死裙子盖住整个肚子，帽子也要蓝绿
                 clothes="a neat knee-length nurse dress with long sleeves that covers the entire torso "
                         "and belly completely, and a small teal blue nurse cap",
                 no_inner="no white apron, no white bib, no white belly patch, no white cap, "
                          "no inner layer of any other color",
                 main="#399FB9", color_name="teal blue"),
    "istp": dict(animal_en="leopard",
                 fur="light brown #C49A6C fur with dark brown #5C4033 rosette spots (strictly no yellow fur)",
                 clothes="a fully zipped mechanic work jacket, closed covering the chest, "
                         "holding a small gray wrench in one paw",
                 no_inner="no dark inner shirt, no brown undershirt, the jacket must not be open",
                 main="#E4C728", color_name="golden yellow"),
    "esfp": dict(animal_en="parrot",
                 fur="orange #D97B29 and white #F2EDE4 feathers, scarlet macaw style head, "
                     "white feathers only on the face (strictly no green, no blue, no yellow feathers)",
                 # 第 3 轮教训（第 1 轮白前襟；第 2 轮 3 号只剩白领 V + 白袖口、
                 # 4 号白色领巾）→ 否定项具体到领口和袖口
                 clothes="a flashy stage performer jacket buttoned all the way up to the neck, "
                         "closed covering the entire chest and belly, long sleeves",
                 no_inner="no white inner shirt, no white front panel, no white chest patch, "
                          "no white collar, no white cuffs, the collar and cuffs are golden yellow, "
                          "the jacket must not be open, no hood",
                 main="#E4C728", color_name="golden yellow"),
}

# v5 prompt 模板：在 v4 模板基础上把「纯色服装」写死（工单要求的三句）：
# "wearing solid <hex> outfit" / "entire outfit is <颜色名>" / "no inner layer of other colors"，
# 并加「从领口到下摆同一颜色」强化 + 每只的具体否定项（no_inner）。
PROMPT_TEMPLATE_V5 = (
    "detailed pixel art character portrait, 512x512 canvas, crisp pixels, no anti-aliasing, "
    "cute chibi anthropomorphic {animal_en} character, a real {animal_en} head "
    "(animal head on humanoid body, Animal Crossing NPC style, not a hood, not a mask, no human face), "
    "the character wears {clothes}, wearing solid {main_hex} outfit, "
    "the entire outfit is {color_name} (exactly hex {main_hex}) from collar to hem, "
    "no inner layer of other colors, {no_inner}, "
    "the clothes must be {color_name}, not brown, not gray, not white, not any other color, "
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
    prompt = PROMPT_TEMPLATE_V5.format(
        animal_en=spec["animal_en"],
        fur=spec["fur"],
        clothes=spec["clothes"],
        no_inner=spec["no_inner"],
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
    parser = argparse.ArgumentParser(description="MiniMax image-01 重生成 v5 纯色服装形象图候选（6 只）")
    parser.add_argument("codes", nargs="*", help="只生成指定人格（小写代码，如 istj isfj）；缺省全部 6 只")
    parser.add_argument("--n", type=int, default=2, help="每只候选数（默认 2）")
    parser.add_argument("--start", type=int, default=1,
                        help="候选起始序号（默认 1；追加轮次时设为已有候选数 +1，避免覆盖）")
    args = parser.parse_args(argv)

    targets = [c.lower() for c in args.codes] if args.codes else list(PERSONALITIES_V5.keys())
    for c in targets:
        if c not in PERSONALITIES_V5:
            print(f"未知人格代码：{c}（v5 重生成名单只有 {', '.join(PERSONALITIES_V5)}）")
            return 2

    key = load_api_key()
    CONCEPTS_V5_DIR.mkdir(parents=True, exist_ok=True)

    succeeded, failed = [], []
    for code in targets:
        spec = PERSONALITIES_V5[code]
        for i in range(args.start, args.start + args.n):
            out_path = CONCEPTS_V5_DIR / f"{code}_{i}.png"
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
