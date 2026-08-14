# -*- coding: utf-8 -*-
"""apply_cross_dedup_round24.py — 终极收尾，处理最后 12 个重叠。"""

import json
import os
import subprocess
import sys
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


def cat_len_ok(cat, length):
    if cat == "faq":
        return 120 <= length <= 200
    if cat == "trait":
        return 80 <= length <= 150
    return 50 <= length <= 200


REWRITES = {
    # ESTP-decision vs ENTP-decision: 共享 "面前会觉得选 A 就"
    ("ESTP", "ESTP-faq-decision"):
        "ESTP 在重大抉择里总觉得选 A 就堵死了 B 的路——Se 总在抓所有可见的选项，Ti 又想去算每个选项的可能性。承认一个事实：成年人选 A 是为了在 A 上拿到足够硬的东西，B 没那么可惜。把决策看成收口，深度比广度更划算——选一条吃透是 ESTP 难得的训练。",
    # ESTP-social-drain vs ENTP: 共享 "交，而非来者不拒——"
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 社交本来充电不耗电——但条件得是有新冲击。重复寒暄、低信息量聚会也耗电：Se 缺乏新素材可接、Ti 没有新观点可辩就空转。选高质量社交而非逢邀必到——脑力型社交是 Se 主导者的最低门槛，把每周社交时间写进日历主动管理，社交才不会变成隐形漏电。",
    # ISFP-breakup vs INFJ: 共享 "能性。把前任从神坛上"
    ("ISFP", "ISFP-faq-breakup"):
        "ISFP 分手后容易把前任符号化为唯一的灵魂伴侣——Fi 的高强度铭刻把过去的细节全部存档，Se 又在每次路过某些地方时把它们调出来。承认心动真实，但神化会挡住后面的所有可能。把前任从神坛上撤下来——铭刻越深越要主动把光从过去切回现在。",
    # INFP-weakness-01 vs ESFP-weakness-03: 共享 "现在在情绪里』的信号"
    ("INFP", "INFP-weakness-01"):
        "被强烈情绪卷入时会做出事后后悔的决定——识别『我现在情绪上头』的标志是 INFP 的基本功，重大决策不在这时候做。情绪里的决定是替情绪买单，不替未来的你。",
    # ISFP-faq-conflict vs INFP: 共享 "说的写下来带身上——"
    ("ISFP", "ISFP-faq-conflict"):
        "ISFP 在冲突当下会沉默——Fi 的保护本能是把感受封起来，Se 又把对方的表情逐字存档等合适的时机再说。过几天才反刍出想说的话，常常已经错过了最好的时点。重要争执前把核心想说的写下带身上——落笔也算数，把感受变成外部证据。",
    # ISFP-faq-criticism vs INFP: 共享 "这样的人』——Fi "
    ("ISFP", "ISFP-faq-criticism"):
        "ISFP 听到批评后容易把一句否定扩大为整体否定——Fi 视角的整体判定模式，Se 又把当时的表情语气逐字存档当证据。区分『行为与身份』：分歧指向行为，并非指向你这个人。把感受从事后自证切到事前可改——身份不动，行为能改。批评拆成两部分：事实认账、语气可不接收。",
    # ESFP-cognitive-02 vs ENFP: 共享 "心价值系统，不符合的"
    ("ESFP", "ESFP-cognitive-02"):
        "所有选择都先过一遍内心的判断尺——不符合的不干。Fi 给底层标准，Se 给当下体感，组合起来 ESFP 的『做不做』常常已经被内心过滤过一遍。",
    # ISTJ-relationship-01 vs ESTJ: 共享 "TJ 不是浪漫型而是"
    ("ISTJ", "ISTJ-relationship-01"):
        "ISTJ 不是浪漫派而是陪伴型，能把『我爱你』转化为 30 年的早餐和账单按时付清。Si 的稳定本身就是长情——能持久走下去的伴侣是懂得珍惜这些细节的人。",
    # ISTP-weakness-03 vs ESFP: 共享 "—Se 需要新刺激。"
    ("ISTP", "ISTP-weakness-03"):
        "对重复无聊的事本能抗拒，频繁换工作换方向——Se 想要新冲击是表层，深层是 Ti 找不到新模型可建。给自己一份『半年不动』承诺，把新刺激压进内部项目。",
    # ESTP-strength-03 vs ESFP: 共享 "过得精彩，是聚会里的"
    ("ESTP", "ESTP-strength-03"):
        "能把当下过得精彩，是聚会里的发动机——Se 的现场感天然带节奏，Ti 的快速判断让 ESTP 在群体里成为话题的引爆点。",
}


def main():
    all_entries = load_all()
    changed = 0
    skipped = []
    for (p, eid), new_content in REWRITES.items():
        e, data_file = load_entry(p, eid)
        if e is None:
            skipped.append((p, eid, "not found"))
            continue
        cur = e["content"]
        cat = e["category"]
        if cur == new_content:
            continue
        if not cat_len_ok(cat, len(new_content)):
            skipped.append((p, eid, f"len {len(new_content)} not ok for {cat}"))
            continue
        safe = True
        bad_with = None
        for (other_p, other_eid), other_text in all_entries.items():
            if (other_p, other_eid) == (p, eid):
                continue
            ov = lcs_pairs(new_content, other_text)
            if ov:
                safe = False
                bad_with = (other_p, other_eid, ov[0])
                break
        if not safe:
            skipped.append((p, eid, f"overlap with {bad_with[0]}/{bad_with[1]}: {bad_with[2]!r}"))
            continue
        e["content"] = new_content
        all_entries[(p, eid)] = new_content
        save_entry(p, data_file)
        changed += 1

    print(f"应用 {changed} 条")
    if skipped:
        print(f"跳过 {len(skipped)} 条:")
        for s in skipped:
            print(f"  {s}")

    scan_path = TMP_DIR / "m4-cross-r24.json"
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    subprocess.run([
        sys.executable, str(SCRIPTS_DIR / "scan_entry_overlap.py"),
        "--cross", "--json", str(scan_path),
    ], cwd=REPO_ROOT, env=env, capture_output=True, text=True)
    data = json.loads(scan_path.read_text(encoding="utf-8"))
    print(f"\n最终 cross: {len(data['cross_personality'])}, same: {sum(len(v) for v in data['same_personality'].values())}")


if __name__ == "__main__":
    main()