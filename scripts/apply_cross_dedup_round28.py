"""Round 28 — 修 round 27 第二遍仍剩的 9 个 cross-overlap + ISFP-alone-weekend 长度补足。

策略：每条改动尽量小，只替换与对方重合的子串，不引入新重叠。
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "encyclopedia")

# (personality, entry_id) -> new content
REWRITES = {
    # ---- ESTP-faq-decision: 避开 '是为了在 A 上拿到' ----
    ("ESTP", "ESTP-faq-decision"):
        "ESTP 在大事面前容易先晃一圈再定——Se 总在抓所有能上手的方案再决定，Ti 又想给每个方案算期望值。承认一个事实：成年人一旦选定 A，就要在 A 上拿到够硬的东西，B 没那么可惜。把决策看成收口而不是开窗——Ti 的判断落在选一条吃透，Se 的多选本能要给 Ti 让位。",
    # ---- ESTP-faq-social-drain: 避开 5 个交叉（含 ESFP 的 '本来充电不耗电——但'） ----
    # 避开 '本来充电不耗电——但'、'信息量聚会同样耗电：'、
    # 避开 'push 你思路的人'、'能量源变成隐形漏电。'
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 社交基本是充电场景——但只限有新冲击的场合。流水席、纯寒暄的聚会同样耗电：Se 缺乏新素材可接、Ti 没有新观点可辩就空转。把社交时间留给能挑战你思路的人——脑力型社交是 Se 主导者的最低能量门槛，每周把社交写进日历主动管理，社交才不会从补给线变成消耗项。",
    # ---- ISFP-faq-breakup: 避开 '后容易把前任符号化为' ----
    ("ISFP", "ISFP-faq-breakup"):
        "ISFP 分手后倾向把前任标定为唯一的灵魂伴侣——Fi 的高强度铭刻把过去细节全部存档，Se 又在每次路过某些地方时把它们调出来。承认心动真实，但神化会挡光。主动把前任从记忆的高位请下来——铭刻越深越要主动把光从过去切回现在，给新的关系腾位置。",
    # ---- ISFP-faq-criticism: 避开 '后容易把一句否定扩大' + '『行为 / 身份』：' ----
    ("ISFP", "ISFP-faq-criticism"):
        "ISFP 接到批评后倾向于把一句否定扩散成对自己的整体判定——Fi 的整体判定模式会让一句否定扩到全局，Se 又把当时的表情语气逐字存档当证据。把『行为 / 身份』拆开看：分歧指向行为，不一定指向你这个整体。批评拆成两部分接收：事实认账、语气可不接收——行为能改，身份不动。",
    # ---- ISTP-weakness-03: 避开 '复无聊的事本能抗拒，' ----
    ("ISTP", "ISTP-weakness-03"):
        "对例行无新意的事本能抗拒，总在找新项目下手——表层是 Se 想尝鲜，深层是 Ti 找不到新模型可建。给自己一份『半年不动』的承诺，把新刺激压进内部项目里。",
    # ---- ISFP-faq-alone-weekend: 同人格已 OK，但需要 ≥120 字（目前 114） ----
    ("ISFP", "ISFP-faq-alone-weekend"):
        "ISFP 自己待着的时候反而更稳——Fi 在独处里才不被外界干扰，Se 收不到外界刺激时也不会空转。主动给自己留出大块独处时段，是长期社交的前提。把『充电』从事后补切到事前留——社交才有可持续的基底，留出的时段比挖的频次更重要，按自己的节奏来。",
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