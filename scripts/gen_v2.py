# -*- coding: utf-8 -*-
"""gen_v2.py — MiniMax image-01 概念图批量生成脚本（M1 工单 v2 管线第 1 步）

用法：
  python scripts/gen_v2.py INTP            # 生成指定人格的候选图
  python scripts/gen_v2.py --all           # 生成全部 16 只（每只 --n 张）
  python scripts/gen_v2.py INTP --n 3 --suffix b   # 追加第 2 批候选

候选图存放 assets/art/concepts/v2/<人格小写>_<序号>.png
"""
import argparse
import base64
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "assets" / "art" / "concepts" / "v2"

API_URL = "https://api.minimaxi.com/v1/image_generation"

# 人格 → (英文名, 动物英文名, 服装主色 hex, 服装描述)
PERSONAS = {
    "INTJ": ("Architect",   "owl",            "#3B2A4A dark purple",   "dark purple high-collar robe"),
    "INTP": ("Logician",    "cat",            "#6B4E8E purple",        "purple loose hoodie"),
    "ENTJ": ("Commander",   "lion",           "#9B7EC4 violet",        "violet suit jacket"),
    "ENTP": ("Debater",     "fox",            "#C9B4E0 light purple",  "light purple vest"),
    "INFJ": ("Advocate",    "white swan",     "#1F4433 dark green",    "dark green long shawl cloak"),
    "INFP": ("Mediator",    "butterfly",      "#3E7C59 green",         "green dress"),
    "ENFJ": ("Protagonist", "golden retriever dog", "#6FAF88 light green", "light green open cardigan jacket"),
    "ENFP": ("Campaigner",  "dolphin",        "#A8D5BA pale green",    "pale green t-shirt"),
    "ISTJ": ("Logistician", "beaver",         "#1F3A5F dark blue",     "dark blue work overalls"),
    "ISFJ": ("Defender",    "penguin",        "#33608F blue",          "blue round-neck sweater"),
    "ESTJ": ("Executive",   "bear",           "#5B8FC7 medium blue",   "medium blue shirt with tie"),
    "ESFJ": ("Consul",      "elephant",       "#9DC3E6 light blue",    "light blue apron top"),
    "ISTP": ("Virtuoso",    "leopard",        "#6B4A1F dark brown",    "dark brown leather jacket"),
    "ISFP": ("Adventurer",  "capybara",       "#A8763E brown",         "brown loose yukata robe"),
    "ESTP": ("Entrepreneur","monkey",         "#D4A55F yellow",        "yellow sports jacket"),
    "ESFP": ("Entertainer", "parrot",         "#F0CE9B cream",         "cream ruffled stage costume"),
}

PROMPT_TEMPLATE = (
    "Pixel art game sprite, 32x32 pixel sprite style, chibi character 2.5 heads tall, "
    "front view, full body, standing straight, centered. "
    "The character has a complete furry {animal} head - a real animal face with fur, "
    "NOT a human face, no human skin, no human hair. "
    "The small body wears a {clothes}. "
    "Thick dark brown outline around the whole character. "
    "Solid pure white background, absolutely no shadow, no ground shadow, no drop shadow, "
    "no anti-aliasing, crisp hard pixel edges, "
    "flat colors, retro 16-bit game sprite, single character only, nothing else in frame."
)


def load_token():
    """从 ~/.claude/settings.json 读取 ANTHROPIC_AUTH_TOKEN（工单指定的 key 位置）。"""
    settings = Path.home() / ".claude" / "settings.json"
    data = json.loads(settings.read_text(encoding="utf-8"))
    token = data.get("env", {}).get("ANTHROPIC_AUTH_TOKEN", "")
    if not token:
        raise RuntimeError("settings.json 中未找到 ANTHROPIC_AUTH_TOKEN")
    return token


def generate_one(token, prompt, out_path):
    """调用 image-01 生成一张图并保存；返回 (是否成功, 说明)。"""
    body = json.dumps({
        "model": "image-01",
        "prompt": prompt,
        "aspect_ratio": "1:1",
        "response_format": "base64",
        "n": 1,
        "prompt_optimizer": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"

    # 审核失败 / 其他错误码
    base_resp = payload.get("base_resp") or {}
    if base_resp.get("status_code", 0) != 0:
        return False, f"API error: {base_resp}"
    images = (payload.get("data") or {}).get("image_base64") or []
    if not images:
        return False, f"响应中无图片: {str(payload)[:300]}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(base64.b64decode(images[0]))
    return True, "ok"


def next_index(persona_lower):
    """已有候选的最大序号 +1，保证追加批次不覆盖旧图。"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    idx = 0
    for p in OUT_DIR.glob(f"{persona_lower}_*.png"):
        try:
            idx = max(idx, int(p.stem.rsplit("_", 1)[1]))
        except ValueError:
            pass
    return idx + 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="MiniMax image-01 批量生成 16 人格概念候选图")
    ap.add_argument("personas", nargs="*", help="人格代码（如 INTJ INTP）；配合 --all 生成全部")
    ap.add_argument("--all", action="store_true", help="生成全部 16 只")
    ap.add_argument("--n", type=int, default=1, help="每只生成几张（默认 1）")
    args = ap.parse_args(argv)

    codes = list(PERSONAS) if args.all else [c.upper() for c in args.personas]
    if not codes:
        ap.error("请指定人格代码或 --all")

    token = load_token()
    total_ok, total_fail = 0, 0
    for code in codes:
        if code not in PERSONAS:
            print(f"[{code}] 未知人格，跳过")
            continue
        _name, animal, _hex, clothes = PERSONAS[code]
        prompt = PROMPT_TEMPLATE.format(animal=animal, clothes=clothes)
        start = next_index(code.lower())
        for i in range(start, start + args.n):
            out = OUT_DIR / f"{code.lower()}_{i}.png"
            ok, msg = generate_one(token, prompt, out)
            if ok:
                total_ok += 1
                print(f"[{code}] {out.name} 生成成功")
            else:
                total_fail += 1
                print(f"[{code}] 生成失败：{msg}")
            time.sleep(1)  # 温和限速，避免触发频次限制
    print(f"完成：成功 {total_ok}，失败 {total_fail}")
    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
