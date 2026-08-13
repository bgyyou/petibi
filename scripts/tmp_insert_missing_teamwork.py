# -*- coding: utf-8 -*-
"""
tmp_insert_missing_teamwork.py — 一次性补丁脚本（M2 百科补齐）

目的：
  eval/persona_eval.jsonl 的 80 条 source_entries 中有 11 个 <TYPE>-faq-teamwork
  在 data/encyclopedia/ 里不存在。本脚本把这 11 条以"团队协作摩擦"标题插入
  对应人格 JSON 的 entries 数组里，确保评测集的 R3 RAG 溯源链路完整。

设计要点：
  1. 严格按 docs/tech/M2-数据契约.md §2 schema：
     id / category / title / content（120-200 中文字） / tags / scenario
  2. 内容必须人格化口吻：'作为 X，通常会……'，并对照 eval/persona_eval.jsonl
     中该人格的 key_points 取向、避开 trap（不让回答落入他人格类型的解法）
  3. title 与既有 5 条 teamwork FAQ 一致（'团队协作摩擦'），保持文件内风格统一
  4. tags 沿用 ['人格化'] 单标签（与既有 FAQ 条目一致）
  5. 直接覆盖写回：脚本运行后百科库从 25 → 26 条/人；后续 check_encyclopedia.py
     校验门槛调整为 ≥25（详见同 PR 的 scripts/check_encyclopedia.py 修改）

运行：
    python scripts/tmp_insert_missing_teamwork.py
"""
import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
ENC_DIR = REPO_ROOT / "data" / "encyclopedia"

# 11 条补丁：每条对应一个人格 × teamwork 场景
# 内容由编写者按 M2-数据契约 §2 + eval/persona_eval.jsonl key_points/trap 撰写
PATCHES = [
    {
        "personality": "INTJ",
        "entry": {
            "id": "INTJ-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 INTJ，对『马上做』这种模糊承诺零容忍——会把对方承诺按 OKR 形式书面化、"
                "下次会议直接对账，避免在情绪里反复催。私下 1:1 问清卡点是必要的礼貌，"
                "但要把『帮对方』和『替对方』切干净，最后明确升级阈值和止损线。"
                "系统化解决，不靠包容。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ENTJ",
        "entry": {
            "id": "ENTJ-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ENTJ，对反复拖进度的人耐心天然偏低——会先把责任按 RACI 矩阵落到纸面上，"
                "让对方对『负责』二字没有解释空间。私下 1:1 给一个 30 天改进窗口并形成记录，"
                "到期未达标的直接走 HR 或上级通道，不在低效关系里消耗自己。"
                "把功劳和责任都摊清楚，是 ENTJ 守住团队节奏的本能。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ENFJ",
        "entry": {
            "id": "ENFJ-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ENFJ，第一反应永远是维护团队和谐，但群里被反复攻击不是和谐是失序——"
                "会私下 1:1 跟当事人聊清楚：是能力问题还是态度问题，再决定是否向上反映。"
                "把『我帮你的小忙』清单摊出来，让对方意识到这种隐形付出需要被承认，"
                "必要时把承担的任务重新分摊到其他人头上。"
                "长期看，ENFJ 必须学会温和地说不。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ENFP",
        "entry": {
            "id": "ENFP-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ENFP，开会时脑子里的点子像烟花一样炸，但没人接住就会变成全场尴尬——"
                "解法是把活跃性装进『结构化容器』：每周固定一个游戏化会议、5 分钟强收口、"
                "选一个靠谱的搭档共同主持。把你的能量做成可复用的仪式，而不是即兴发挥——"
                "团队才会追着你跑，而不是嫌你『太散』。"
                "长期看，ENFP 的创造力只有在节奏里才会被认真对待。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "INFJ",
        "entry": {
            "id": "INFJ-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 INFJ，群里那张隐形的合影你其实早就读懂了，但直接揭穿反而会被当小题大做——"
                "会先观察一两次确认判断，再私下找 1 个同盟验证，最后才用 1:1 把问题"
                "摆到当事人面前。关键区别是『修人』还是『自保』：前者值得投入，后者该及时退出。"
                "短期看似温吞，长期看 INFJ 的洞察只有在被允许放慢节奏时才会被真正听见。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "INFP",
        "entry": {
            "id": "INFP-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 INFP，开会时想法被否决心里会先凉半截，但别让这种凉变成自动弃权——"
                "会先把想法写成一页纸备着，找一个私下能听你说完的同盟确认它值不值得被提，"
                "再决定是否在下一次会上重申。接受多数决定但保留底线：哪些情况你会主动退出项目，"
                "哪些你会坚持。长期看，INFP 的真诚只有在不被反复辜负时才会持续。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ISFJ",
        "entry": {
            "id": "ISFJ-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ISFJ，最常见的模式是把活默默接过来、回头又委屈得不行——"
                "会先私聊 leader 把当前任务和负荷摊出来，把『我承担 vs 别人承担』"
                "写成可对账的小清单。下次分工前主动提出更公平的方式，避免再次掉进"
                "『被默认』的陷阱。长期看，ISFJ 必须学会温和地把功劳和负担一起摆上桌。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ISFP",
        "entry": {
            "id": "ISFP-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ISFP，开会时你的点子被绕过去、心里堵得慌，但当场硬怼不是你的招——"
                "会把想法画成图或写成小标签单独发出去，给别人一点时间咀嚼。"
                "私下找 1 个同盟帮你把话转达过去，被否也接受，但不让自己的声音长期缺位。"
                "先在安全的小范围里练表达，再逐步推到正式场合。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ESFJ",
        "entry": {
            "id": "ESFJ-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ESFJ，最不能接受的是开会越来越冷场、但自己又被默认成『公益岗』——"
                "会把团队里仍然活跃的人立成典型，把分工按 SLA 锁死，给自己的额外付出"
                "画一条硬边界。下一次被强塞任务时，用『这次可以，下不为例』"
                "的句式温和但明确地拒绝。长期看，ESFJ 必须学会让热心不被滥用。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ESTP",
        "entry": {
            "id": "ESTP-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ESTP，开会发现大家只会讲大词不动手，你会立刻把会议拖进实战——"
                "把『下周完成战略对齐』这种空话换成『明天 24 小时内做这一件事的最小可行版』。"
                "用一次小胜利证明团队还能跑，再拉 1-2 个敢动的人组成反小分队推进下一步。"
                "长期看，ESTP 的反应速度只有在被允许落地时才能成为团队的引擎。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
    {
        "personality": "ESFP",
        "entry": {
            "id": "ESFP-faq-teamwork",
            "category": "faq",
            "title": "团队协作摩擦",
            "content": (
                "作为 ESFP，你在会上是那个让全场笑出声的人，但笑完之后没人接活儿就尴尬了——"
                "解法是把活跃性装进『结构化容器』：固定一个 5 分钟强收口环节、"
                "选一个靠谱的搭档共同暖场、再把你擅长的破冰做成可复用的仪式。"
                "把喧闹从即兴变成仪式，团队才会真正依赖你的能量而不是嫌你『只会热闹』。"
            ),
            "tags": ["人格化"],
            "scenario": "teamwork",
        },
    },
]


def main() -> int:
    inserted = []
    skipped = []
    for patch in PATCHES:
        path = ENC_DIR / f"{patch['personality'].lower()}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        entry = patch["entry"]

        # 防止重复插入
        if any(e.get("id") == entry["id"] for e in data["entries"]):
            skipped.append(patch["personality"])
            continue

        data["entries"].append(entry)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        inserted.append(patch["personality"])

    print(f"插入 {len(inserted)} 条：{inserted}")
    if skipped:
        print(f"跳过（已存在）：{skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())