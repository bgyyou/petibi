# -*- coding: utf-8 -*-
"""
scan_entry_overlap.py — 扫描 data/encyclopedia/ 下 16 人格 JSON 的**全类目**条目重复句段

背景：
  上一轮（scan_faq_tails.py）只清理了 faq 类的"补全尾巴"。owner 实测发现
  trait / strength / weakness / career / relationship / cognitive 类同样存在
  跨条目复用的模板句（例如 ENFJ 的"被人需要时会更有动力"在 3 条 trait 里出现）。

功能：
  1. 加载 16 个 <personality>.json 的**全部** entries（6 类 + faq）；
  2. 同人格内两两比对 content，找出所有长度 ≥ MIN_LEN（默认 10）的**公共子串**
     （极大公共子串，不是仅后缀，能抓到嵌在中间的模板句）；
  3. 按"重复片段"聚类输出：片段文本 + 涉及的条目 id/category/title；
  4. 跨人格抽查：统计任意两人格间 ≥ MIN_LEN 的公共子串（识别全库万能句）。

用法：
  python scripts/scan_entry_overlap.py                    # 全量扫描
  python scripts/scan_entry_overlap.py --min-len 10       # 自定义阈值
  python scripts/scan_entry_overlap.py --personality ENFJ # 只看某个人格
  python scripts/scan_entry_overlap.py --cross            # 附带跨人格扫描
  python scripts/scan_entry_overlap.py --json out.json    # 结果写盘

退出码：
  0 = 同人格内无 ≥MIN_LEN 重复片段；1 = 仍有重复（可用于 CI 卡口）。
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"

PERSONALITIES = [
    "INTJ", "INTP", "ENTJ", "ENTP",
    "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ESTJ", "ESFJ",
    "ISTP", "ISFP", "ESTP", "ESFP",
]

CATEGORIES = ["trait", "cognitive", "strength", "weakness", "career", "relationship", "faq"]


def load_personality(p):
    """读取单个人格文件，返回 (data, entries)。缺文件返回 (None, [])。"""
    fpath = ENCYCLOPEDIA_DIR / f"{p.lower()}.json"
    if not fpath.exists():
        return None, []
    data = json.loads(fpath.read_text(encoding="utf-8"))
    return data, data.get("entries", [])


def common_substrings(a, b, min_len):
    """返回 a、b 的所有**极大**公共子串（长度 ≥ min_len）集合。

    经典 DP：dp[i][j] = 以 a[i-1]、b[j-1] 结尾的公共后缀长度。
    只在"无法再向右延伸"（即 dp[i+1][j+1] 不接续）时收集，避免同一段落
    被切成一堆子片段。content 长度 ≤200，16×25 条目量级下开销可忽略。
    """
    la, lb = len(a), len(b)
    if la < min_len or lb < min_len:
        return set()
    prev = [0] * (lb + 1)
    # 记录每个 (i,j) 的 dp 值以判断是否可延伸
    dp = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
    del prev
    out = set()
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            L = dp[i][j]
            if L < min_len:
                continue
            # 极大性：右侧不可延伸
            if i < la and j < lb and dp[i + 1][j + 1] == L + 1:
                continue
            out.add(a[i - L:i])
    return out


def scan_personality(p, entries, min_len):
    """同人格内两两比对，返回 {片段: [(id, category, title), ...]}。"""
    frag_to_entries = defaultdict(set)
    n = len(entries)
    for i in range(n):
        for j in range(i + 1, n):
            e1, e2 = entries[i], entries[j]
            frags = common_substrings(e1.get("content", ""), e2.get("content", ""), min_len)
            for f in frags:
                frag_to_entries[f].add((e1["id"], e1["category"], e1["title"]))
                frag_to_entries[f].add((e2["id"], e2["category"], e2["title"]))
    # 去掉被更长片段完全包含、且涉及条目集合相同的短片段（降噪）
    frags = sorted(frag_to_entries, key=len, reverse=True)
    dropped = set()
    for idx, f in enumerate(frags):
        if f in dropped:
            continue
        for g in frags[idx + 1:]:
            if g in dropped or g == f:
                continue
            if g in f and frag_to_entries[g] == frag_to_entries[f]:
                dropped.add(g)
    return {f: sorted(v) for f, v in frag_to_entries.items() if f not in dropped}


def scan_cross(all_entries, min_len):
    """跨人格扫描：返回 [(片段, [(personality, id), ...]), ...]，按涉及人格数降序。

    实现用 min_len 长度的 n-gram 索引（O(总字数)），而不是两两 DP：
    任意两条内容若共享 ≥min_len 的连续片段，必然共享至少一个 min_len-gram，
    所以这个索引不会漏报；相邻 n-gram 会被合并回极大片段再输出。
    """
    gram_map = defaultdict(set)  # gram -> {(personality, id)}
    for p, entries in all_entries.items():
        for e in entries:
            c = e.get("content", "")
            for i in range(len(c) - min_len + 1):
                gram_map[c[i:i + min_len]].add((p, e["id"]))
    # 只保留跨人格的 gram
    cross = {g: v for g, v in gram_map.items() if len({p for p, _ in v}) >= 2}
    # 合并可延伸的相邻 gram：若 g[1:] + x 也是跨 gram 且条目集合相同，则 g 被吸收
    absorbed = set()
    for g, v in cross.items():
        for g2, v2 in cross.items():
            if g2 is g:
                continue
            if g2[:-1] == g[1:] and v2 == v:
                absorbed.add(g)
                break
    rows = [(g, sorted(v)) for g, v in cross.items() if g not in absorbed]
    rows.sort(key=lambda x: (-len({p for p, _ in x[1]}), -len(x[0])))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-len", type=int, default=10, help="判定为重复的最小字符数（默认 10）")
    ap.add_argument("--personality", default=None, help="只扫描指定人格（如 ENFJ）")
    ap.add_argument("--cross", action="store_true", help="附加跨人格扫描")
    ap.add_argument("--json", dest="json_out", default=None, help="把结果写入 JSON 文件")
    args = ap.parse_args()

    targets = [args.personality.upper()] if args.personality else PERSONALITIES

    print("=== scan_entry_overlap.py 报告（全类目同人格重复句段）===")
    print(f"扫描目录：{ENCYCLOPEDIA_DIR}")
    print(f"阈值：公共子串长度 ≥ {args.min_len} 字\n")

    all_entries = {}
    total_frags = 0
    total_hits = 0
    per_p_summary = []
    result = {}

    for p in targets:
        data, entries = load_personality(p)
        if data is None:
            print(f"WARN: 缺失 {p}.json")
            continue
        all_entries[p] = entries
        frag_map = scan_personality(p, entries, args.min_len)
        cat_count = defaultdict(int)
        for e in entries:
            cat_count[e["category"]] += 1
        print("=" * 70)
        print(f"[{p}]  条目 {len(entries)} 条  {dict(cat_count)}")
        print(f"       重复片段（≥{args.min_len} 字）：{len(frag_map)} 个")
        rows = sorted(frag_map.items(), key=lambda kv: (-len(kv[1]), -len(kv[0])))
        result[p] = []
        for frag, ents in rows:
            total_frags += 1
            total_hits += len(ents)
            print(f"  · [{len(frag)}字 × {len(ents)}条] 「{frag}」")
            for eid, cat, title in ents:
                print(f"        - {eid}  ({cat})  {title}")
            result[p].append({
                "fragment": frag,
                "length": len(frag),
                "entries": [{"id": a, "category": b, "title": c} for a, b, c in ents],
            })
        if not rows:
            print("       ✓ 无重复")
        per_p_summary.append((p, len(entries), len(frag_map)))

    print("\n" + "=" * 70)
    print("【汇总】各人格重复片段数")
    print("=" * 70)
    for p, n_e, n_f in per_p_summary:
        flag = "OK " if n_f == 0 else "DUP"
        print(f"  {flag}  {p}: 条目 {n_e}  重复片段 {n_f}")
    print(f"\n全库重复片段总数：{total_frags}（涉及条目引用 {total_hits} 次）")

    cross_rows = []
    if args.cross:
        print("\n" + "=" * 70)
        print(f"【跨人格抽查】任意两人格间公共子串 ≥ {args.min_len} 字")
        print("=" * 70)
        cross_rows = scan_cross(all_entries, args.min_len)
        print(f"共 {len(cross_rows)} 个跨人格重复片段。Top 30：")
        for frag, ents in cross_rows[:30]:
            ps = sorted({p for p, _ in ents})
            print(f"  · [{len(frag)}字 / {len(ps)}人格] 「{frag}」 → {','.join(ps)}")

    if args.json_out:
        payload = {
            "min_len": args.min_len,
            "same_personality": result,
            "cross_personality": [
                {"fragment": f, "entries": [{"personality": p, "id": i} for p, i in v]}
                for f, v in cross_rows
            ],
        }
        Path(args.json_out).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n已写入 {args.json_out}")

    return 0 if total_frags == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
