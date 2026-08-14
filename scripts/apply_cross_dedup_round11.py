# -*- coding: utf-8 -*-
"""apply_cross_dedup_round11.py — 第十一轮: 长度扩展至 120+"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"

OVERRIDES = {}

OVERRIDES[("enfp", "ENFP-faq-criticism")] = (
    "ENFP 被批评当下会本能回避，但过两天会反弹成大段反驳——"
    "Ne + Fi 双倍输出。"
    "把反驳整理成辩论材料：逐条标注『事实 / 感受』再写下来，"
    "情绪浓度会自然减半。"
    "写在纸上比发群里稳妥——"
    "纸面是冷处理通道，群里是放大镜，发出去就收不回，"
    "回头再看也不会尴尬。"
)
OVERRIDES[("estp", "ESTP-faq-deadline")] = (
    "ESTP 在最后阶段爆发赶工——Se 的临门一脚效率惊人但伤身体。"
    "提前规划进度，把爆发留给真正紧急的——"
    "别让慢性透支变成常态：爆发力是 Se 的王牌，"
    "但王牌打多了也不值钱，给身体留恢复时间，"
    "下一次爆发的质量才不打折；"
    "透支的利息从下一次爆发开始收，身体会替你打折。"
)
OVERRIDES[("infp", "INFP-faq-criticism")] = (
    "INFP 被批评后容易把一句否定扩大为『我就是这样的人』——"
    "Fi 的全盘判定模式，行为和身份焊死。"
    "区分『行为 / 身份』：批评的是行为不一定是你这个人。"
    "行为可以改，身份不能动——"
    "把 Fi 的判定从全有全无拉回可改范围，"
    "感受不被吞没，反刍才有解，"
    "改行为不等于否定自己，是在对自己负责。"
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
OVERRIDES[("isfj", "ISFJ-faq-decision")] = (
    "ISFJ 在重大抉择里会下意识选『对别人最不麻烦』的方案——Fe 过度加载。"
    "承认一个现实：有时候你需要优先选对自己最好的。"
    "不打扰别人不等于不照顾自己——"
    "优先选对自己最好的，是给长期关系留余量；"
    "否则你自己先空掉，关系也撑不住，最后还是得让别人来照顾你。"
)
OVERRIDES[("isfp", "ISFP-faq-social-drain")] = (
    "ISFP 社交是高消耗行为——情绪密集的场合尤其耗电。"
    "给自己留够恢复时间——"
    "你不必当社交达人，做让自己最舒服。"
    "把社交从义务切成『需恢复成本的活动』——"
    "ISFP 的能量更像一口井，挖太快会枯，"
    "恢复时间就是井水重新涨回来的时段，"
    "社交之后留一段安静是井水回涨的必要条件。"
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