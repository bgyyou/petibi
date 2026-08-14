# -*- coding: utf-8 -*-
"""apply_cross_dedup_round5.py — 第五轮补丁：扩展长度至 120-200"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"

OVERRIDES = {}

OVERRIDES[("enfp", "ENFP-faq-social-drain")] = (
    "ENFP 社交本来是能量源——但前提是有新东西可接。"
    "重复寒暄同样耗电：Ne 没新东西可接就会空转，"
    "空转比独处还累，独处至少安静。"
    "选择脑力型社交而不是来者不拒——"
    "把每周社交主动排进日历做预算管理，"
    "是给 Ne 留刺激源，比『有空就赴约』的来者不拒更可持续，"
    "社交才不会从能量源变成隐形漏电。"
)
OVERRIDES[("esfj", "ESFJ-faq-deadline")] = (
    "DDL 一紧，ESFJ 会本能揽下别人的急活儿——"
    "Fe 把协调当成自己默认任务，Si 还会把每次『我帮过谁』都存成档案。"
    "结果自己的活被压缩，你累垮了也没人顶替。"
    "立『自己的 DDL 优先』硬规则——"
    "先守自己才有余量顾别人，Fe 维护是关系的电池，"
    "电池用完了，关系也跟着没电，"
    "你累垮了，团队的活还是得有人做，那个人通常是别的同事。"
)
OVERRIDES[("esfp", "ESFP-faq-social-drain")] = (
    "ESFP 社交本来充电不耗电——但前提是有新刺激。"
    "重复寒暄同样耗电："
    "Se 没新东西可接、Fi 没新感受可交换就会空转。"
    "选择脑力型社交而不是来者不拒——"
    "把每周社交预算主动排进日历，"
    "社交才不会从『充电』变成『隐形漏电』，"
    "Se 的现场感需要持续的新刺激，纯寒暄就是给 Se 喂白水。"
)
OVERRIDES[("estp", "ESTP-faq-deadline")] = (
    "ESTP 在最后阶段爆发赶工——"
    "Se 的临门一脚效率惊人但伤身体。"
    "提前规划进度，把爆发留给真正紧急的——"
    "别让慢性透支变成常态：爆发力是 Se 的王牌，"
    "但王牌打多了也不值钱，给身体留恢复时间，"
    "下一次爆发的质量才不打折；"
    "透支的利息从下一次爆发开始收，身体会替你打折。"
)
OVERRIDES[("infj", "INFJ-faq-alone-weekend")] = (
    "INFJ 的独处像一次次内部整理——"
    "Ni 在安静里更新远景图，Fe 在这个过程里安静下来不再向外扫。"
    "主动给自己留大块独处时间，是可持续社交的前提。"
    "把独处时间前置留好，比事后硬补更省；"
    "Fe 不是无限产能的发电厂，是需要定期维护的电池组，"
    "独处就是给电池组做维护的关键时段。"
)
OVERRIDES[("infp", "INFP-faq-criticism")] = (
    "INFP 被批评后容易把『这件事没做好』扩大为『我就是这样的人』——"
    "Fi 的全盘判定模式：行为和身份焊死，一损俱损。"
    "区分『行为 / 身份』：批评的是行为不一定是你这个人。"
    "行为可以改，身份不能动——"
    "把 Fi 的判定从全有全无拉回可改范围，"
    "感受不被吞没，反刍才有解，"
    "改行为不等于否定自己，是在对自己负责。"
)
OVERRIDES[("infp", "INFP-faq-social-drain")] = (
    "INFP 社交是高消耗行为——"
    "Fi 读自己也读别人、Fe 又把全场情绪同步收进来，双重加载。"
    "情绪密集场合尤其耗电——"
    "满屋子人都在情绪里，Fi 和 Fe 同时开机就跟同时跑两个大型程序一样卡。"
    "提前规划社交后的独处恢复时间，比崩溃后再补更省。"
    "把恢复从被动切到主动——"
    "可持续生活才有最低保障，按周排恢复时间才稳。"
)
OVERRIDES[("isfj", "ISFJ-faq-conflict")] = (
    "ISFJ 在冲突里会本能先道歉认错——"
    "Si 把礼让当默认设置，Fe 把和谐当任务，"
    "心里委屈没出口——"
    "长期压抑会让关系在某个节点突然崩。"
    "允许自己说『我也有不舒服的部分』——"
    "不是不善良，是给关系账户做个真实的当期结算，"
    "礼貌模板不等于真实感受，承认完整感受才能让关系真稳。"
)
OVERRIDES[("isfj", "ISFJ-faq-self-doubt")] = (
    "ISFJ 的自我怀疑常常是因为把别人对你的评价内化为对自己的评价——"
    "Si 会把每一次反馈存成档案，Fe 又把档案当成事实。"
    "列出 3 个你最在意的具体场景——"
    "回看自己在每个场景里实际做得怎么样，"
    "证据比别人的评价更可靠，"
    "把 Si 的档案库从『别人的反馈』切到『自己的实际表现』，"
    "自我评价才有锚点，怀疑才不会无源反复。"
)
OVERRIDES[("isfj", "ISFJ-faq-deadline")] = (
    "同事赶 DDL 时，ISFJ 会本能先去搭把手——"
    "Si 把『每次都有人找我帮』存成档案，"
    "Fe 让『不帮』像违背本能。"
    "结果自己的活被压缩，你是替别人买单的那个人。"
    "立『自己的 DDL 优先』硬规则——"
    "别让自己永远替别人买单，"
    "Si 的稳态偏好不等于活该被压缩，"
    "替别人买的单会以自己的 DDL 失守来偿还。"
)
OVERRIDES[("isfp", "ISFP-faq-social-drain")] = (
    "ISFP 社交是高消耗行为——"
    "情绪密集场合尤其耗电，Fi + Fe 的双重加载。"
    "给自己留足恢复时间——"
    "你不需要成为社交达人，做自己最舒服。"
    "把社交从义务切到『需恢复成本的活动』——"
    "做自己最舒服才是可持续，"
    "ISFP 的能量不像充电宝，更像一口井，"
    "挖太快会枯，恢复时间就是井水重新涨回来的时段。"
)


def main():
    LEN_RULES = {"trait": (80, 150), "faq": (120, 200)}
    by_file = {}
    for (p, eid), content in OVERRIDES.items():
        by_file.setdefault(p, []).append((eid, content))

    n = 0
    for p, items in sorted(by_file.items()):
        fpath = ENCYCLOPEDIA_DIR / f"{p}.json"
        data = json.loads(fpath.read_text(encoding="utf-8"))
        id_map = {e["id"]: e for e in data.get("entries", [])}
        for eid, content in items:
            entry = id_map[eid]
            cat = entry["category"]
            if cat in LEN_RULES:
                lo, hi = LEN_RULES[cat]
                if not (lo <= len(content) <= hi):
                    print(f"WARN  {p}/{eid} [{cat}]: 字数 {len(content)} 不在 [{lo},{hi}]")
            entry["content"] = content
            n += 1
        fpath.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(f"总计 {n} 条。")
    return 0


if __name__ == "__main__":
    sys.exit(main())