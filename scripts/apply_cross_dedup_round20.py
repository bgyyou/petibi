# -*- coding: utf-8 -*-
"""apply_cross_dedup_round20.py — 对剩余 23 个顽固 overlap 做完整内容改写。

策略：针对每对 entry，写一条完全不同的 content，长度合规且无新重叠。
"""

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


# 完全重写表
REWRITES = {
    # === 1. ESFP/ESTP/ISFP weakness-01 (3 完全相同) ===
    ("ESFP", "ESFP-weakness-01"):
        "ESFP 在长期目标上常被『当下爽不爽』绑架——Se 的现场快感比未来收益更有说服力。给自己一份『6 个月后的事』清单，按周推一步；爽的当下很诱人，但 6 个月后的爽是累计的。",
    ("ESTP", "ESTP-weakness-01"):
        "ESTP 倾向先做再说——Se 的现场冲动常跑在长期规划前面。给自己一份季度清单，先把要做的三件事写下来，每完成一项才允许开新；行动型人格的最大风险是没想就动，把季度清单当锚点。",
    ("ISFP", "ISFP-weakness-01"):
        "ISFP 在长期安排上常走『船到桥头自然直』路线——但有些事过了桥就来不及。给自己一份『不可推迟清单』，按月标注截止；Fi 的现场审美和 Se 的当下触感会帮你做好眼前事，但桥有时不会等你。",
    # === 2. INTP-ISTP cognitive-01 ===
    ("ISTP", "ISTP-cognitive-01"):
        "ISTP 一切结论都得通过自己内部一致性检验——Ti 是不可绕过的关卡。习惯先用第一性原理跑一遍再听外部意见，先验证再引用，结论才稳。",
    # === 3. ENFP-ENTP strength-01 ===
    ("ENTP", "ENTP-strength-01"):
        "ENTP 在需要新方案的场合（产品定位、创意提案、破局），能快速抛出多个反向角度——Ne 抓可能性、Ti 做底层检验。",
    # === 4-5. ENTP-ESTP decision (2 frags) ===
    ("ESTP", "ESTP-faq-decision"):
        "ESTP 在大事面前会觉得选 A 就锁死了 B 的门——Se 总在抓所有可见的选项。承认一个真相：成年人选 A 是为了在 A 上拿到足够硬的东西，B 没那么可惜。把决策看成收口，深度比广度更划算。",
    # === 6. ENTP-ESTP social-drain ===
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 社交本来充电不耗电——但前提得是有新冲击。重复寒暄、低信息量聚会也耗电：Se 缺乏新素材可接、Ti 没有新观点可辩就空转。选高质量社交而非逢邀必到——Se 主导者最怕低信息量，把时间留给能 push 你的人。",
    # === 7. ESFP-INFJ content creator ===
    ("INFJ", "INFJ-strength-03"):
        "INFJ 擅长把复杂的内心感受组织成清晰有温度的文字——是天然的内容生产者。Ni 抓核心、Fe 抓温度，组合跑出来是别人模仿不来的笔触。",
    # === 8. INFJ-ISFP breakup ===
    ("ISFP", "ISFP-faq-breakup"):
        "ISFP 分手后容易把前任符号化为『唯一的灵魂伴侣』，Fi 的高强度铭刻把过去的细节全部存档，Se 又在每次路过某些地方时把它们调出来。承认心动真实，但神化会挡住后面的可能性。把前任从神坛上撤下来——铭刻越深越要主动把光从过去切回现在。",
    # === 9. ESFP-INFP weakness-03 ===
    ("INFP", "INFP-weakness-01"):
        "被强烈情绪裹挟时会做出事后后悔的决定——要识别『我现在情绪上头』的信号，重大决策不在这时候做。情绪里做的决定常常是替情绪买单，不替未来的你。",
    # === 10. INFP-ISFP weakness-02 ===
    ("ISFP", "ISFP-weakness-02"):
        "为了不破坏关系把不满咽回去，长期变成隐性怨气——要学会把不满显性化。给 Fi 一个定期出口：每周写一次『本周不爽清单』，写完不一定给谁看，但必须落地。",
    # === 11. INFP-ISFJ career ===
    ("ISFJ", "ISFJ-career-01"):
        "如护士、教师、HR；适合一对一深度陪伴和支持——Si + Fe 在稳定结构里最稳。能在熟悉的流程里持续输出体贴，是 ISFJ 的职业底色。",
    # === 12-13. INFP-ISFP faq-conflict ===
    ("ISFP", "ISFP-faq-conflict"):
        "ISFP 在冲突当下会沉默——Fi 的保护本能是把感受封起来，Se 又把对方的表情逐字存档等合适的时机再说。过几天才反刍出想说的话，但常常已经错过了最好的时点。重要争执前把核心想说的写下带身上——落笔也算数，把感受变成外部证据。",
    # === 14. INFP-ISFP criticism ===
    ("ISFP", "ISFP-faq-criticism"):
        "ISFP 听到批评后容易把一句否定扩大为『我就是这样的人』——Fi 视角的整体判定模式，Se 又把当时的表情语气逐字存档当证据。区分『行为与身份』：分歧指向行为，并非指向你这个人。把感受从事后自证切到事前可改——身份不动，行为能改。批评拆成两部分：事实认账、语气可不接收。",
    # === 15. ENFP-ESFP cognitive-02 ===
    ("ESFP", "ESFP-cognitive-02"):
        "所有选择都先过一遍内心价值尺——不符合的不干。Fi 给出底层标准，Se 给出当下体感，组合起来 ESFP 的『做不做』常常已经过滤过一遍。",
    # === 16. ENFP-ESFP public-speaking ===
    ("ESFP", "ESFP-faq-public-speaking"):
        "ESFP 在讲台前一概不怯场——气氛越热烈越兴奋，Se 在现场能拿满档刺激。但想法比嘴快半拍——现场气氛一上去，Se 会跑去接观众的笑声而忘了主线。提前列好三个要点，请人在第 25 与 50 分钟举牌提醒——三个要点 + 举牌是把 Se 关进结构里的硬工具，别让『好看』盖过『讲清』。",
    # === 17. ESFJ-ISTJ career-02 ===
    ("ISTJ", "ISTJ-career-02"):
        "如行政主管、运营经理；适合在稳定结构里把日常事务管得有条不紊——Si 的标准让流程稳，Te 的效率让结果可控。",
    # === 18. ESTJ-ISTJ relationship-01 ===
    ("ISTJ", "ISTJ-relationship-01"):
        "ISTJ 不是浪漫型而是陪伴型，能把『我爱你』转化为 30 年的早餐和账单按时付清。Si 的稳定本身就是长情——能走到底的伴侣是懂得珍惜这些细节的人。",
    # === 19. ESFJ-ESTJ career-02 ===
    ("ESTJ", "ESTJ-career-02"):
        "如公务员、政策执行、合规管理；适合稳定结构里的执行——Si 让你把流程守得死，Te 让你把目标推到极致。",
    # === 20. ESFP-ISTP weakness ===
    ("ISTP", "ISTP-weakness-03"):
        "对重复无聊的事本能抗拒，频繁换工作换方向——Se 想要新冲击。给自己一份『半年不动』的承诺，把新刺激压在内部项目里。",
    # === 21-22. ESFP-ESTP strength (2 frags) ===
    ("ESTP", "ESTP-strength-03"):
        "能把当下过得精彩，是聚会里的发动机——Se 的现场感天然带节奏。Ti 的快速判断让 ESTP 在群体里成为话题的引爆点。",
    # === 23. ESFP-ESTP weakness ===
    ("ESFP", "ESFP-weakness-01"): None,  # already above
}


def main():
    all_entries = load_all()
    changed = 0
    skipped = []

    for (p, eid), new_content in REWRITES.items():
        if new_content is None:
            continue
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
        # 检查新内容无 ≥10 字公共子串
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
        for s in skipped[:25]:
            print(f"  {s}")

    # 重新扫描
    scan_path = TMP_DIR / "m4-cross-r20.json"
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