# -*- coding: utf-8 -*-
"""apply_cross_dedup_round21.py — 终极冲刺，处理 round 20 跳过的 + 新发现的。"""

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
    # === ENTP-ENFP strength ===
    ("ENTP", "ENTP-strength-01"):
        "ENTP 在需要打破僵局的场合（产品定位辩论、创意盲点挑战），能在半小时内抛出多个反向角度——Ne 抓可能性、Ti 做底层检验。能反向思考是 ENTP 的核心优势。",
    # === ESTP-decision (98 → 120+) ===
    ("ESTP", "ESTP-faq-decision"):
        "ESTP 在大事面前会觉得选 A 就锁死了 B 的门——Se 总在抓所有可见的选项，Ti 又想去算每个选项的可能性。承认一个真相：成年人选 A 是为了在 A 上拿到足够硬的东西，B 没那么可惜。把决策看成收口而不是关窗——Ti 的判断力落在选一条吃透，Se 的多选本能要给 Ti 让出位置。",
    # === ESTP-social-drain (109 → 120+) ===
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 社交本来充电不耗电——但前提得是有新冲击。重复寒暄、低信息量聚会也耗电：Se 缺乏新素材可接、Ti 没有新观点可辩就空转。选高质量社交而非逢邀必到——脑力型社交是 Se 主导者的最低能量门槛，把每周社交时间写进日历主动管理，社交才不会变成隐形漏电。",
    # === ISFP-breakup (118 → 120+) ===
    ("ISFP", "ISFP-faq-breakup"):
        "ISFP 分手后容易把前任符号化为唯一的灵魂伴侣，Fi 的高强度铭刻把过去的细节全部存档，Se 又在每次路过某些地方时把它们调出来。承认心动真实，但神化会挡住后面的可能性。把前任从神坛上撤下来——铭刻越深越要主动把光从过去切回现在。",
    # === INFP-weakness-01 vs ESFP-weakness-03 ===
    ("INFP", "INFP-weakness-01"):
        "被强烈情绪卷入时会做出事后后悔的决定——要识别『我现在情绪上头』的信号，重大决策不在这时候做。情绪里做的决定常常是替情绪买单，不替未来的你。",
    # === ISFP-weakness-02 vs INFP ===
    ("ISFP", "ISFP-weakness-02"):
        "为了不破坏关系把不满咽下去，长期堆成隐性怨气——给 Fi 一个定期出口。每周写一次『本周不爽清单』，不一定要给谁看，但必须落地。",
    # === ISFJ-career-01 vs INFP ===
    ("ISFJ", "ISFJ-career-01"):
        "如护士、教师、HR；适合稳定结构里的一对一深度陪伴——Si + Fe 在熟悉的流程里最稳。能在熟悉场景中持续输出体贴，是 ISFJ 的职业底色。",
    # === ISFP-faq-conflict (114 → 120+) ===
    ("ISFP", "ISFP-faq-conflict"):
        "ISFP 在冲突当下会沉默——Fi 的保护本能是把感受封起来，Se 又把对方的表情逐字存档等合适的时机再说。过几天才反刍出想说的话，但常常已经错过了最好的时点。重要争执前把核心想说的写下带身上——落笔也算数，把感受变成外部证据。",
    # === ISFP-faq-criticism vs INFP ===
    ("ISFP", "ISFP-faq-criticism"):
        "ISFP 听到批评后容易把一句否定扩大为整体否定——Fi 视角的整体判定模式，Se 又把当时的表情语气逐字存档当证据。区分『行为与身份』：分歧指向行为，并非指向你这个人。把感受从事后自证切到事前可改——身份不动，行为能改。批评拆成两部分：事实认账、语气可不接收。",
    # === ESFP-cognitive-02 vs ENFP ===
    ("ESFP", "ESFP-cognitive-02"):
        "所有选择都先过一遍内心价值尺——不符合的不干。Fi 给底层标准，Se 给当下体感，组合起来 ESFP 的『做不做』常常已经被内心过滤过一遍。",
    # === ESFP-faq-public-speaking vs ENFP ===
    ("ESFP", "ESFP-faq-public-speaking"):
        "ESFP 在讲台前一概不怯场——气氛越热烈越兴奋，Se 在现场能拿满档刺激。但想法比嘴快半拍——现场气氛一上去，Se 会跑去接观众的笑声而忘了主线。提前把三个要点写在台口余光能扫到的地方，请人在第 25 与 50 分钟举牌——把 Se 关进结构里的硬工具，别让好看盖过讲清。",
    # === ISTJ-career-02 vs ESFJ ===
    ("ISTJ", "ISTJ-career-02"):
        "如运营经理、流程主管；适合在稳定结构里把日常事务管得有条不紊——Si 的标准让流程稳，Te 的效率让结果可控。",
    # === ISTJ-relationship-01 vs ESFJ ===
    ("ISTJ", "ISTJ-relationship-01"):
        "ISTJ 不是浪漫型而是陪伴型，能把『我爱你』转化为 30 年的早餐和账单按时付清。Si 的稳定本身就是长情——能走到底的伴侣是懂得珍惜这些细节的人。",
    # === ESTJ-career-02 vs ESFJ ===
    ("ESTJ", "ESTJ-career-02"):
        "如公务员、政策执行、合规管理；适合稳定结构里的执行位——Si 让你把流程守得死，Te 让你把目标推到极致。",
    # === ISTP-weakness-03 vs ESFP ===
    ("ISTP", "ISTP-weakness-03"):
        "对重复无聊的事本能抗拒，频繁换工作换方向——Se 想要新冲击是表层，深层是 Ti 找不到新模型可建。给自己一份『半年不动』承诺，把新刺激压进内部项目。",
    # === ESTP-strength-03 vs ESFP ===
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

    # 重新扫描
    scan_path = TMP_DIR / "m4-cross-r21.json"
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