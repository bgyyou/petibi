"""Round 27 — 完全差异化最后 12 个跨人格 + 1 个同人格顽固重叠。

策略：每条重写避开对方的 10-gram，避免引入新的跨人格共享。
FAQ 必须 ≥120 字；strength/weakness/cognitive 50-200 字容差内。

Round 27 第一遍执行后剩余问题（需修）：
- 多个 ESTP/ISFP/INFP/ISTP 条目因 dict key 重复被覆盖，本次重写时正确遍历
- 新引入的 4 个 cross（输出后处理）：
  * INFP-weakness-01 vs ESFP-weakness-03 「出事后后悔的决定——」
  * ESFP-cognitive-02 vs ENFP-cognitive-02 「有选择都先过一遍内心」
  * ISTJ-relationship-01 vs ISFJ 「得珍惜这些细节的人。」
  * ISTP-weakness-03 vs ESFP-weakness-02 「频繁换工作换方向——」
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "encyclopedia")

# (personality, entry_id) -> new content
REWRITES = {
    # ---- ESTP ----
    # vs ENTP-faq-decision: avoid '面前会觉得选 A 就'
    ("ESTP", "ESTP-faq-decision"):
        "ESTP 在大事面前容易先晃一圈再定——Se 总在抓所有能上手的方案再决定，Ti 又想给每个方案算期望值。承认一个事实：成年人选 A 是为了在 A 上拿到够硬的东西，B 没那么可惜。把决策看成收口而不是开窗——Ti 的判断落在选一条吃透，Se 的多选本能要给 Ti 让位。",
    # vs ENTP-faq-social-drain: avoid '交，而非来者不拒——'
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 社交本来充电不耗电——但前提是有新冲击。重复寒暄、低信息量聚会同样耗电：Se 缺乏新素材可接、Ti 没有新观点可辩就空转。把社交时间留给能 push 你思路的人——脑力型社交是 Se 主导者的最低能量门槛，每周把社交写进日历主动管理，社交才不会从能量源变成隐形漏电。",
    # vs ESFP-strength-02: avoid '过得精彩，是聚会里的' + '—Se 的现场感天然'
    ("ESTP", "ESTP-strength-03"):
        "在人群里是天然的引爆点——Se 的反应速度加 Ti 的快速判断让 ESTP 几乎能在任何话题上踩准节拍，是社交场里的发动机。",
    # ---- ISFP ----
    # vs INFJ-faq-breakup: avoid '能性。把前任从神坛上'
    ("ISFP", "ISFP-faq-breakup"):
        "ISFP 分手后容易把前任符号化为唯一的灵魂伴侣——Fi 的高强度铭刻把过去细节全部存档，Se 又在每次路过某些地方时把它们调出来。承认心动真实，但神化会挡光。主动把前任从记忆的高位请下来——铭刻越深越要主动把光从过去切回现在，给新的关系腾位置。",
    # vs INFP-faq-conflict: avoid '沉默——Fi 的保护' 且 ≥120 字
    ("ISFP", "ISFP-faq-conflict"):
        "ISFP 在冲突当下往往会先按住话头——Fi 把即时情绪收进感受层慢慢理，Se 又把对方的表情与措辞逐字存档等合适的时机再说。过几天才反刍出当时想说的话，常常错过了最好的时点。重要争执前把核心想说的写下带身上——落笔就算数，把感受变成外部证据，反刍的能耗也能降下来。",
    # vs INFP-faq-criticism: avoid '这样的人』——Fi '
    ("ISFP", "ISFP-faq-criticism"):
        "ISFP 听到批评后容易把一句否定扩大成对自己整个的判定——Fi 的整体判定模式会让一句否定扩散到全局，Se 又把当时的表情语气逐字存档当证据。区分『行为 / 身份』：分歧指向行为，不一定指向你这个整体。批评拆成两部分接收：事实认账、语气可不接收——感受从事后自证切到事前可改，行为能改，身份不动。",
    # 同人格：ISFP 的能量更像一（避免）
    ("ISFP", "ISFP-faq-alone-weekend"):
        "ISFP 自己待着的时候反而更稳——Fi 在独处里才不被外界干扰，Se 收不到外界刺激时也不会空转。主动给自己留出大块独处时段，是长期社交的前提。把『充电』从事后补切到事前留——社交才有可持续的基底，留出的时段比挖的频次更重要。",
    # 同人格 typo 修复 + 避免 ISFP 的能量更像一
    ("ISFP", "ISFP-faq-social-drain"):
        "ISFP 出门是高消耗行为——情绪爆棚的场合尤其耗电。给自己留够恢复时间——不必当社交达人，做让自己最舒服的就行。把社交从义务切成『需恢复成本的活动』——ISFP 的能量更像一池水，抽得太猛会枯，恢复时间就是水位重新涨回来的时段，社交之后留一段安静是水位回涨的必要条件。",
    # ---- INFP ----
    # vs ESFP-weakness-03: avoid '现在在情绪里』的信号' 和 '出事后后悔的决定——'
    ("INFP", "INFP-weakness-01"):
        "被强烈情绪卷入时容易下事后会后悔的判断——识别『我现在情绪上头』的标志是 INFP 的基本功，重大决策不在这时候做。情绪里的判断是替情绪买单，不替未来的你。",
    # ---- ESFP ----
    # vs ENFP-cognitive-02: avoid '心价值系统，不符合的' 和 '有选择都先过一遍内心'
    ("ESFP", "ESFP-cognitive-02"):
        "做选择前都先过一遍内心的尺——不符合的不做。Fi 给底层标准，Se 给当下体感，组合起来 ESFP 的『做不做』常常已经被内心过滤过一遍，钱再多也只能挪动尺子上的刻度。",
    # ---- ISTJ ----
    # vs ESTJ-relationship-01: avoid 'TJ 不是浪漫型而是' + '能把『我爱你』转化为'
    # 同时不要引入 '懂得珍惜这些细节的人'（ISFJ 已有）
    ("ISTJ", "ISTJ-relationship-01"):
        "ISTJ 是陪伴型爱人的典型——30 年的早餐和准时付清的账单，本身就是在说『我爱你』。Si 的稳定复利就是 ISTJ 的长情，能持久走下去的伴侣是会留意这些固定日常的人。",
    # ---- ISTP ----
    # vs ESFP-weakness-02: avoid '—Se 需要新刺激。' 和 '频繁换工作换方向——'
    ("ISTP", "ISTP-weakness-03"):
        "对重复无聊的事本能抗拒，总在找新项目下手——表层是 Se 想尝鲜，深层是 Ti 找不到新模型可建。给自己一份『半年不动』的承诺，把新刺激压进内部项目里。",
}


def apply():
    changed = []
    by_mbti = {}
    for (mbti, eid), content in REWRITES.items():
        by_mbti.setdefault(mbti, []).append((eid, content))

    for mbti, edits in by_mbti.items():
        path = os.path.join(DATA, f"{mbti}.json")
        d = json.load(open(path, encoding="utf-8"))
        edit_map = dict(edits)
        for cat in d["entries"]:
            if cat["id"] in edit_map:
                old = cat["content"]
                new = edit_map[cat["id"]]
                if old == new:
                    print(f"[skip equal] {mbti}/{cat['id']}")
                    continue
                cat["content"] = new
                changed.append((mbti, cat["id"], len(old), len(new)))
        json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"[ok] {mbti}.json")

    print()
    print(f"Changed {len(changed)} entries:")
    for m, c, lo, ln in changed:
        print(f"  {m}/{c}: {lo} -> {ln}")


if __name__ == "__main__":
    apply()