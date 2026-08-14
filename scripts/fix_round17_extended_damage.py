# -*- coding: utf-8 -*-
"""fix_round17_extended_damage.py — 清理 round 17 残留的重复字串损伤。"""

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"


def load_entry(p, eid):
    fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
    data = json.loads(fpath.read_text(encoding="utf-8"))
    for e in data["entries"]:
        if e["id"] == eid:
            return e, data
    return None, None


def save_entry(p, data):
    fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
    fpath.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def fix_damage(text):
    """清理重复字串 — round 17 把同一字连续插入多次。"""
    # 找出连续重复的字
    while True:
        new = re.sub(r'(.)\1{2,}', r'\1\1', text)
        # 不要过度清理；如果已经只剩 2 个就保留
        if new == text:
            break
        text = new
    # 但要小心：保留正常重复（如"呵呵"）
    # 实际上 round 17 模式是同字连续 ≥ 3 次
    # 上面已经把 ≥3 个压成 2 个；现在再把 2 个压成 1 个？ 不行，2 个是合法
    return text


# 已知损伤位置
DAMAGE_FIXES = {
    ("ESTP", "ESTP-faq-decision"): (
        "事项事项事项事项事项事项事项事项事",
        "事项"
    ),
    ("ISFP", "ISFP-faq-criticism"): (
        "ISFP的又 听到批评后容易把一句的否定扩大为『我就是这样的人』——Fi 视角的本整体判定模式",
        "ISFP 听到批评后容易把一句否定扩大为『我就是这样的人』——Fi 视角的整体判定模式"
    ),
    ("ISFP", "ISFP-faq-conflict"): (
        "ISFP 在冲突当下都沉默——Fi 的本能本能是把感受封起来，Se 又把对方的表情逐字存档等『合适的时机』再说。过几天才反刍出想说的话，但通的常已经错过了最好的时点。重要争执前把核的心想说的写下来带身上——落笔也算作数，把感受变成外部证据。",
        "ISFP 在冲突当下会沉默——Fi 的保护本能是把感受封起来，Se 又把对方的表情逐字存档等合适的时机再说。过几天才反刍出想说的话，但常常已经错过了最好的时点。重要争执前把核心想说的写下带身上——落笔也算数，把感受变成外部证据。"
    ),
}


def main():
    changed = 0
    for (p, eid), (old, new) in DAMAGE_FIXES.items():
        e, data_file = load_entry(p, eid)
        if e is None:
            continue
        if old not in e["content"]:
            print(f"NOT FOUND: {p}/{eid}")
            continue
        e["content"] = e["content"].replace(old, new)
        save_entry(p, data_file)
        changed += 1
        print(f"FIXED: {p}/{eid} (len now {len(e['content'])})")

    # 通用清理：寻找所有有 "事项事项事项" 之类的
    for fn in ENCYCLOPEDIA_DIR.glob("*.json"):
        if fn.name in ("index.json", "scenarios.md"):
            continue
        data = json.loads(fn.read_text(encoding="utf-8"))
        p = data["personality"]
        file_changed = False
        for e in data["entries"]:
            cur = e["content"]
            # 找连续重复字 ≥3 次
            new = re.sub(r'(.)\1{2,}', r'\1\1', cur)
            if new != cur:
                e["content"] = new
                file_changed = True
                changed += 1
                print(f"GENERAL FIX: {p}/{e['id']}")
        if file_changed:
            save_entry(p, data)

    # 二次清理：把上面留下的"不够够"等小损伤再清一次
    for fn in ENCYCLOPEDIA_DIR.glob("*.json"):
        if fn.name in ("index.json", "scenarios.md"):
            continue
        data = json.loads(fn.read_text(encoding="utf-8"))
        p = data["personality"]
        file_changed = False
        for e in data["entries"]:
            cur = e["content"]
            # '不够够' -> '不够', '大事项' -> '大事'
            new = cur
            new = new.replace("不够够", "不够")
            new = new.replace("大事项", "大事")
            new = new.replace("本能本能", "本能")
            new = new.replace("的的又又", "")
            new = new.replace("的的", "")
            new = new.replace("本整体", "整体")
            if new != cur:
                e["content"] = new
                file_changed = True
                changed += 1
                print(f"EXTRA FIX: {p}/{e['id']}")
        if file_changed:
            save_entry(p, data)

    print(f"\n修改 {changed} 条")


if __name__ == "__main__":
    main()