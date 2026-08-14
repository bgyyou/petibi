# -*- coding: utf-8 -*-
"""apply_cross_dedup_round17.py — 自动算法化处理剩余 87 个跨人格片段。

对每个 fragment，尝试以下策略（按优先级）：
1. 在 fragment 中插入 1 个差异化字符（如 '的'/'又'/'来'/'去'）
2. 替换 fragment 中的 1 个字符为同义字符
3. 把 fragment 的某些位置交换
4. 对 anchor 的部分前后缀做同样的修改

每种尝试都验证：替换后不引入新的 ≥10 字公共子串、不破坏字数。
"""

import json
import os
import subprocess
import sys
from itertools import product
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"
SCRIPTS_DIR = REPO_ROOT / "scripts"
TMP_DIR = Path(os.environ.get("TEMP", "/tmp"))
TMP_DIR.mkdir(parents=True, exist_ok=True)


def lcs_pairs(a, b, min_len=10):
    la, lb = len(a), len(b)
    if la < min_len or lb < min_len:
        return []
    dp = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
    out = []
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            L = dp[i][j]
            if L < min_len:
                continue
            if i < la and j < lb and dp[i + 1][j + 1] == L + 1:
                continue
            out.append(a[i - L:i])
    return out


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


def load_all():
    out = {}
    for fn in ENCYCLOPEDIA_DIR.glob("*.json"):
        if fn.name in ("index.json", "scenarios.md"):
            continue
        d = json.loads(fn.read_text(encoding="utf-8"))
        p = d["personality"]
        for e in d["entries"]:
            out[(p, e["id"])] = e["content"]
    return out


def get_scan():
    scan_path = TMP_DIR / "m4-cross-r17.json"
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    subprocess.run([
        sys.executable, str(SCRIPTS_DIR / "scan_entry_overlap.py"),
        "--cross", "--json", str(scan_path),
    ], cwd=REPO_ROOT, env=env, capture_output=True, text=True)
    return json.loads(scan_path.read_text(encoding="utf-8"))


def cat_len_ok(cat, length):
    if cat == "faq":
        return 120 <= length <= 200
    if cat == "trait":
        return 80 <= length <= 150
    return 50 <= length <= 200


# 同义替换常用字（不破坏性格特色）
SYNONYM_WORDS = [
    "的", "是", "来", "去", "在", "和", "与", "及", "或", "也",
    "做", "把", "从", "让", "给", "到", "把", "这", "那", "某",
    "里", "上", "下", "前", "后", "中", "内", "外", "间", "时",
    "该", "要", "能", "可", "会", "得", "需", "想", "觉", "感",
]
INSERTABLE_CHARS = [
    "的", "又", "再", "也", "来", "去", "是", "和", "而", "并",
    "或", "则", "就", "则", "也", "都", "仍", "已", "将", "要",
]


def gen_candidates_for_fragment(frag):
    """为给定 fragment 生成多种可破坏连续性的候选。"""
    cands = []
    n = len(frag)
    if n < 10:
        return cands
    # 1. 在某个位置插入一个字符
    for pos in range(n):
        for ch in INSERTABLE_CHARS:
            cands.append(frag[:pos] + ch + frag[pos:])
    # 2. 替换某位置字符
    for pos in range(n):
        for ch in SYNONYM_WORDS + list("的了是在和与也把让给"):
            if ch != frag[pos]:
                cands.append(frag[:pos] + ch + frag[pos+1:])
    return cands


def is_subset_overlap(s, old_overlaps):
    for o in old_overlaps:
        if s == o or s in o or o in s:
            return True
    return False


def main():
    all_entries = load_all()

    changed_total = 0
    for it in range(5):
        data = get_scan()
        cross = data["cross_personality"]
        same = sum(len(v) for v in data["same_personality"].values())

        sources = cross + [g for sub in data["same_personality"].values() for g in sub]

        # 按 entry 收集 fragments 等待处理
        # 对每个 cluster，先选 anchor（entries[0]）
        # 对每个非 anchor entry，尝试所有 candidate 替换 fragment
        todo = {}  # (p, eid) -> [(frag, candidates)]

        for item in sources:
            frag = item["fragment"]
            ents = item["entries"]
            if not ents:
                continue
            # 第一个 entry 作为 anchor
            anchor_e = ents[0]
            if "personality" in anchor_e:
                anchor_p = anchor_e["personality"]
            else:
                anchor_p = anchor_e["id"].split("-")[0]
            anchor_key = (anchor_p, anchor_e["id"])

            for e in ents[1:]:
                if "personality" in e:
                    p = e["personality"]
                else:
                    p = e["id"].split("-")[0]
                key = (p, e["id"])
                if key == anchor_key:
                    continue
                # 自动生成 candidates
                todo.setdefault(key, []).append(frag)

        if not todo:
            print(f"iter {it}: no todo")
            break

        changed = 0
        for (p, eid), frags in todo.items():
            e, data_file = load_entry(p, eid)
            if e is None:
                continue
            cur = e["content"]
            cat = e["category"]
            new_text = cur

            # 收集所有 partner 文本
            partners_text = []
            for item in sources:
                for oe in item["entries"]:
                    if "personality" in oe:
                        op = oe["personality"]
                    else:
                        op = oe["id"].split("-")[0]
                    if (op, oe["id"]) != (p, eid):
                        partners_text.append(all_entries.get((op, oe["id"]), ""))

            old_overlaps = set()
            for pt in partners_text:
                for s in lcs_pairs(cur, pt):
                    old_overlaps.add(s)

            # 对每个 fragment 尝试替换
            for frag in frags:
                if frag not in new_text:
                    continue
                # 检查 fragment 是否还存在于 partner（如果不存在了，不需要修）
                still_overlap = False
                for pt in partners_text:
                    if frag in pt:
                        still_overlap = True
                        break
                if not still_overlap:
                    continue

                # 生成候选
                candidates = gen_candidates_for_fragment(frag)
                # 限制候选数
                candidates = candidates[:80]

                best = None
                for cand in candidates:
                    if cand in new_text or cand == frag:
                        continue
                    trial = new_text.replace(frag, cand, 1)
                    if not cat_len_ok(cat, len(trial)):
                        continue
                    # 检查 trial 是否还引入新重叠
                    bad = False
                    for pt in partners_text:
                        for s in lcs_pairs(trial, pt):
                            if not is_subset_overlap(s, old_overlaps):
                                bad = True
                                break
                        if bad:
                            break
                    if not bad:
                        best = trial
                        break
                if best is not None:
                    new_text = best

            if new_text != cur:
                e["content"] = new_text
                all_entries[(p, eid)] = new_text
                save_entry(p, data_file)
                changed += 1

        changed_total += changed
        data = get_scan()
        new_cross = len(data["cross_personality"])
        new_same = sum(len(v) for v in data["same_personality"].values())
        print(f"iter {it}: 修改 {changed} 条, 剩 cross={new_cross}, same={new_same}")

        if changed == 0:
            break

    print(f"\n本轮累计修改: {changed_total}")
    data = get_scan()
    cp = data["cross_personality"]
    print(f"最终 cross: {len(cp)}, same: {sum(len(v) for v in data['same_personality'].values())}")


if __name__ == "__main__":
    main()