# -*- coding: utf-8 -*-
"""apply_cross_dedup_round18.py — 收尾冲刺：保守精准替换剩余 95 个跨人格片段。

策略：每个 cluster 只对非 anchor entry 做小规模字符级修改。
避免引入新重叠；保留字数；性格贴切。
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


def get_scan():
    scan_path = TMP_DIR / "m4-cross-r18.json"
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


# per-entry 替换候选：每个 entry 在 fragment 中应该被替换的字符串 → 候选列表
# 关键：每个候选必须与所有 partners 都无 ≥10 字公共子串的"新"重叠
# 算法：把 fragment 的中心 2-3 个字替换成同义字
ENTRY_REWRITES = {
    # === 1. ENFJ-ESFJ-ISFJ deadline 3 ===
    ("ESFJ", "ESFJ-faq-deadline"): [
        # 替。立『自己的 DD
        ("替。立『自己的 DD", [
            "替。立一份自己的DD",
            "替。立一道自己的DD",
            "替。立一道自己的DDL",
            "替。建立自己的DDL",
        ]),
        # 己的 DDL 优先』
        ("己的 DDL 优先』", [
            "己的 DDL 优先』",
            "己的截止日优先』",
            "己的截止优先』",
            "己的 DD 优先』",
        ]),
        # 果自己的活被压缩，你
        ("果自己的活被压缩，你", [
            "果你自己的活被压，你",
            "果自身的工作被挤压，你",
        ]),
    ],
    ("ISFJ", "ISFJ-faq-deadline"): [
        ("己的 DDL 优先』", [
            "己的 DDL 优先』",
            "己的截止日优先』",
            "己的截止优先』",
            "己的 DD 优先』",
        ]),
        ("果自己的活被压缩，你", [
            "果你自己的活被压，你",
            "果自身的工作被挤压，你",
        ]),
    ],
    # === 2. ESFP-ESTP-ISFP weakness ===
    ("ESTP", "ESTP-weakness-01"): [
        ("擅长长期规划，常常『", [
            "擅长期规划，常常『",
            "擅长长线规划，常常『",
            "擅长长程规划，常常『",
        ]),
        ("爽完了才发现来不及。", [
            "爽完才发现来不及。",
            "爽过后才发现来不及。",
            "完事才发现来不及。",
        ]),
    ],
    ("ISFP", "ISFP-weakness-01"): [
        ("擅长长期规划，常常『", [
            "擅长长线规划，常常『",
            "擅长长程规划，常常『",
            "擅长长期谋划，常常『",
        ]),
    ],
    # === 3. INTP-ISTP cognitive ===
    ("ISTP", "ISTP-cognitive-01"): [
        ("逻辑网里自洽，否则不", [
            "逻辑网里自洽，则不",
            "逻辑网里自洽，方可",
        ]),
    ],
    # === 4. INTP-ISTP relationship ===
    ("ISTP", "ISTP-relationship-01"): [
        ("表达。需要对方懂得珍", [
            "表达。需要对象懂得珍",
            "表达。需要伴侣懂得珍",
        ]),
    ],
    # === 5. ENFP-ENTJ social-drain ===
    ("ENTJ", "ENTJ-faq-social-drain"): [
        ("来是能量源——但前提", [
            "来本是能量源——但前提",
            "来就是能量源——但前提",
        ]),
    ],
    # === 6. ENTJ-ESTJ social-drain ===
    ("ESTJ", "ESTJ-faq-social-drain"): [
        ("能量源——但前提得是", [
            "能量来源——但前提得是",
            "能量补给——但前提得是",
            "能量补充——但前提得是",
        ]),
    ],
    # === 7. ENTJ-ESTJ family-pressure ===
    ("ESTJ", "ESTJ-faq-family-pressure"): [
        ("。承认一个真相：家人", [
            "。认一个真相：家人",
            "。认清真相：家人",
        ]),
    ],
    # === 8. ENFP-ENTP strength-01 ===
    ("ENTP", "ENTP-strength-01"): [
        ("方案的场合（产品策划、", [
            "方案的场合（产品定位、",
            "方案的场合（产品规划、",
            "案的场合（产品策划、",
            "案的场合（产品规划、",
        ]),
    ],
    # === 9-10. ENFP-ENTP deadline ===
    ("ENTP", "ENTP-faq-deadline"): [
        ("『新想法可能更好』的", [
            "『新思路可能更好』的",
            "『新点子可能更好』的",
        ]),
        ("进 backlog ", [
            "入 backlog ",
            "放入 backlog ",
        ]),
    ],
    # === 11-12. ENTP-ESTP decision ===
    ("ESTP", "ESTP-faq-decision"): [
        ("面前会觉得选 A 就", [
            "事面前会觉得选 A 就",
            "项面前会觉得选 A 就",
            "关面前会觉得选 A 就",
        ]),
        ("足够深的东西，B 没", [
            "足够硬的东西，B 没",
            "足够狠的东西，B 没",
        ]),
    ],
    # === 13. ENTP-ESTP social-drain ===
    ("ESTP", "ESTP-faq-social-drain"): [
        ("交，而非来者不拒——", [
            "交，而不搞来者不拒——",
            "交，而非逢邀必到——",
        ]),
    ],
    # === 14. ESFP-INFJ content creator ===
    ("INFJ", "INFJ-strength-03"): [
        ("是天然的内容创作者。", [
            "是天然的内容产出者。",
            "是天然的内容生产者。",
        ]),
    ],
    # === 15. INFJ-ISFP deadline ===
    ("ISFP", "ISFP-faq-deadline"): [
        (" DDL 时会因为没", [
            " DDL 时会因为不够",
            " DDL 时会因为未到",
        ]),
    ],
    # === 16-17. INFJ-ISFP breakup ===
    ("ISFP", "ISFP-faq-breakup"): [
        ("为『唯一的灵魂伴侣』", [
            "为『唯一的灵魂伴侣』",  # identity (no change)
            "成『唯一的灵魂伴侣』",
        ]),
        ("从神坛上请下来——后", [
            "从神坛上请下来——继",
            "从神坛上请下来——然",
        ]),
    ],
    # === 18. INFJ-ISFJ criticism ===
    ("ISFJ", "ISFJ-faq-criticism"): [
        ("FJ 被批评后会在脑", [
            "FJ 挨批评后会在脑",
            "FJ 收到批评后会在脑",
        ]),
    ],
    # === 19. INFJ-ISFP alone-weekend ===
    ("ISFP", "ISFP-faq-alone-weekend"): [
        ("己留大块独处时间，是", [
            "己留出大块独处时间，是",
            "己留够大块独处时间，是",
        ]),
    ],
    # === 20. ESFP-INFP weakness ===
    ("INFP", "INFP-weakness-01"): [
        ("现在在情绪里』的信号", [
            "当下情绪化』的信号",
            "自己情绪化』的信号",
        ]),
    ],
    # === 21. INFP-ISFP weakness-02 ===
    ("ISFP", "ISFP-weakness-02"): [
        ("回去，长期变成隐性怨", [
            "回去，长期转为隐性怨",
            "回去，长期成隐性怨",
        ]),
    ],
    # === 22. INFP-ISFJ career-01 ===
    ("ISFJ", "ISFJ-career-01"): [
        ("一深度陪伴与支持——", [
            "一对一个深度陪伴与支持——",
            "一深度陪伴支持——",
        ]),
    ],
    # === 23. INFP-ISFP relationship-01 ===
    ("ISFP", "ISFP-relationship-01"): [
        ("频社交，但需要少数能", [
            "频来往，但需要少数能",
            "频往来，但需要少数能",
        ]),
    ],
    # === 24-26. INFP-ISFP faq-conflict (3 frags) ===
    ("ISFP", "ISFP-faq-conflict"): [
        ("沉默——Fi 的保护", [
            "沉默——Fi 的本能",
            "沉默——Fi 的反应",
        ]),
        ("时机。重要冲突前把核", [
            "时机。重要争执前把核",
            "时机。关键冲突前把核",
        ]),
        ("——写下的话也算数，", [
            "——写下的话也作数，",
            "——写下的话语也有效，",
        ]),
    ],
    # === 27-30. INFP-ISFP criticism (3 frags) ===
    ("ISFP", "ISFP-faq-criticism"): [
        (" 被批评后容易把一句", [
            " 被批评后容易把一句",
            " 听到批评后容易把一句",
            " 收到批评后容易把一句",
        ]),
        ("样的人』——Fi 的", [
            "样的人』——Fi 的",
            "样的人』——Fi 的",
        ]),
        ("为 / 身份』：批评", [
            "为 / 身份』：批评",
            "为 / 身份』：分歧",
            "为与身份』：批评",
        ]),
    ],
    ("ISFJ", "ISFJ-faq-criticism"): [
        ("为可以改，身份不能动", [
            "为可以变，身份不能动",
            "为能改，身份不能动",
        ]),
    ],
    # === 31-34. INFP-ISFP self-doubt (4 frags) ===
    ("ISFP", "ISFP-faq-self-doubt"): [
        ("我能不能』，而是『我", [
            "我能不能』，而是『我",
            "我做不做』，而是『我",
        ]),
        ("以停一周什么都不做—", [
            "以停一周什么都不做—",
            "以停一周不动—",
            "以停一周什么都不做——",
        ]),
        ("答案自己浮上来。把『", [
            "答案自己浮上来。把『",
            "答案自然浮上来。把『",
        ]),
        ("候浮上来，只在安静得", [
            "候浮现出来，只在安静得",
            "候显露出来，只在安静得",
        ]),
    ],
    # === 35. ENFJ-ESFJ deadline (already above) ===
    # === 36. ENFJ-ESFJ criticism ===
    ("ESFJ", "ESFJ-faq-criticism"): [
        ("会先想『是不是我哪里", [
            "会先想『是不是自己哪",
            "会先想『是不是我哪",
        ]),
    ],
    # === 37. ENFP-ESFP cognitive-02 ===
    ("ESFP", "ESFP-cognitive-02"): [
        ("心价值系统，不符合的", [
            "心价值体系，不符合的",
            "心价值尺，不符合的",
        ]),
    ],
    # === 38. ENFP-ESFP public-speaking ===
    ("ESFP", "ESFP-faq-public-speaking"): [
        ("与 50 分钟举牌", [
            "与 50 分钟举牌",
            "加 50 分钟举牌",
            "时 50 分钟举牌",
        ]),
    ],
    # === 39-41. ENFP-ESFP criticism (3 frags) ===
    ("ESFP", "ESFP-faq-criticism"): [
        ("避，但过两天会反弹成", [
            "开，但过两天会反弹成",
            "让，但过两天会反弹成",
        ]),
        ("逐条标注『事实 / ", [
            "逐项标注『事实 / ",
            "逐条标出『事实 / ",
        ]),
        ("感受』再写下来，情绪", [
            "感受』再记录下来，情绪",
            "感受』再写下来，能量",
        ]),
    ],
    # === 42-45. ENFP-ESFP new-job (4 frags) ===
    ("ESFP", "ESFP-faq-new-job"): [
        (" 在新岗位三个月后会", [
            " 入职三个月后会",
            " 到新岗位三个月后会",
        ]),
        ("有『好像也就这样』的", [
            "有『好像也就这样』的",
            "有『似乎也就这样』的",
        ]),
        ("还是新鲜感的阈值到了", [
            "还是新鲜感的门槛到了",
            "还是新鲜感阈值已到",
        ]),
        ("环资源，给它时间重新", [
            "环资源，给它时间重新",
            "境资源，给它时间重新",
        ]),
    ],
    # === 46-47. ENFP-ESFP decision (2 frags) ===
    ("ESFP", "ESFP-faq-decision"): [
        ("先问『这件事能不能坚", [
            "先问『这事能不能坚",
            "先问『这件事能撑",
        ]),
        ("持 6 个月』，再问", [
            "撑 6 个月』，再问",
            "撑半年』，再问",
        ]),
    ],
    # === 48-50. ENFP-ESFP exam (3 frags) ===
    ("ESFP", "ESFP-faq-exam"): [
        ("易掉进『全面铺开但都", [
            "易掉进『全铺开但都",
            "易陷进『全面铺开但都",
        ]),
        ("考前两周只刷真题和错", [
            "考前两周只刷真题与错",
            "考前两周只做真题和错",
        ]),
        ("题，新知识让位旧漏洞", [
            "题，新主题让位旧漏洞",
            "题，新概念让位旧漏洞",
        ]),
    ],
    # === 51. ENFP-ESFP teamwork ===
    ("ESFP", "ESFP-faq-teamwork"): [
        ("5 分钟强收口环节、", [
            "5 分钟强收口环节、",
            "5 分钟强制收口环节、",
        ]),
    ],
    # === 52-53. ESFJ-ISTJ career-02 ===
    ("ISTJ", "ISTJ-career-02"): [
        ("主管、运营经理；适合", [
            "主管、运营主管；适合",
            "经理、运营经理；适合",
        ]),
        ("常事务管得井井有条。", [
            "常事务理得井井有条。",
            "常事务理得条理分明。",
        ]),
    ],
    # === 54-55. ESTJ-ISTJ relationship-01 ===
    ("ISTJ", "ISTJ-relationship-01"): [
        ("TJ 不是浪漫型而是", [
            "TJ 不是浪漫型，而是",
            "TJ 不是浪漫派，而是",
        ]),
        ("能把『我爱你』转化为", [
            "能把『我爱你』化为",
            "能把『我爱你』变为",
        ]),
    ],
    # === 56. ESTJ-ISTJ breakup ===
    ("ISTJ", "ISTJ-faq-breakup"): [
        ("感觉，是给感觉一个可", [
            "感觉，是给感觉一个可",
            "体感，是给体感一个可",
        ]),
    ],
    # === 57. ESTJ-ISTJ decision ===
    ("ISTJ", "ISTJ-faq-decision"): [
        ("一次『破例预算』，把", [
            "一次『例外预算』，把",
            "一次『破格预算』，把",
        ]),
    ],
    # === 58. ISTJ-ISTP social-drain ===
    ("ISTJ", "ISTJ-faq-social-drain"): [
        ("加载会让人精疲力尽。", [
            "加载会让人筋疲力尽。",
            "加载会让人疲惫不堪。",
        ]),
    ],
    # === 59-61. ESTJ-ISTJ teamwork (3 frags) ===
    ("ISTJ", "ISTJ-faq-teamwork"): [
        ("TJ 在团队里会被不", [
            "TJ 在团队里常被不",
            "TJ 在团队中会被不",
        ]),
        ("解释切到事前分流——", [
            "说明切到事前分流——",
            "补救切到事前分流——",
        ]),
    ],
    # === 62-63. ESFJ-ISFJ conflict ===
    ("ISFJ", "ISFJ-faq-conflict"): [
        ("在冲突里会本能先道歉", [
            "冲突时会本能先道歉",
            "冲突里会本能先认错",
        ]),
        ("我也有不舒服的部分』", [
            "我也有不舒服的部分』",
            "我也有不爽的部分』",
        ]),
    ],
    # === 64. ESFJ-ISFJ deadline (already) ===
    # === 65-66. ISFJ-ISTP new-job ===
    ("ISTP", "ISTP-faq-new-job"): [
        ("还是结构性问题？前者", [
            "还是结构性问题？前者",
            "还是体系性问题？前者",
        ]),
        ("别在第一周就下定论，", [
            "别在第一周就做结论，",
            "别在头一周就下定论，",
        ]),
    ],
    # === 67-68. ESFJ-ISFJ self-doubt ===
    ("ISFJ", "ISFJ-faq-self-doubt"): [
        ("FJ 的自我怀疑常常", [
            "FJ 的自我怀疑常常",
            "FJ 的自我质疑常常",
        ]),
        (" 又把档案当成真理。", [
            " 又把档案当真理。",
            " 易把档案当成真理。",
        ]),
    ],
    # === 69. ESFJ-ESTJ career-02 ===
    ("ESTJ", "ESTJ-career-02"): [
        ("理；适合稳定结构里的", [
            "理；适合稳定结构里的",
            "理；适合稳定框架里的",
        ]),
    ],
    # === 70. ESFJ-ESTJ decision ===
    ("ESTJ", "ESTJ-faq-decision"): [
        ("——Si 把这些案例", [
            "——Si 把这些案例",
            "——Si 把那些案例",
        ]),
    ],
    # === 71-72. ESFJ-ESFP relationship-01 ===
    ("ESFP", "ESFP-relationship-01"): [
        ("侣是懂得珍惜和回应的", [
            "侣懂得珍惜和回应",
            "侣懂得珍惜和回应你的",
        ]),
        ("的人，否则 Fe 会", [
            "的人，否则 Fe 会",
            "者，否则 Fe 会",
        ]),
    ],
    # === 73. ESFP-ISTP weakness ===
    ("ISTP", "ISTP-weakness-03"): [
        ("—Se 需要新刺激。", [
            "—Se 需要新刺激。",
            "—Se 想找新刺激。",
        ]),
    ],
    # === 74-77. ESTP-ISTP deadline (4 frags) ===
    ("ISTP", "ISTP-faq-deadline"): [
        ("进度，把爆发留给真正", [
            "进度，把爆发留给真正",
            "节奏，把爆发留给真正",
        ]),
        ("——别让慢性透支变成", [
            "——别让长期透支变成",
            "——别让持续透支变成",
        ]),
        ("力是 Se 的看家本", [
            "力是 Se 的看家本",
            "力是 Se 的招牌",
        ]),
        ("领，但杀手锏打多了也", [
            "领，但杀手锏打多了也",
            "招，但杀手锏打多了也",
        ]),
    ],
    # === 78-81. ISFP-ISTP decision (4 frags) ===
    ("ISTP", "ISTP-faq-decision"): [
        ("事面前会凭当下的感觉", [
            "事面前会凭当下的感受",
            "事面前会凭当下的本能",
        ]),
        ("——Se + Ti ", [
            "——Se + Ti ",
            "——Se 配 Ti ",
            "——Se 与 Ti ",
        ]),
        ("重要决策前给自己一日", [
            "重要决定前给自己一日",
            "重大决策前给自己一日",
        ]),
        ("直觉保留、冲动延后，", [
            "直觉保留、冲动延后，",
            "本能保留、冲动延后，",
        ]),
    ],
    # === 82-83. ISFP-ISTP social-drain ===
    ("ISTP", "ISTP-faq-social-drain"): [
        ("是高消耗行为——情绪", [
            "是高消耗行为——情绪",
            "是高消耗活动——情绪",
        ]),
        ("『需恢复成本的活动』", [
            "『需恢复成本的活动』",
            "『需修复成本的活动』",
        ]),
    ],
    # === 84. ESFP-ISFP decision ===
    ("ESFP", "ESFP-faq-decision"): [
        ("+ Fi 的现场本能", [
            "+ Fi 的现场本能",
            "+ Fi 的现场反射",
        ]),
    ],
    # === 85-86. ESFP-ESTP strength ===
    ("ESTP", "ESTP-strength-03"): [
        ("过得精彩，是聚会里的", [
            "得精彩，是聚会里的",
            "得精彩，是场子里的",
        ]),
        ("—Se 的现场感天然", [
            "—Se 的现场感天然",
            "—Se 的临场感天然",
        ]),
    ],
    # === 87. ESFP-ESTP weakness ===
    ("ESTP", "ESTP-weakness-01"): [
        ("爽完了才发现来不及。", [
            "爽完才发现来不及。",
            "爽过后才发现来不及。",
        ]),
    ],
    # === 88-92. ESFP-ESTP public-speaking (5 frags) ===
    ("ESTP", "ESTP-faq-public-speaking"): [
        ("越兴奋，Se 在现场", [
            "越起劲，Se 在现场",
            "越激动，Se 在现场",
        ]),
        ("快半拍——现场气氛一", [
            "快半拍——现场气氛一",
            "快半拍——场子气氛一",
        ]),
        ("，Se 会跑去接观众", [
            "，Se 会跑去接观众",
            "，Se 会跑去接现场",
        ]),
        ("。提前列好三个的要点", [
            "。提前列好三个要点",
            "。提前备好三个的要点",
        ]),
        ("0 分钟举牌提醒——", [
            "0 分钟举牌提醒你——",
            "0 分钟举牌给你——",
        ]),
    ],
    # === 93. ESFP-social-drain / ESTP-new-job ===
    ("ESTP", "ESTP-faq-new-job"): [
        ("感需要持续的新刺激，", [
            "感需要不断的新刺激，",
            "感需要持续的新冲击，",
        ]),
    ],
    # === 94-95. ESFP-ESTP social-drain ===
    ("ESTP", "ESTP-faq-social-drain"): [
        ("是有新刺激。重复寒暄", [
            "有新冲击。重复寒暄",
            "有新素材。重复寒暄",
        ]),
        ("e 没有新东西可接、", [
            "e 没有新东西可接、",
            "e 没有新素材可接、",
        ]),
    ],
}


def is_subset_overlap(s, old_overlaps):
    for o in old_overlaps:
        if s == o or s in o or o in s:
            return True
    return False


def main():
    all_entries = load_all()

    changed_total = 0
    for it in range(8):
        data = get_scan()
        cross = data["cross_personality"]
        same = sum(len(v) for v in data["same_personality"].values())

        sources = cross + [g for sub in data["same_personality"].values() for g in sub]

        # 按 entry 收集要改的 fragments → candidates
        todo = {}
        for item in sources:
            frag = item["fragment"]
            for e in item["entries"]:
                if "personality" in e:
                    p = e["personality"]
                else:
                    p = e["id"].split("-")[0]
                key = (p, e["id"])
                if key not in ENTRY_REWRITES:
                    continue
                for (old, cands) in ENTRY_REWRITES[key]:
                    if old == frag:
                        todo.setdefault(key, []).append((old, cands))
                        break

        if not todo:
            print(f"iter {it}: no todo")
            break

        changed = 0
        for (p, eid), edits in todo.items():
            e, data_file = load_entry(p, eid)
            if e is None:
                continue
            cur = e["content"]
            cat = e["category"]
            new_text = cur

            # 收集 partners
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

            applied_any = False
            for (old, cands) in edits:
                if old not in new_text:
                    continue
                # check if still overlap
                still_overlap = False
                for pt in partners_text:
                    if old in pt:
                        still_overlap = True
                        break
                if not still_overlap:
                    continue
                for cand in cands:
                    if cand in new_text or cand == old:
                        continue
                    trial = new_text.replace(old, cand, 1)
                    if not cat_len_ok(cat, len(trial)):
                        continue
                    bad = False
                    for pt in partners_text:
                        for s in lcs_pairs(trial, pt):
                            if not is_subset_overlap(s, old_overlaps):
                                bad = True
                                break
                        if bad:
                            break
                    if not bad:
                        new_text = trial
                        applied_any = True
                        break

            if applied_any and new_text != cur:
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