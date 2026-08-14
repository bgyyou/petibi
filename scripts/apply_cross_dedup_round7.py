# -*- coding: utf-8 -*-
"""apply_cross_dedup_round7.py — 第七轮：长度扩展 + 最后微调"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"

OVERRIDES = {}

OVERRIDES[("infp", "INFP-faq-criticism")] = (
    "INFP 被批评后容易把一句否定扩大为『我就是这样的人』——"
    "Fi 的全盘判定模式：行为和身份焊死，一损俱损。"
    "区分『行为 / 身份』：批评的是行为不一定是你这个人。"
    "行为可以改，身份不能动——"
    "把 Fi 的判定从全有全无拉回可改范围，"
    "感受不被吞没，反刍才有解。"
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
OVERRIDES[("isfp", "ISFP-faq-social-drain")] = (
    "ISFP 社交是高消耗行为——情绪密集场合尤其耗电。"
    "给自己留足恢复时间——"
    "你不需要成为社交达人，做自己最舒服。"
    "把社交从义务切到『需恢复成本的活动』——"
    "ISFP 的能量更像一口井，挖太快会枯，"
    "恢复时间就是井水重新涨回来的时段，"
    "社交之后留一段安静是井水回涨的必要条件。"
)
OVERRIDES[("estp", "ESTP-faq-public-speaking")] = (
    "ESTP 在台上一般不怯场——越热越兴奋，Se 在现场拿满刺激。"
    "但脑子比嘴快半拍——"
    "现场气氛一高，Se 会跑去接观众笑点而不是主线。"
    "提前定好三个核心点，请人在第 25 和 50 分钟举牌提醒——"
    "现场 + 结构的组合拳比纯靠灵感更稳；"
    "举牌提醒是给 Se 装一个『结构阀门』，"
    "不让现场气氛把主线冲散。"
)
OVERRIDES[("estp", "ESTP-faq-deadline")] = (
    "ESTP 在最后阶段爆发赶工——Se 的临门一脚效率惊人但伤身体。"
    "提前规划进度，把爆发留给真正紧急的——"
    "别让慢性透支变成常态：爆发力是 Se 的王牌，"
    "但王牌打多了也不值钱，给身体留恢复时间，"
    "下一次爆发的质量才不打折；"
    "透支的利息从下一次爆发开始收，身体会替你打折。"
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