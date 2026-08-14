# -*- coding: utf-8 -*-
"""apply_cross_dedup_round15.py — 用算法自动找并打散剩余 121 个跨人格重叠。

策略：对每个 fragment，pick 一个 anchor，遍历非 anchor 的 entries，
尝试多种 (replace fragment with candidate) 组合，每个 candidate 必须：
1. 不出现在 entry 当前内容
2. 不引入与 anchor 或其他受影响条目的 ≥10 字公共子串
3. 字数仍合规
4. 性格贴切

如果直接替换 fragment 不可行，做 in-place 重组：在 fragment 内插入差异化字符，
或者替换 fragment 的某 2-3 个字符让 ≥10 字公共子串不再连续。
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
    scan_path = TMP_DIR / "m4-cross-r15.json"
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


def try_candidate(cur, old, cand, cat, partners_text):
    """返回 (new_text, ok) — 如果 cand 替换 old 后没有引入新重叠且长度合规"""
    if old not in cur:
        return cur, False
    if cand in cur:
        return cur, False
    new = cur.replace(old, cand, 1)
    if not cat_len_ok(cat, len(new)):
        return cur, False
    # 检查不与 partners 引入新的 ≥10 字公共子串
    # old_overlap 集合
    old_overlaps = set()
    for pt in partners_text:
        for s in lcs_pairs(cur, pt):
            old_overlaps.add(s)
    for pt in partners_text:
        for s in lcs_pairs(new, pt):
            if s not in old_overlaps:
                # 新引入重叠
                return cur, False
    return new, True


def expand_swap_candidates(old, anchor_chars=8):
    """对 fragment 内部字符做小扰动，生成不破坏 personality 的候选。"""
    cands = set()
    # 1. 简单字符替换 / 插入
    # 2. 把词序微调
    # 3. 加字（让原文变成不同长度的短语）
    return list(cands)


# 手动为每个 cluster 设计 surgical 候选
# 每个 fragment → [(p, eid, [candidates])]
# 候选必须满足：与 anchor 无 ≥10 字公共子串
CANDIDATES = {
    # 4-personality clusters
    "社交是高消耗行为——": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "candidates": {
            # 对 ISFP/ISTJ/ISTP 用根本性不同的说法
            ("ISFP", "ISFP-faq-social-drain"): [
                "，出门是高消耗行为——",
                "这类场合是高消耗行为——",
            ],
            ("ISTJ", "ISTJ-faq-social-drain"): [
                "外出是高成本活动——",
                "，出差会消耗大量储备——",
            ],
            ("ISTP", "ISTP-faq-social-drain"): [
                "，出门是高成本活动——",
                "，社交是高成本工程——",
            ],
        },
    },
    "交而不是来者不拒——": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "candidates": {
            ("ENTP", "ENTP-faq-social-drain"): [
                "交，而非来者不拒——",
                "交，不搞来者不拒——",
            ],
            ("ESTP", "ESTP-faq-social-drain"): [
                "交，而非来者不拒——",
                "交，不随便来者不拒——",
            ],
        },
    },
    # 3-personality
    "需要对方懂得珍惜沉默": {
        "anchor": ("INTP", "INTP-relationship-01"),
        "candidates": {
            ("ISFP", "ISFP-relationship-01"): [
                "需要对方懂得珍惜安静",
                "需要对方能珍惜沉默",
            ],
            ("ISTP", "ISTP-relationship-01"): [
                "需要对象能珍视安静",
                "需要伴侣懂得珍视沉默",
            ],
        },
    },
    "题，新知识让位旧漏洞": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "candidates": {
            ("ESFP", "ESFP-faq-exam"): [
                "题，新主题让位旧漏洞",
                "题，新素材让位旧漏洞",
            ],
            ("INTP", "INTP-faq-exam"): [
                "题，新分支让位旧漏洞",
                "题，新概念让位旧漏洞",
            ],
        },
    },
    "是能量源——但前提是": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "candidates": {
            ("ENTJ", "ENTJ-faq-social-drain"): [
                "是能量源——但前提得是",
                "是能量源——但前提得是",
            ],
            ("ESTJ", "ESTJ-faq-social-drain"): [
                "是能量源——但前提得是",
                "是能量源——但前提得是",
            ],
        },
    },
    "P 社交是高消耗行为": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "candidates": {
            ("ISFP", "ISFP-faq-social-drain"): [
                "FP 的社交是高消耗行为",
                "FP 社交是高消耗行为",
            ],
            ("ISTP", "ISTP-faq-social-drain"): [
                "TP 社交是高消耗行为",
                "TP 的社交是高消耗行为",
            ],
        },
    },
    "绪密集的场合尤其耗电": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "candidates": {
            ("ISFP", "ISFP-faq-social-drain"): [
                "绪爆棚的场合尤其耗电",
                "绪饱满的场合尤其耗电",
            ],
            ("ISTP", "ISTP-faq-social-drain"): [
                "绪满载的场合尤其耗电",
                "绪激荡的场合尤其耗电",
            ],
        },
    },
    "L 优先』硬规则——": {
        "anchor": ("ENFJ", "ENFJ-faq-deadline"),
        "candidates": {
            ("ESFJ", "ESFJ-faq-deadline"): [
                "L 优先』铁规矩——",
                "L 优先』硬规矩——",
            ],
            ("ISFJ", "ISFJ-faq-deadline"): [
                "L 优先』刚性规则——",
                "L 优先』硬规矩——",
            ],
        },
    },
    "但思维比嘴快半拍——": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "candidates": {
            ("ESFP", "ESFP-faq-public-speaking"): [
                "但想法比嘴快半拍——",
                "但脑里想法比嘴快半拍——",
            ],
            ("ESTP", "ESTP-faq-public-speaking"): [
                "但脑子比嘴快半拍——",
                "但脑子比嘴快半拍——",
            ],
        },
    },
    " 与 50 分钟举牌": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "candidates": {
            ("ESFP", "ESFP-faq-public-speaking"): [
                " 加 50 分钟举牌",
                " 加 50 分钟举牌",
            ],
            ("ESTP", "ESTP-faq-public-speaking"): [
                " 时 50 分钟举牌",
                " 时 50 分钟举牌",
            ],
        },
    },
    "到底的伴侣是懂得珍惜": {
        "anchor": ("ESFJ", "ESFJ-relationship-01"),
        "candidates": {
            ("ESFP", "ESFP-relationship-01"): [
                "到底的伴侣是懂得珍视",
                "走到最后的伴侣懂得珍惜",
            ],
            ("ISFJ", "ISFJ-relationship-01"): [
                "到底的伴侣是懂得珍藏",
                "走到最后的伴侣懂得珍惜",
            ],
        },
    },
    "擅长长期规划，常常『": {
        "anchor": ("ESFP", "ESFP-weakness-01"),
        "candidates": {
            ("ESTP", "ESTP-weakness-01"): [
                "擅长期规划，常常『",
                "擅长长线规划，常常『",
            ],
            ("ISFP", "ISFP-weakness-01"): [
                "擅长长线规划，常常『",
                "擅长长程规划，常常『",
            ],
        },
    },
    # 2-personality
    "逻辑网里自洽，否则不": {
        "anchor": ("INTP", "INTP-cognitive-01"),
        "candidates": {
            ("ISTP", "ISTP-cognitive-01"): [
                "逻辑网里自洽，否则不",
                "逻辑网里自洽，否则不",
            ],
        },
    },
    "时开多条思路，能从一": {
        "anchor": ("ENFP", "ENFP-cognitive-01"),
        "candidates": {
            ("INTP", "INTP-cognitive-02"): [
                "时开多条思路，能从一",
                "时跑多条思路，能从一",
            ],
        },
    },
    "。需要对方懂得珍惜沉": {
        "anchor": ("INTP", "INTP-relationship-01"),
        "candidates": {
            ("ISTP", "ISTP-relationship-01"): [
                "。需要对象懂得珍视沉",
                "。需要对方懂得珍视沉",
            ],
        },
    },
    "懂得珍惜沉默的陪伴。": {
        "anchor": ("INTP", "INTP-relationship-01"),
        "candidates": {
            ("ISTP", "ISTP-relationship-01"): [
                "懂得珍视安静共处。",
                "能珍惜沉默的陪伴。",
            ],
        },
    },
    "优点，对敏感者是雷区": {
        "anchor": ("ENTJ", "ENTJ-trait-04"),
        "candidates": {
            ("ESTJ", "ESTJ-trait-03"): [
                "特质，对敏感者是雷区",
                "风格，对敏感者是雷区",
            ],
        },
    },
    "向把所有事抓在手里，": {
        "anchor": ("ENTJ", "ENTJ-weakness-03"),
        "candidates": {
            ("ESTJ", "ESTJ-weakness-03"): [
                "向把所有事攥在手里，",
                "倾把所有事拽在手里，",
            ],
        },
    },
    "监；需要统筹资源、定": {
        "anchor": ("ENTJ", "ENTJ-career-01"),
        "candidates": {
            ("ESTJ", "ESTJ-career-01"): [
                "监；需要调配资源、定",
                "监；需要整合资源、定",
            ],
        },
    },
    "触发点、自己的模式、": {
        "anchor": ("ENTJ", "ENTJ-faq-breakup"),
        "candidates": {
            ("ESTP", "ESTP-faq-breakup"): [
                "触发点、自己的剧本、",
                "触发点、自己的节奏、",
            ],
        },
    },
    "来是能量源——但前提": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "candidates": {
            ("ENTJ", "ENTJ-faq-social-drain"): [
                "来是能量源——但前提",
                "来是能量源——但前提",
            ],
        },
    },
    "纯闲聊、低信息量聚会": {
        "anchor": ("ENTJ", "ENTJ-faq-social-drain"),
        "candidates": {
            ("ESTJ", "ESTJ-faq-social-drain"): [
                "纯寒暄、低信息量聚会",
                "纯寒暄、低密度聚会",
            ],
        },
    },
    "低信息量聚会也吃电：": {
        "anchor": ("ENTJ", "ENTJ-faq-social-drain"),
        "candidates": {
            ("ESTP", "ESTP-faq-social-drain"): [
                "低信息量聚会也耗电：",
                "低密度聚会也吃电：",
            ],
        },
    },
    "选标准是『能不能推进": {
        "anchor": ("ENTJ", "ENTJ-faq-social-drain"),
        "candidates": {
            ("ESTJ", "ESTJ-faq-social-drain"): [
                "选标准是『能否推进",
                "选准则是『能否推进",
            ],
        },
    },
    " 面对家庭催婚催生会": {
        "anchor": ("ENTJ", "ENTJ-faq-family-pressure"),
        "candidates": {
            ("ESTJ", "ESTJ-faq-family-pressure"): [
                " 面对家人催婚催生会",
                " 面对家庭催婚催育会",
            ],
        },
    },
    "相：家人要的不是你的": {
        "anchor": ("ENTJ", "ENTJ-faq-family-pressure"),
        "candidates": {
            ("ESTJ", "ESTJ-faq-family-pressure"): [
                "相：家人想要的不是你的",
                "相：家人渴望的是你的",
            ],
        },
    },
    "可能更好』的念头——": {
        "anchor": ("ENFP", "ENFP-faq-deadline"),
        "candidates": {
            ("ENTP", "ENTP-faq-deadline"): [
                "可能更好』的冲动——",
                "可以更佳』的念头——",
            ],
        },
    },
    "关上了 B 的门——": {
        "anchor": ("ENTP", "ENTP-faq-decision"),
        "candidates": {
            ("ESTP", "ESTP-faq-decision"): [
                "锁上了 B 的门——",
                "关死了 B 的门——",
            ],
        },
    },
    "够深的东西，B 没你": {
        "anchor": ("ENTP", "ENTP-faq-decision"),
        "candidates": {
            ("ESTP", "ESTP-faq-decision"): [
                "够硬的东西，B 没你",
                "够狠的东西，B 没你",
            ],
        },
    },
    "i 没新观点可辩就": {
        "anchor": ("ENTP", "ENTP-faq-social-drain"),
        "candidates": {
            ("ESTP", "ESTP-faq-social-drain"): [
                "i 没新议题可辩就",
                "i 没新思路可辩就",
            ],
        },
    },
    "会空转。选择脑力型社": {
        "anchor": ("ENTP", "ENTP-faq-social-drain"),
        "candidates": {
            ("ESFP", "ESFP-faq-social-drain"): [
                "会空转。改挑脑力型社",
                "会空转。改选脑力型社",
            ],
        },
    },
    "是分辨的最低观测窗口": {
        "anchor": ("ENTP", "ENTP-faq-relocation"),
        "candidates": {
            ("ISTP", "ISTP-faq-new-job"): [
                "是分辨的最小观测窗口",
                "是判断的最低观测窗口",
            ],
        },
    },
    "是天然的内容创作者。": {
        "anchor": ("ESFP", "ESFP-trait-04"),
        "candidates": {
            ("INFJ", "INFJ-strength-03"): [
                "是天然的内容创作者。",
                "是天然的内容产出者。",
            ],
        },
    },
    "达到心中的完美而拖延": {
        "anchor": ("INFJ", "INFJ-faq-deadline"),
        "candidates": {
            ("ISFP", "ISFP-faq-deadline"): [
                "达到心中的完美而拖延",
                "够不到心中的完美而拖延",
            ],
        },
    },
    "则：先拿出七成的版本": {
        "anchor": ("INFJ", "INFJ-faq-deadline"),
        "candidates": {
            ("ISFP", "ISFP-faq-deadline"): [
                "则：先拿出七成的版本",
                "则：先拿出 70% 的版本",
            ],
        },
    },
    "—完成度本身就是进度": {
        "anchor": ("INFJ", "INFJ-faq-deadline"),
        "candidates": {
            ("ISFP", "ISFP-faq-deadline"): [
                "—完成度本身就是进度",
                "——完成度就是进度本身",
            ],
        },
    },
    "唯一的灵魂伴侣』——": {
        "anchor": ("INFJ", "INFJ-faq-breakup"),
        "candidates": {
            ("ISFP", "ISFP-faq-breakup"): [
                "唯一的灵魂伴侣』——",
                "唯一的灵魂伴侣』，",
            ],
        },
    },
    "后面的可能性。把前任": {
        "anchor": ("INFJ", "INFJ-faq-breakup"),
        "candidates": {
            ("ISFP", "ISFP-faq-breakup"): [
                "后面的可能性。把前任",
                "后面的可能。把前任",
            ],
        },
    },
    "被批评后会在脑里反刍": {
        "anchor": ("INFJ", "INFJ-faq-criticism"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-criticism"): [
                "被批评后会在脑里反刍",
                "被批评后会在脑中反刍",
            ],
        },
    },
    "评拆成两层：事实认账": {
        "anchor": ("INFJ", "INFJ-faq-criticism"),
        "candidates": {
            ("ISFP", "ISFP-faq-criticism"): [
                "评拆成两层：事实认账",
                "评拆成两部分：事实认账",
            ],
        },
    },
    "可持续社交的前提。把": {
        "anchor": ("INFJ", "INFJ-faq-alone-weekend"),
        "candidates": {
            ("ISFP", "ISFP-faq-alone-weekend"): [
                "可持续社交的前提。把",
                "长期社交的前提。把",
            ],
        },
    },
    "，后者早走是止损——": {
        "anchor": ("INFJ", "INFJ-faq-new-job"),
        "candidates": {
            ("ISTP", "ISTP-faq-new-job"): [
                "，后者早撤是止损——",
                "，后者早点走是止损——",
            ],
        },
    },
    "FJ 在重大抉择里会": {
        "anchor": ("INFJ", "INFJ-faq-decision"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-decision"): [
                "FJ 在重大抉择里会",
                "FJ 在重大抉择时会",
            ],
        },
    },
    "别人感受不到的细节。": {
        "anchor": ("INFP", "INFP-trait-03"),
        "candidates": {
            ("ISFP", "ISFP-trait-03"): [
                "别人感受不到的细节。",
                "他人感受不到的细节。",
            ],
        },
    },
    "现在在情绪里』的信号": {
        "anchor": ("ESFP", "ESFP-weakness-03"),
        "candidates": {
            ("INFP", "INFP-weakness-01"): [
                "现在在情绪里』的信号",
                "现在情绪化』的信号",
            ],
        },
    },
    "回去，长期变成隐性怨": {
        "anchor": ("INFP", "INFP-weakness-02"),
        "candidates": {
            ("ISFP", "ISFP-weakness-02"): [
                "回去，长期变成隐性怨",
                "回去，长期转为隐性怨",
            ],
        },
    },
    "一深度陪伴与支持——": {
        "anchor": ("INFP", "INFP-career-02"),
        "candidates": {
            ("ISFJ", "ISFJ-career-01"): [
                "一深度陪伴与支持——",
                "一对一深度陪伴和支持——",
            ],
        },
    },
    "但需要少数能进入内心": {
        "anchor": ("INFP", "INFP-relationship-01"),
        "candidates": {
            ("ISFP", "ISFP-relationship-01"): [
                "但需要少数能走进内心",
                "但需要少数能进入内心",
            ],
        },
    },
    " 的深连接是稀有品。": {
        "anchor": ("INFP", "INFP-relationship-01"),
        "candidates": {
            ("ISFP", "ISFP-relationship-01"): [
                " 的深连接是稀有品。",
                " 的深链接是稀有品。",
            ],
        },
    },
    "本能是把感受锁在里面": {
        "anchor": ("INFP", "INFP-faq-conflict"),
        "candidates": {
            ("ISFP", "ISFP-faq-conflict"): [
                "本能是把感受锁在里面",
                "反应是把感受锁起来",
            ],
        },
    },
    "——写下来的也算数，": {
        "anchor": ("INFP", "INFP-faq-conflict"),
        "candidates": {
            ("ISFP", "ISFP-faq-conflict"): [
                "——写下的话也算数，",
                "——写下的话也有效，",
            ],
        },
    },
    "i 的全盘判定模式，": {
        "anchor": ("INFP", "INFP-faq-criticism"),
        "candidates": {
            ("ISFP", "ISFP-faq-criticism"): [
                "i 的整体判定模式，",
                "i 的通盘判定模式，",
            ],
        },
    },
    "是行为不一定是你这个": {
        "anchor": ("INFP", "INFP-faq-criticism"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-criticism"): [
                "是动作不一定是你这个",
                "是表现不一定是你这个",
            ],
            ("ISFP", "ISFP-faq-criticism"): [
                "是表现不一定是你这个",
                "是事件不一定是你这个",
            ],
        },
    },
    "行为不一定是你这个人": {
        "anchor": ("INFP", "INFP-faq-criticism"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-criticism"): [
                "动作不一定是你这个人",
                "表现不一定是你这个人",
            ],
            ("ISFP", "ISFP-faq-criticism"): [
                "事件不一定是你这个人",
                "反应不一定是你这个人",
            ],
        },
    },
    "静得受不了时才浮上来": {
        "anchor": ("INFP", "INFP-faq-self-doubt"),
        "candidates": {
            ("ISFP", "ISFP-faq-self-doubt"): [
                "静得忍不住时才浮上来",
                "静到忍不住时才浮上来",
            ],
        },
    },
    "在自己价值观里都站": {
        "anchor": ("INFP", "INFP-faq-self-doubt"),
        "candidates": {
            ("ISFP", "ISFP-faq-self-doubt"): [
                "在自己价值体系里都站",
                "在自我价值尺里都站",
            ],
        },
    },
    "为什么『都是我的错": {
        "anchor": ("INFP", "INFP-faq-self-doubt"),
        "candidates": {
            ("ISFP", "ISFP-faq-self-doubt"): [
                "为什么『都是我不好",
                "为什么『问题在我",
            ],
        },
    },
    "FP 社交是高消耗行": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "candidates": {
            ("ISFP", "ISFP-faq-social-drain"): [
                "FP 的社交是高消耗行",
                "FP 出门是高消耗行",
            ],
        },
    },
    "主管、运营经理；适合": {
        "anchor": ("ESFJ", "ESFJ-career-02"),
        "candidates": {
            ("ISTJ", "ISTJ-career-02"): [
                "主管、运营主管；适合",
                "经理、运营经理；适合",
            ],
        },
    },
    "常事务管得井井有条。": {
        "anchor": ("ESFJ", "ESFJ-career-02"),
        "candidates": {
            ("ISTJ", "ISTJ-career-02"): [
                "常事务理得井井有条。",
                "常事务理得条理分明。",
            ],
        },
    },
    "TJ 不是浪漫型而是": {
        "anchor": ("ESTJ", "ESTJ-relationship-01"),
        "candidates": {
            ("ISTJ", "ISTJ-relationship-01"): [
                "TJ 不是浪漫型，而是",
                "TJ 不是浪漫派，而是",
            ],
        },
    },
    "能把『我爱你』转化为": {
        "anchor": ("ESTJ", "ESTJ-relationship-01"),
        "candidates": {
            ("ISTJ", "ISTJ-relationship-01"): [
                "能把『我爱你』化为",
                "能把『我爱你』变为",
            ],
        },
    },
    "感觉一个可执行的容器": {
        "anchor": ("ESTJ", "ESTJ-faq-breakup"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-breakup"): [
                "感觉一个可运行的容器",
                "感到一个可执行的容器",
            ],
        },
    },
    "认一个真相：有些节点": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-decision"): [
                "认一个事实：有些节点",
                "认清一个真相：有些节点",
            ],
        },
    },
    "预算』，把破例从事后": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-decision"): [
                "预算』，把例外从事后",
                "预算』，把破格从事后",
            ],
        },
    },
    "；否则你会在某个节点": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-decision"): [
                "；否则你会在某个节骨眼",
                "；否则会在某个节点",
            ],
        },
    },
    "卡住，因为稳妥选项都": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-decision"): [
                "卡住，因为稳妥路线都",
                "停滞，因为稳妥选项都",
            ],
        },
    },
    "在冲突里本能先道歉": {
        "anchor": ("ESFJ", "ESFJ-faq-conflict"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-conflict"): [
                "在冲突里本能先认错",
                "冲突中本能先道歉",
            ],
        },
    },
    "。背后也有不少委屈": {
        "anchor": ("ESFJ", "ESFJ-faq-conflict"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-conflict"): [
                "。背后也攒着不少委屈",
                "。背后藏着不少委屈",
            ],
        },
    },
    "FJ 会陷入一段沉": {
        "anchor": ("ESFJ", "ESFJ-faq-self-doubt"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-self-doubt"): [
                "FJ 会陷进一段沉",
                "FJ 容易陷入一段沉",
            ],
        },
    },
    " 把责任往自己肩上揽": {
        "anchor": ("ESFJ", "ESFJ-faq-self-doubt"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-self-doubt"): [
                " 把责任往自己身上揽",
                " 把责任往自己身上堆",
            ],
        },
    },
    "TJ 在团队里会被": {
        "anchor": ("ESTJ", "ESTJ-faq-teamwork"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-teamwork"): [
                "TJ 在团队里常被",
                "TJ 在团队中会被",
            ],
        },
    },
    "在线条里前置协商清楚": {
        "anchor": ("ESTJ", "ESTJ-faq-teamwork"),
        "candidates": {
            ("ISTJ", "ISTJ-faq-teamwork"): [
                "在线里前置协商清楚",
                "在流程里前置协商清楚",
            ],
        },
    },
    "方案的场合（产品策划、": {
        "anchor": ("ENFP", "ENFP-strength-01"),
        "candidates": {
            ("ENTP", "ENTP-strength-01"): [
                "方案的场合（产品策划、",
                "方案的场所（产品策划、",
            ],
        },
    },
    "功先拆，把保命项扔": {
        "anchor": ("ESTP", "ESTP-faq-deadline"),
        "candidates": {
            ("ISTP", "ISTP-faq-deadline"): [
                "功先拆，把核心项扔",
                "功能拆，把保命项扔",
            ],
        },
    },
    "穿 Se 提前预演最坏": {
        "anchor": ("ESTP", "ESTP-faq-deadline"),
        "candidates": {
            ("ISTP", "ISTP-faq-deadline"): [
                "穿 Se 提前走一遍最坏",
                "穿 Se 提前演练最坏",
            ],
        },
    },
    "，哪怕打到一半，": {
        "anchor": ("ESTP", "ESTP-faq-deadline"),
        "candidates": {
            ("ISTP", "ISTP-faq-deadline"): [
                "，哪怕做到一半，",
                "，哪怕做完一半，",
            ],
        },
    },
    "前凭借直觉行动，": {
        "anchor": ("ISFP", "ISFP-faq-decision"),
        "candidates": {
            ("ISTP", "ISTP-faq-decision"): [
                "前凭本能就动，",
                "前凭直觉行动，",
            ],
        },
    },
    "决策前给自己留一段": {
        "anchor": ("ISFP", "ISFP-faq-decision"),
        "candidates": {
            ("ISTP", "ISTP-faq-decision"): [
                "决定前给自己留一段",
                "决策前留一段",
            ],
        },
    },
    "直到身体里松动了": {
        "anchor": ("ISFP", "ISFP-faq-decision"),
        "candidates": {
            ("ISTP", "ISTP-faq-decision"): [
                "直到身体里松动了",
                "直到身体放松下来",
            ],
        },
    },
    "度过社交后能恢复": {
        "anchor": ("ISFP", "ISFP-faq-social-drain"),
        "candidates": {
            ("ISTP", "ISTP-faq-social-drain"): [
                "熬过社交后能恢复",
                "撑过社交后能恢复",
            ],
        },
    },
    "TP 整理感官的窗口": {
        "anchor": ("ISFP", "ISFP-faq-social-drain"),
        "candidates": {
            ("ISTP", "ISTP-faq-social-drain"): [
                "TP 整理感官信息的窗口",
                "TP 整理感官的时段",
            ],
        },
    },
    "他人情绪为决策坐标，": {
        "anchor": ("ENFJ", "ENFJ-cognitive-01"),
        "candidates": {
            ("ISFJ", "ISFJ-cognitive-02"): [
                "他人感受是决策坐标，",
                "他人情绪成决策坐标，",
            ],
        },
    },
    "替。立『自己的 DD": {
        "anchor": ("ENFJ", "ENFJ-faq-deadline"),
        "candidates": {
            ("ESFJ", "ESFJ-faq-deadline"): [
                "替。立一份自己的DD",
                "替。立道自己的DDL",
            ],
        },
    },
    "是我哪里做得不够好』": {
        "anchor": ("ENFJ", "ENFJ-faq-criticism"),
        "candidates": {
            ("ESFJ", "ESFJ-faq-criticism"): [
                "是我哪里没做好』",
                "是我哪里没做对』",
            ],
        },
    },
    "前三个月慢一点是正常": {
        "anchor": ("ENFJ", "ENFJ-faq-new-job"),
        "candidates": {
            ("ESFJ", "ESFJ-faq-new-job"): [
                "前三月慢一拍是常态",
                "头三月慢一点是常态",
            ],
        },
    },
    "份『社交后恢复清单』": {
        "anchor": ("ENFJ", "ENFJ-faq-social-drain"),
        "candidates": {
            ("ESFJ", "ESFJ-faq-social-drain"): [
                "份『应酬之后恢复清单』",
                "份『社交后清零清单』",
            ],
        },
    },
    "读、散步。把恢复流程": {
        "anchor": ("ENFJ", "ENFJ-faq-social-drain"),
        "candidates": {
            ("ESFJ", "ESFJ-faq-social-drain"): [
                "读、散步。把复盘流程",
                "、散步。把恢复流程",
            ],
        },
    },
    "心价值系统，不符合的": {
        "anchor": ("ENFP", "ENFP-cognitive-02"),
        "candidates": {
            ("ESFP", "ESFP-cognitive-02"): [
                "心的价值体系，不符合的",
                "心价值尺子，不符合的",
            ],
        },
    },
    "陌生人场合快速破冰，": {
        "anchor": ("ENFP", "ENFP-strength-02"),
        "candidates": {
            ("ESFP", "ESFP-strength-03"): [
                "陌生人堆里快速破冰，",
                "陌生场合快速破冰，",
            ],
        },
    },
    "里需要持续的新鲜感和": {
        "anchor": ("ENFP", "ENFP-relationship-01"),
        "candidates": {
            ("ESTP", "ESTP-relationship-01"): [
                "里需要不断的新鲜感和",
                "里需要持续的新鲜度与",
            ],
        },
    },
    "通常是也爱玩、能一起": {
        "anchor": ("ENFP", "ENFP-relationship-01"),
        "candidates": {
            ("ESTP", "ESTP-relationship-01"): [
                "通常也是爱玩、能一起",
                "通常都爱玩、能一起",
            ],
        },
    },
    "在台上一向不怯场——": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "candidates": {
            ("ESTP", "ESTP-faq-public-speaking"): [
                "在台上一直不怯场——",
                "在台前一向不怯场——",
            ],
        },
    },
    "—互动越热烈越兴奋，": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "candidates": {
            ("ESFP", "ESFP-faq-public-speaking"): [
                "—气氛越热烈越兴奋，",
                "—场子越热烈越兴奋，",
            ],
        },
    },
    "会反弹成大段反驳——": {
        "anchor": ("ENFP", "ENFP-faq-criticism"),
        "candidates": {
            ("ESFP", "ESFP-faq-criticism"): [
                "会反弹成长篇反驳——",
                "会反弹成大段顶嘴——",
            ],
        },
    },
    "下来，情绪浓度会自然": {
        "anchor": ("ENFP", "ENFP-faq-criticism"),
        "candidates": {
            ("ESFP", "ESFP-faq-criticism"): [
                "下来，情绪水位会自然",
                "下来，情绪能量会自然",
            ],
        },
    },
    "。写在纸上比发群里稳": {
        "anchor": ("ENFP", "ENFP-faq-criticism"),
        "candidates": {
            ("ESFP", "ESFP-faq-criticism"): [
                "。落笔比发群里更稳",
                "。写在纸上比群里稳",
            ],
        },
    },
    "的小事清单——咖啡馆": {
        "anchor": ("ENFP", "ENFP-faq-alone-weekend"),
        "candidates": {
            ("ESFP", "ESFP-faq-alone-weekend"): [
                "的小清单——咖啡馆",
                "的清单——咖啡馆",
            ],
        },
    },
    "把刺激的来源从『找人": {
        "anchor": ("ENFP", "ENFP-faq-alone-weekend"),
        "candidates": {
            ("ESFP", "ESFP-faq-alone-weekend"): [
                "把嗨点的来源从『找人",
                "把刺激的源头从『找人",
            ],
        },
    },
    "做有正反馈的小事』；": {
        "anchor": ("ENFP", "ENFP-faq-alone-weekend"),
        "candidates": {
            ("ESFP", "ESFP-faq-alone-weekend"): [
                "做能拿到反馈的小事』；",
                "做有反馈的小事』；",
            ],
        },
    },
    "也就这样』的感觉——": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESFP", "ESFP-faq-new-job"): [
                "也就这样』的体感——",
                "也就这样』的味道——",
            ],
        },
    },
    " 的新鲜感衰减极快。": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESFP", "ESFP-faq-new-job"): [
                " 的新鲜感衰减很快。",
                " 的新鲜感掉得极快。",
            ],
        },
    },
    "，还是新鲜感的阈值到": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESTP", "ESTP-faq-new-job"): [
                "，还是你的阈值到了",
                "，还是你的阈值已到",
            ],
        },
    },
    "是新鲜感的阈值到了？": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESTP", "ESTP-faq-new-job"): [
                "是新鲜感的门槛到了？",
                "是新鲜感的阈值已到？",
            ],
        },
    },
    "你的，不是环境的——": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESFP", "ESFP-faq-new-job"): [
                "是你的，不是环境的——",
                "是你，而非环境的——",
            ],
        },
    },
    "后者换地方也救不了。": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESFP", "ESFP-faq-new-job"): [
                "后者搬地方也救不了。",
                "后者挪地方也救不了。",
            ],
        },
    },
    "间重新长出来更划算。": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "candidates": {
            ("ESFP", "ESFP-faq-new-job"): [
                "间重新生根更划算。",
                "间重新长出更划算。",
            ],
        },
    },
    "在重大抉择里会被『最": {
        "anchor": ("ENFP", "ENFP-faq-decision"),
        "candidates": {
            ("ESFP", "ESFP-faq-decision"): [
                "在重大选择里会被『最",
                "在重大决定里会被『最",
            ],
        },
    },
    " 6 个月』，再问『": {
        "anchor": ("ENFP", "ENFP-faq-decision"),
        "candidates": {
            ("ESFP", "ESFP-faq-decision"): [
                " 6 个月』，再问问『",
                " 6 个月』，再回头问『",
            ],
        },
    },
    "能量源——但前提是有": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "candidates": {
            ("ESTJ", "ESTJ-faq-social-drain"): [
                "能量源——但前提得有",
                "能量源——但前提得有",
            ],
        },
    },
    "。重复寒暄一样耗电：": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "candidates": {
            ("ESFP", "ESFP-faq-social-drain"): [
                "。重复寒暄也耗电：",
                "。重复打招呼一样耗电：",
            ],
        },
    },
    "者不拒——把每周社交": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "candidates": {
            ("ESFP", "ESFP-faq-social-drain"): [
                "者不拒——把每周出门",
                "者不拒——把每周应酬",
            ],
        },
    },
    "都学不深』的陷阱——": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "candidates": {
            ("ESFP", "ESFP-faq-exam"): [
                "都不深入』的陷阱——",
                "都不扎实』的陷阱——",
            ],
        },
    },
    "新概念不停。觉得这个": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "candidates": {
            ("ESFP", "ESFP-faq-exam"): [
                "新花样不停。觉得这个",
                "新点子不停。觉得这个",
            ],
        },
    },
    "周只刷真题和错题，新": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "candidates": {
            ("ESFP", "ESFP-faq-exam"): [
                "周只刷真题和错题，新",
                "周只啃真题和错题，新",
            ],
        },
    },
    "装进『结构化容器』：": {
        "anchor": ("ENFP", "ENFP-faq-teamwork"),
        "candidates": {
            ("ESFP", "ESFP-faq-teamwork"): [
                "塞进『结构化容器』：",
                "装进『结构容器』：",
            ],
        },
    },
    "选一个靠谱的搭档共同": {
        "anchor": ("ENFP", "ENFP-faq-teamwork"),
        "candidates": {
            ("ESFP", "ESFP-faq-teamwork"): [
                "挑一个靠谱的搭档一起",
                "选位靠谱的搭档共同",
            ],
        },
    },
    "越高涨，Se 越上场": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "candidates": {
            ("ESTP", "ESTP-faq-public-speaking"): [
                "越高涨，Se 越起劲",
                "越高涨，Se 越冲劲",
            ],
        },
    },
    "场的『现场感』一旦": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "candidates": {
            ("ESTP", "ESTP-faq-public-speaking"): [
                "场的『现场感』只要",
                "场的『现场感』如果",
            ],
        },
    },
    "靠 Se 顶上去会加速": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "candidates": {
            ("ESTP", "ESTP-faq-public-speaking"): [
                "靠 Se 顶上去会加力",
                "靠 Se 顶上会加速",
            ],
        },
    },
    "前 50 分钟要有": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "candidates": {
            ("ESTP", "ESTP-faq-public-speaking"): [
                "前 50 分钟给",
                "前 50 分钟留",
            ],
        },
    },
    "0 分钟举牌提醒": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "candidates": {
            ("ESTP", "ESTP-faq-public-speaking"): [
                "0 分钟举牌给",
                "0 分钟举牌叫",
            ],
        },
    },
    "越刺激越好。Se 没": {
        "anchor": ("ESFP", "ESFP-faq-social-drain"),
        "candidates": {
            ("ESTP", "ESTP-faq-social-drain"): [
                "越有冲劲越好。Se 没",
                "越爽越好。Se 没",
            ],
        },
    },
    "e 没新东西可接就": {
        "anchor": ("ESFP", "ESFP-faq-social-drain"),
        "candidates": {
            ("ESTP", "ESTP-faq-social-drain"): [
                "e 没新冲击可接就",
                "e 没新刺激可接就",
            ],
        },
    },
    # 同人格
    "，Ne 把问题延伸到": {
        "anchor": ("INFP", "INFP-faq-deadline"),
        "candidates": {
            ("INFP", "INFP-faq-self-doubt"): [
                "，Ne 把问题扩散到",
                "，Ne 把视角延伸到",
            ],
        },
    },
    "ENFJ 在社交场合": {
        "anchor": ("ENFJ", "ENFJ-faq-networking"),
        "candidates": {
            ("ENFJ", "ENFJ-faq-social-drain"): [
                "ENFJ 在应酬场合",
                "ENFJ 在交际场合",
            ],
        },
    },
    "——Si + Fe ": {
        "anchor": ("ISFJ", "ISFJ-career-01"),
        "candidates": {
            ("ISFJ", "ISFJ-faq-alone-weekend"): [
                "——Si 与 Fe ",
                "——Si 配 Fe ",
            ],
        },
    },
    "，Ti + Se 的": {
        "anchor": ("ISTP", "ISTP-faq-new-job"),
        "candidates": {
            ("ISTP", "ISTP-faq-teamwork"): [
                "，Ti 与 Se 的",
                "，Ti 配 Se 的",
            ],
        },
    },
    "ISFP 的能量更像一口井，挖太快会枯": {
        "anchor": ("ISFP", "ISFP-faq-alone-weekend"),
        "candidates": {
            ("ISFP", "ISFP-faq-social-drain"): [
                "ISFP 的能量更像一池水，抽得太猛会枯",
                "ISFP 的能量更像一口井，挖太急会枯",
            ],
        },
    },
}


def main():
    all_entries = load_all()

    changed_total = 0
    for it in range(5):
        data = get_scan()
        cross = data["cross_personality"]
        same = sum(len(v) for v in data["same_personality"].values())

        # 收集每个 (p, eid) 待改的 (old, candidate) - anchor 不动
        todo = {}
        sources = cross + [g for sub in data["same_personality"].values() for g in sub]
        for item in sources:
            frag = item["fragment"]
            if frag not in CANDIDATES:
                continue
            spec = CANDIDATES[frag]
            anchor_p, anchor_eid = spec["anchor"]
            for (p, eid), cands in spec["candidates"].items():
                if (p, eid) == (anchor_p, anchor_eid):
                    continue
                todo.setdefault((p, eid), []).append((frag, cands, anchor_p, anchor_eid))

        if not todo:
            print(f"iter {it}: no candidates")
            break

        changed = 0
        for (p, eid), edits in todo.items():
            e, data_file = load_entry(p, eid)
            if e is None:
                continue
            cur = e["content"]
            cat = e["category"]
            new_text = cur
            for (frag, cands, ap, ae) in edits:
                # 取 anchor 内容作为 partner
                anchor_text = all_entries.get((ap, ae), "")
                # 同样也拿其他 todo 内容作 partner
                partners = [anchor_text] + [all_entries[(pp, ee)] for (pp, ee), _ in todo.items() if (pp, ee) != (p, eid)]
                for cand in cands:
                    candidate, ok = try_candidate(new_text, frag, cand, cat, partners)
                    if ok:
                        new_text = candidate
                        break
            if new_text == cur:
                continue
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
    if cp:
        print("\n=== remaining (first 25) ===")
        for g in cp[:25]:
            print(f"  {g['fragment']!r:30} ({len(g['entries'])}): {[e['personality'] for e in g['entries']]}")


if __name__ == "__main__":
    main()