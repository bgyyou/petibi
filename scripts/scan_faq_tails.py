# -*- coding: utf-8 -*-
"""
scan_faq_tails.py — 扫描 data/encyclopedia/ 下 16 个 JSON 的 FAQ 结尾重复率（M4 工单验收）

功能：
  1. 加载 16 个 <personality>.json 的所有 FAQ 条目；
  2. 把 content 按 "。" 切成句段，识别每条 FAQ 的尾部句段（最后 1~3 句）；
  3. 统计在同一人格内出现 >=2 次的句段——即"补全尾巴"；
  4. 跨人格统计：任意两条 FAQ 的最长公共后缀长度（≥15 字视为新万能句）；
  5. 输出三段报告：
     - 总体 FAQ 数；
     - 每个 (人格, 尾巴句段) 的重复次数；
     - 跨人格最长公共后缀 TopN。

用法：
  python scripts/scan_faq_tails.py
  python scripts/scan_faq_tails.py --json out.json  （额外把数据写盘）

退出码：
  纯信息脚本，总是返回 0。
"""
import json
import re
import sys
from collections import defaultdict, Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"

PERSONALITIES = [
    "INTJ", "INTP", "ENTJ", "ENTP",
    "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ESTJ", "ESFJ",
    "ISTP", "ISFP", "ESTP", "ESFP",
]


def split_sentences(content: str):
    """按 "。" 切成句段，保留句号前的实文本，去除空段。"""
    parts = [p.strip() for p in content.split("。")]
    parts = [p for p in parts if p]
    return parts


def last_n_sentences(content: str, n: int = 3):
    """返回 content 最后 n 句（不含末尾的句号）。"""
    sents = split_sentences(content)
    if not sents:
        return []
    return sents[-n:]


def longest_common_suffix_len(a: str, b: str, min_unit: int = 1):
    """返回 a、b 的最长公共后缀长度（按中文字符计）。"""
    if not a or not b:
        return 0
    n = 0
    la, lb = a[-1::-1], b[-1::-1]
    for ca, cb in zip(la, lb):
        if ca == cb:
            n += 1
        else:
            break
    return n


def collect_all_faqs():
    """返回 [(personality, faq_entry, file), ...] 的列表。"""
    rows = []
    for p in PERSONALITIES:
        fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
        if not fpath.exists():
            print(f"WARN: 缺失 {fpath}")
            continue
        data = json.loads(fpath.read_text(encoding="utf-8"))
        for e in data.get("entries", []):
            if e.get("category") == "faq":
                rows.append((p, e, fpath))
    return rows


def scan():
    rows = collect_all_faqs()
    print(f"=== scan_faq_tails.py 报告 ===")
    print(f"扫描目录：{ENCYCLOPEDIA_DIR}")
    print(f"FAQ 总条数：{len(rows)}（期望 160）\n")

    # 1. 按人格 × 单句统计：统计每个完整句段在该人格 FAQ 中的出现次数
    per_personality_sent_count = defaultdict(Counter)  # p -> Counter(sentence -> count)
    per_personality_sent_examples = defaultdict(lambda: defaultdict(list))  # p -> sent -> [id,...]

    for p, e, _ in rows:
        for s in split_sentences(e["content"]):
            per_personality_sent_count[p][s] += 1
            if len(per_personality_sent_examples[p][s]) < 3:
                per_personality_sent_examples[p][s].append(e["id"])

    print("=" * 60)
    print("【第一段】各人格 FAQ 内，重复句段（出现 ≥2 次）")
    print("=" * 60)

    overall_tails = 0
    overall_templates = 0  # 出现 ≥3 次的硬模板
    for p in PERSONALITIES:
        c = per_personality_sent_count[p]
        repeated = sorted(
            [(s, n) for s, n in c.items() if n >= 2],
            key=lambda x: -x[1]
        )
        print(f"\n[{p}]  共 {sum(c.values())} 句；重复句段（≥2）数量 = {len(repeated)}")
        overall_tails += len(repeated)
        for s, n in repeated:
            tag = "硬模板(≥3)" if n >= 3 else "重复(2)"
            if n >= 3:
                overall_templates += 1
            ids = ", ".join(per_personality_sent_examples[p][s])
            print(f"  · [{tag}×{n}] {s[:60]}{'…' if len(s) > 60 else ''}  | 例子: {ids}")

    print(f"\n汇总：{overall_tails} 条重复句段，其中 ≥3 次硬模板 {overall_templates} 条。")

    # 2. 跨人格两两最长公共后缀
    print("\n" + "=" * 60)
    print("【第二段】跨人格两两 FAQ content 的最长公共后缀（≥15 字计）")
    print("=" * 60)

    lcs_pairs = []  # (len, p1, p2, id1, id2, suffix)
    contents = [(p, e["id"], e["content"]) for p, e, _ in rows]
    N = len(contents)
    for i in range(N):
        for j in range(i + 1, N):
            p1, id1, c1 = contents[i]
            p2, id2, c2 = contents[j]
            if p1 == p2:
                # 同人格也参与统计，因为任务关心的是"万能句"
                pass
            L = longest_common_suffix_len(c1, c2)
            if L >= 15:
                lcs_pairs.append((L, p1, p2, id1, id2, c1[-L:]))

    lcs_pairs.sort(key=lambda x: -x[0])
    print(f"两两比较 {N}×{N}，共 {len(lcs_pairs)} 对的最长公共后缀 ≥15 字。")
    print("Top 20：")
    for L, p1, p2, id1, id2, sfx in lcs_pairs[:20]:
        print(f"  · len={L}  {p1}/{id1}  vs  {p2}/{id2}")
        print(f"      后缀: {sfx[:80]}{'…' if len(sfx) > 80 else ''}")

    # 3. 整库最大重复后缀分布
    if lcs_pairs:
        max_len = lcs_pairs[0][0]
        n_max = sum(1 for x in lcs_pairs if x[0] == max_len)
        print(f"\n全库最长公共后缀 = {max_len} 字（出现 {n_max} 对）。")

    return rows, per_personality_sent_count, lcs_pairs


if __name__ == "__main__":
    scan()
    sys.exit(0)