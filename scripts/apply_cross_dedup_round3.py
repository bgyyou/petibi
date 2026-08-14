# -*- coding: utf-8 -*-
"""apply_cross_dedup_round3.py — 第三轮补丁：把 4 条过短 FAQ 扩展到 120-200"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCYCLOPEDIA_DIR = REPO_ROOT / "data" / "encyclopedia"

OVERRIDES = {}

OVERRIDES[("infj", "INFJ-faq-new-job")] = (
    "INFJ 入职新环境会被『冷』消耗——Fe 的雷达常开，对温度的波动极敏感。"
    "先观察三个月：有些冷是对方慢热，有些是真的排斥。"
    "前者可以等，后者早走是止损——"
    "别在前 30 天就下定论，Ni 的远景感会把短期信号当成长期事实，"
    "但短期信号常常是噪声不是信号；给观测留够样本才下结论，"
    "新环境的温度需要时间才能校准到你习惯的尺度。"
)
OVERRIDES[("isfj", "ISFJ-faq-decision")] = (
    "ISFJ 在重大抉择里会下意识选『对别人最不麻烦』的方案——Fe 过度加载，"
    "Si 会把过去所有『让别人舒服』的案例当成模板复用。"
    "承认一个现实：有时候你需要优先选对自己最好的。"
    "不打扰别人不等于不照顾自己——"
    "优先选对自己最好的，是给长期关系留余量；"
    "否则你自己先空掉，关系也撑不住，最后还是得让别人来照顾你。"
)
OVERRIDES[("isfp", "ISFP-faq-alone-weekend")] = (
    "ISFP 独处不是孤独而是充电——Fi 在独处里才稳，外界刺激一多就过载。"
    "主动给自己留大块独处时间，是可持续社交的前提——"
    "社交的能量必须先充好再给出去。"
    "把『充电』从事后补切到事前留——"
    "社交才有可持续的能量基底，独处时间前置留好，比事后硬补更省 Fi，"
    "ISFP 的能量更像一口井，挖太快会枯。"
)
OVERRIDES[("estp", "ESTP-faq-deadline")] = (
    "ESTP 在最后阶段爆发赶工——Se 的临门一脚效率惊人但伤身体。"
    "提前规划进度，把爆发留给真正紧急的——"
    "别让慢性透支变成常态：爆发力是 Se 的王牌，"
    "但王牌打多了也不值钱，给身体留恢复时间，"
    "下一次爆发的质量才不打折，否则身体会替你打折——"
    "透支的利息从下一次爆发开始收。"
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
    print(f"总计改写 {n} 条。")
    return 0


if __name__ == "__main__":
    sys.exit(main())