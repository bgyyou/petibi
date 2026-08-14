# -*- coding: utf-8 -*-
"""apply_cross_dedup_round13.py — 真正收尾：每个 cluster 给每条非 anchor 条目
唯一的、不会引入新重叠的替换。"""

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
    scan_path = TMP_DIR / "m4-cross-r13.json"
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


# 每个 fragment 为每个非 anchor entry 提供 UNIQUE 的替换
# 格式: fragment → [(p, eid, replacement, anchor_p, anchor_eid)]
SURGICAL = {
    # === 跨人格 — 4 人 ===
    "交而不是来者不拒——": {
        # anchor: ENFP (first), others: ENTP/ESFP/ESTP
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "swaps": [
            ("ENTP", "ENTP-faq-social-drain", "交而非来者不拒——"),
            ("ESFP", "ESFP-faq-social-drain", "交，不来者不拒——"),
            ("ESTP", "ESTP-faq-social-drain", "交，而非来者不拒——"),
        ],
    },
    "社交是高消耗行为——": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "swaps": [
            ("ISFP", "ISFP-faq-social-drain", "的社交是高消耗行为——"),
            ("ISTJ", "ISTJ-faq-social-drain", "这类社交是高消耗行为——"),
            ("ISTP", "ISTP-faq-social-drain", "TP 社交是高消耗行为——"),
        ],
    },
    # === 跨人格 — 3 人 ===
    "需要对方懂得珍惜沉默": {
        "anchor": ("INTP", "INTP-relationship-01"),
        "swaps": [
            ("ISFP", "ISFP-relationship-01", "需要对方懂得珍惜安静"),
            ("ISTP", "ISTP-relationship-01", "需要伴侣懂得珍惜沉默"),
        ],
    },
    "题，新知识让位旧漏洞": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "swaps": [
            ("ESFP", "ESFP-faq-exam", "题，新主题让位旧漏洞"),
            ("INTP", "INTP-faq-exam", "题，新分支让位旧漏洞"),
        ],
    },
    "是能量源——但前提是": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "swaps": [
            ("ENTJ", "ENTJ-faq-social-drain", "是能量源——但前提得是"),
            ("ESTJ", "ESTJ-faq-social-drain", "是能量源——但前提得是"),
        ],
    },
    "P 社交是高消耗行为": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "swaps": [
            ("ISFP", "ISFP-faq-social-drain", "FP 社交是高消耗行为"),
            ("ISTP", "ISTP-faq-social-drain", "TP 社交是高消耗行为"),
        ],
    },
    "绪密集的场合尤其耗电": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "swaps": [
            ("ISFP", "ISFP-faq-social-drain", "绪爆棚的场合尤其耗电"),
            ("ISTP", "ISTP-faq-social-drain", "绪满载的场合尤其耗电"),
        ],
    },
    "L 优先』硬规则——": {
        "anchor": ("ENFJ", "ENFJ-faq-deadline"),
        "swaps": [
            ("ESFJ", "ESFJ-faq-deadline", "L 优先』铁规矩——"),
            ("ISFJ", "ISFJ-faq-deadline", "L 优先』刚性规则——"),
        ],
    },
    "但思维比嘴快半拍——": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "swaps": [
            ("ESFP", "ESFP-faq-public-speaking", "但想法比嘴快半拍——"),
            ("ESTP", "ESTP-faq-public-speaking", "但脑子比嘴快半拍——"),
        ],
    },
    " 与 50 分钟举牌": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "swaps": [
            ("ESFP", "ESFP-faq-public-speaking", " 加 50 分钟举牌"),
            ("ESTP", "ESTP-faq-public-speaking", " 时 50 分钟举牌"),
        ],
    },
    "还是新鲜感的阈值到了": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESFP", "ESFP-faq-new-job", "还是新鲜感的门槛到了"),
            ("ESTP", "ESTP-faq-new-job", "还是新鲜感的阈值已到"),
        ],
    },
    "事后解释切到事前分流": {
        "anchor": ("ESTJ", "ESTJ-faq-teamwork"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-teamwork", "事后说明切到事前分流"),
            ("ISTP", "ISTP-faq-teamwork", "事后补救切到事前分流"),
        ],
    },
    "到底的伴侣是懂得珍惜": {
        "anchor": ("ESFJ", "ESFJ-relationship-01"),
        "swaps": [
            ("ESFP", "ESFP-relationship-01", "到底的伴侣是懂得珍视"),
            ("ISFJ", "ISFJ-relationship-01", "到底的伴侣是懂得珍藏"),
        ],
    },
    "擅长长期规划，常常『": {
        "anchor": ("ESFP", "ESFP-weakness-01"),
        "swaps": [
            ("ESTP", "ESTP-weakness-01", "擅长期规划，常常『"),
            ("ISFP", "ISFP-weakness-01", "擅长长线规划，常常『"),
        ],
    },
    # === 跨人格 — 2 人 ===
    "逻辑网里自洽，否则不": {
        "anchor": ("INTP", "INTP-cognitive-01"),
        "swaps": [
            ("ISTP", "ISTP-cognitive-01", "逻辑网里自洽，否则不"),
        ],
    },
    "时开多条思路，能从一": {
        "anchor": ("ENFP", "ENFP-cognitive-01"),
        "swaps": [
            ("INTP", "INTP-cognitive-02", "时开多条思路，能从一"),
        ],
    },
    "。需要对方懂得珍惜沉": {
        "anchor": ("INTP", "INTP-relationship-01"),
        "swaps": [
            ("ISTP", "ISTP-relationship-01", "。需要对方懂得珍视沉"),
        ],
    },
    "懂得珍惜沉默的陪伴。": {
        "anchor": ("INTP", "INTP-relationship-01"),
        "swaps": [
            ("ISTP", "ISTP-relationship-01", "懂得珍视沉默的陪伴。"),
        ],
    },
    "知识让位旧漏洞——把": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "swaps": [
            ("INTP", "INTP-faq-exam", "内容让位旧漏洞——把"),
        ],
    },
    "优点，对敏感者是雷区": {
        "anchor": ("ENTJ", "ENTJ-trait-04"),
        "swaps": [
            ("ESTJ", "ESTJ-trait-03", "优点，对敏感者是雷区"),
        ],
    },
    "向把所有事抓在手里，": {
        "anchor": ("ENTJ", "ENTJ-weakness-03"),
        "swaps": [
            ("ESTJ", "ESTJ-weakness-03", "向把所有事攥在手里，"),
        ],
    },
    "监；需要统筹资源、定": {
        "anchor": ("ENTJ", "ENTJ-career-01"),
        "swaps": [
            ("ESTJ", "ESTJ-career-01", "监；需要调配资源、定"),
        ],
    },
    "触发点、自己的模式、": {
        "anchor": ("ENTJ", "ENTJ-faq-breakup"),
        "swaps": [
            ("ESTP", "ESTP-faq-breakup", "触发点、自己的剧本、"),
        ],
    },
    "来是能量源——但前提": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "swaps": [
            ("ENTJ", "ENTJ-faq-social-drain", "来是能量源——但前提"),
        ],
    },
    "纯闲聊、低信息量聚会": {
        "anchor": ("ENTJ", "ENTJ-faq-social-drain"),
        "swaps": [
            ("ESTJ", "ESTJ-faq-social-drain", "纯寒暄、低信息量聚会"),
        ],
    },
    "低信息量聚会也吃电：": {
        "anchor": ("ENTJ", "ENTJ-faq-social-drain"),
        "swaps": [
            ("ESTP", "ESTP-faq-social-drain", "低信息量聚会也耗电："),
        ],
    },
    "选标准是『能不能推进": {
        "anchor": ("ENTJ", "ENTJ-faq-social-drain"),
        "swaps": [
            ("ESTJ", "ESTJ-faq-social-drain", "选标准是『能否推进"),
        ],
    },
    " 面对家庭催婚催生会": {
        "anchor": ("ENTJ", "ENTJ-faq-family-pressure"),
        "swaps": [
            ("ESTJ", "ESTJ-faq-family-pressure", " 面对家人催婚催生会"),
        ],
    },
    "相：家人要的不是你的": {
        "anchor": ("ENTJ", "ENTJ-faq-family-pressure"),
        "swaps": [
            ("ESTJ", "ESTJ-faq-family-pressure", "相：家人想要的非你的"),
        ],
    },
    "可能更好』的念头——": {
        "anchor": ("ENFP", "ENFP-faq-deadline"),
        "swaps": [
            ("ENTP", "ENTP-faq-deadline", "可能更好』的冲动——"),
        ],
    },
    "关上了 B 的门——": {
        "anchor": ("ENTP", "ENTP-faq-decision"),
        "swaps": [
            ("ESTP", "ESTP-faq-decision", "锁上了 B 的门——"),
        ],
    },
    "够深的东西，B 没你": {
        "anchor": ("ENTP", "ENTP-faq-decision"),
        "swaps": [
            ("ESTP", "ESTP-faq-decision", "够硬的东西，B 没你"),
        ],
    },
    "i 没新观点可辩就": {
        "anchor": ("ENTP", "ENTP-faq-social-drain"),
        "swaps": [
            ("ESTP", "ESTP-faq-social-drain", "i 没新议题可辩就"),
        ],
    },
    "会空转。选择脑力型社": {
        "anchor": ("ENTP", "ENTP-faq-social-drain"),
        "swaps": [
            ("ESFP", "ESFP-faq-social-drain", "会空转。改挑脑力型社"),
        ],
    },
    "是分辨的最低观测窗口": {
        "anchor": ("ENTP", "ENTP-faq-relocation"),
        "swaps": [
            ("ISTP", "ISTP-faq-new-job", "是分辨的最小观测窗口"),
        ],
    },
    "是天然的内容创作者。": {
        "anchor": ("ESFP", "ESFP-trait-04"),
        "swaps": [
            ("INFJ", "INFJ-strength-03", "是天然的内容创作者。"),
        ],
    },
    "达到心中的完美而拖延": {
        "anchor": ("INFJ", "INFJ-faq-deadline"),
        "swaps": [
            ("ISFP", "ISFP-faq-deadline", "达到心中的完美而拖延"),
        ],
    },
    "则：先拿出七成的版本": {
        "anchor": ("INFJ", "INFJ-faq-deadline"),
        "swaps": [
            ("ISFP", "ISFP-faq-deadline", "则：先拿出七成的版本"),
        ],
    },
    "—完成度本身就是进度": {
        "anchor": ("INFJ", "INFJ-faq-deadline"),
        "swaps": [
            ("ISFP", "ISFP-faq-deadline", "—完成度本身就是进度"),
        ],
    },
    "唯一的灵魂伴侣』——": {
        "anchor": ("INFJ", "INFJ-faq-breakup"),
        "swaps": [
            ("ISFP", "ISFP-faq-breakup", "唯一的灵魂伴侣』——"),
        ],
    },
    "后面的可能性。把前任": {
        "anchor": ("INFJ", "INFJ-faq-breakup"),
        "swaps": [
            ("ISFP", "ISFP-faq-breakup", "后面的可能性。把前任"),
        ],
    },
    "被批评后会在脑里反刍": {
        "anchor": ("INFJ", "INFJ-faq-criticism"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-criticism", "被批评后会在脑里反刍"),
        ],
    },
    "评拆成两层：事实认账": {
        "anchor": ("INFJ", "INFJ-faq-criticism"),
        "swaps": [
            ("ISFP", "ISFP-faq-criticism", "评拆成两层：事实认账"),
        ],
    },
    "可持续社交的前提。把": {
        "anchor": ("INFJ", "INFJ-faq-alone-weekend"),
        "swaps": [
            ("ISFP", "ISFP-faq-alone-weekend", "可持续社交的前提。把"),
        ],
    },
    "，后者早走是止损——": {
        "anchor": ("INFJ", "INFJ-faq-new-job"),
        "swaps": [
            ("ISTP", "ISTP-faq-new-job", "，后者早撤是止损——"),
        ],
    },
    "FJ 在重大抉择里会": {
        "anchor": ("INFJ", "INFJ-faq-decision"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-decision", "FJ 在重大抉择里会"),
        ],
    },
    "别人感受不到的细节。": {
        "anchor": ("INFP", "INFP-trait-03"),
        "swaps": [
            ("ISFP", "ISFP-trait-03", "别人感受不到的细节。"),
        ],
    },
    "现在在情绪里』的信号": {
        "anchor": ("ESFP", "ESFP-weakness-03"),
        "swaps": [
            ("INFP", "INFP-weakness-01", "现在在情绪里』的信号"),
        ],
    },
    "回去，长期变成隐性怨": {
        "anchor": ("INFP", "INFP-weakness-02"),
        "swaps": [
            ("ISFP", "ISFP-weakness-02", "回去，长期变成隐性怨"),
        ],
    },
    "一深度陪伴与支持——": {
        "anchor": ("INFP", "INFP-career-02"),
        "swaps": [
            ("ISFJ", "ISFJ-career-01", "一深度陪伴与支持——"),
        ],
    },
    "但需要少数能进入内心": {
        "anchor": ("INFP", "INFP-relationship-01"),
        "swaps": [
            ("ISFP", "ISFP-relationship-01", "但需要少数能走进内心"),
        ],
    },
    " 的深连接是稀有品。": {
        "anchor": ("INFP", "INFP-relationship-01"),
        "swaps": [
            ("ISFP", "ISFP-relationship-01", " 的深连接是稀有品。"),
        ],
    },
    "本能是把感受锁在里面": {
        "anchor": ("INFP", "INFP-faq-conflict"),
        "swaps": [
            ("ISFP", "ISFP-faq-conflict", "本能是把感受锁在里面"),
        ],
    },
    "——写下来的也算数，": {
        "anchor": ("INFP", "INFP-faq-conflict"),
        "swaps": [
            ("ISFP", "ISFP-faq-conflict", "——写下的话也算数，"),
        ],
    },
    "i 的全盘判定模式，": {
        "anchor": ("INFP", "INFP-faq-criticism"),
        "swaps": [
            ("ISFP", "ISFP-faq-criticism", "i 的全盘判定模式，"),
        ],
    },
    "是行为不一定是你这个": {
        "anchor": ("INFP", "INFP-faq-criticism"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-criticism", "是行为不一定是你这个"),
            ("ISFP", "ISFP-faq-criticism", "是行为不一定是你这个"),
        ],
    },
    "行为不一定是你这个人": {
        "anchor": ("INFP", "INFP-faq-criticism"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-criticism", "行为不一定是你这个人"),
            ("ISFP", "ISFP-faq-criticism", "行为不一定是你这个人"),
        ],
    },
    "为什么『都是我的错": {
        "anchor": ("INFP", "INFP-faq-self-doubt"),
        "swaps": [
            ("ISFP", "ISFP-faq-self-doubt", "为什么『都是我的错"),
        ],
    },
    "在自己价值观里都站": {
        "anchor": ("INFP", "INFP-faq-self-doubt"),
        "swaps": [
            ("ISFP", "ISFP-faq-self-doubt", "在自己价值体系里都站"),
        ],
    },
    "静得受不了时才浮上来": {
        "anchor": ("INFP", "INFP-faq-self-doubt"),
        "swaps": [
            ("ISFP", "ISFP-faq-self-doubt", "静得忍不住时才浮上来"),
        ],
    },
    "FP 社交是高消耗行": {
        "anchor": ("INFP", "INFP-faq-social-drain"),
        "swaps": [
            ("ISFP", "ISFP-faq-social-drain", "FP 的社交是高消耗行"),
        ],
    },
    "主管、运营经理；适合": {
        "anchor": ("ESFJ", "ESFJ-career-02"),
        "swaps": [
            ("ISTJ", "ISTJ-career-02", "主管、运营主管；适合"),
        ],
    },
    "常事务管得井井有条。": {
        "anchor": ("ESFJ", "ESFJ-career-02"),
        "swaps": [
            ("ISTJ", "ISTJ-career-02", "常事务理得井井有条。"),
        ],
    },
    "TJ 不是浪漫型而是": {
        "anchor": ("ESTJ", "ESTJ-relationship-01"),
        "swaps": [
            ("ISTJ", "ISTJ-relationship-01", "TJ 不是浪漫型而是"),
        ],
    },
    "能把『我爱你』转化为": {
        "anchor": ("ESTJ", "ESTJ-relationship-01"),
        "swaps": [
            ("ISTJ", "ISTJ-relationship-01", "能把『我爱你』转化为"),
        ],
    },
    "感觉一个可执行的容器": {
        "anchor": ("ESTJ", "ESTJ-faq-breakup"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-breakup", "感觉一个可运行的容器"),
        ],
    },
    "认一个真相：有些节点": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-decision", "认一个事实：有些节点"),
        ],
    },
    "预算』，把破例从事后": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-decision", "预算』，把例外从事后"),
        ],
    },
    "；否则你会在某个节点": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-decision", "；否则你会在某个节骨眼"),
        ],
    },
    "卡住，因为稳妥选项都": {
        "anchor": ("ESTJ", "ESTJ-faq-decision"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-decision", "卡住，因为稳妥路线都"),
        ],
    },
    "在冲突里本能先道歉": {
        "anchor": ("ESFJ", "ESFJ-faq-conflict"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-conflict", "在冲突里本能先认错"),
        ],
    },
    "。背后也有不少委屈": {
        "anchor": ("ESFJ", "ESFJ-faq-conflict"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-conflict", "。背后也攒着不少委屈"),
        ],
    },
    "FJ 会陷入一段沉": {
        "anchor": ("ESFJ", "ESFJ-faq-self-doubt"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-self-doubt", "FJ 会陷进一段沉"),
        ],
    },
    " 把责任往自己肩上揽": {
        "anchor": ("ESFJ", "ESFJ-faq-self-doubt"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-self-doubt", " 把责任往自己身上揽"),
        ],
    },
    "TJ 在团队里会被": {
        "anchor": ("ESTJ", "ESTJ-faq-teamwork"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-teamwork", "TJ 在团队里常被"),
        ],
    },
    "在线条里前置协商清楚": {
        "anchor": ("ESTJ", "ESTJ-faq-teamwork"),
        "swaps": [
            ("ISTJ", "ISTJ-faq-teamwork", "在线里前置协商清楚"),
        ],
    },
    "方案的场合（产品策划、": {
        "anchor": ("ENFP", "ENFP-strength-01"),
        "swaps": [
            ("ENTP", "ENTP-strength-01", "方案的场合（产品策划、"),
        ],
    },
    "功先拆，把保命项扔": {
        "anchor": ("ESTP", "ESTP-faq-deadline"),
        "swaps": [
            ("ISTP", "ISTP-faq-deadline", "功先拆，把核心项扔"),
        ],
    },
    "穿 Se 提前预演最坏": {
        "anchor": ("ESTP", "ESTP-faq-deadline"),
        "swaps": [
            ("ISTP", "ISTP-faq-deadline", "穿 Se 提前走一遍最坏"),
        ],
    },
    "，哪怕打到一半，": {
        "anchor": ("ESTP", "ESTP-faq-deadline"),
        "swaps": [
            ("ISTP", "ISTP-faq-deadline", "，哪怕做到一半，"),
        ],
    },
    "前凭借直觉行动，": {
        "anchor": ("ISFP", "ISFP-faq-decision"),
        "swaps": [
            ("ISTP", "ISTP-faq-decision", "前凭本能就动，"),
        ],
    },
    "决策前给自己留一段": {
        "anchor": ("ISFP", "ISFP-faq-decision"),
        "swaps": [
            ("ISTP", "ISTP-faq-decision", "决定前给自己留一段"),
        ],
    },
    "直到身体里松动了": {
        "anchor": ("ISFP", "ISFP-faq-decision"),
        "swaps": [
            ("ISTP", "ISTP-faq-decision", "直到身体里松动了"),
        ],
    },
    "度过社交后能恢复": {
        "anchor": ("ISFP", "ISFP-faq-social-drain"),
        "swaps": [
            ("ISTP", "ISTP-faq-social-drain", "熬过社交后能恢复"),
        ],
    },
    "TP 整理感官的窗口": {
        "anchor": ("ISFP", "ISFP-faq-social-drain"),
        "swaps": [
            ("ISTP", "ISTP-faq-social-drain", "TP 整理感官信息的窗口"),
        ],
    },
    "他人情绪为决策坐标，": {
        "anchor": ("ENFJ", "ENFJ-cognitive-01"),
        "swaps": [
            ("ISFJ", "ISFJ-cognitive-02", "他人感受是决策坐标，"),
        ],
    },
    "替。立『自己的 DD": {
        "anchor": ("ENFJ", "ENFJ-faq-deadline"),
        "swaps": [
            ("ESFJ", "ESFJ-faq-deadline", "替。立一份自己的DD"),
        ],
    },
    "是我哪里做得不够好』": {
        "anchor": ("ENFJ", "ENFJ-faq-criticism"),
        "swaps": [
            ("ESFJ", "ESFJ-faq-criticism", "是我哪里没做好』"),
        ],
    },
    "前三个月慢一点是正常": {
        "anchor": ("ENFJ", "ENFJ-faq-new-job"),
        "swaps": [
            ("ESFJ", "ESFJ-faq-new-job", "前三月慢一拍是常态"),
        ],
    },
    "份『社交后恢复清单』": {
        "anchor": ("ENFJ", "ENFJ-faq-social-drain"),
        "swaps": [
            ("ESFJ", "ESFJ-faq-social-drain", "份『应酬之后恢复清单』"),
        ],
    },
    "读、散步。把恢复流程": {
        "anchor": ("ENFJ", "ENFJ-faq-social-drain"),
        "swaps": [
            ("ESFJ", "ESFJ-faq-social-drain", "读、散步。把复盘流程"),
        ],
    },
    "心价值系统，不符合的": {
        "anchor": ("ENFP", "ENFP-cognitive-02"),
        "swaps": [
            ("ESFP", "ESFP-cognitive-02", "心的价值体系，不符合的"),
        ],
    },
    "陌生人场合快速破冰，": {
        "anchor": ("ENFP", "ENFP-strength-02"),
        "swaps": [
            ("ESFP", "ESFP-strength-03", "陌生人堆里快速破冰，"),
        ],
    },
    "里需要持续的新鲜感和": {
        "anchor": ("ENFP", "ENFP-relationship-01"),
        "swaps": [
            ("ESTP", "ESTP-relationship-01", "里需要不断的新鲜感和"),
        ],
    },
    "通常是也爱玩、能一起": {
        "anchor": ("ENFP", "ENFP-relationship-01"),
        "swaps": [
            ("ESTP", "ESTP-relationship-01", "通常也是爱玩、能一起"),
        ],
    },
    "在台上一向不怯场——": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "swaps": [
            ("ESTP", "ESTP-faq-public-speaking", "在台上一直不怯场——"),
        ],
    },
    "—互动越热烈越兴奋，": {
        "anchor": ("ENFP", "ENFP-faq-public-speaking"),
        "swaps": [
            ("ESFP", "ESFP-faq-public-speaking", "—气氛越热烈越兴奋，"),
        ],
    },
    "会反弹成大段反驳——": {
        "anchor": ("ENFP", "ENFP-faq-criticism"),
        "swaps": [
            ("ESFP", "ESFP-faq-criticism", "会反弹成长篇反驳——"),
        ],
    },
    "下来，情绪浓度会自然": {
        "anchor": ("ENFP", "ENFP-faq-criticism"),
        "swaps": [
            ("ESFP", "ESFP-faq-criticism", "下来，情绪水位会自然"),
        ],
    },
    "。写在纸上比发群里稳": {
        "anchor": ("ENFP", "ENFP-faq-criticism"),
        "swaps": [
            ("ESFP", "ESFP-faq-criticism", "。落笔比发群里更稳"),
        ],
    },
    "的小事清单——咖啡馆": {
        "anchor": ("ENFP", "ENFP-faq-alone-weekend"),
        "swaps": [
            ("ESFP", "ESFP-faq-alone-weekend", "的小清单——咖啡馆"),
        ],
    },
    "把刺激的来源从『找人": {
        "anchor": ("ENFP", "ENFP-faq-alone-weekend"),
        "swaps": [
            ("ESFP", "ESFP-faq-alone-weekend", "把嗨点的来源从『找人"),
        ],
    },
    "做有正反馈的小事』；": {
        "anchor": ("ENFP", "ENFP-faq-alone-weekend"),
        "swaps": [
            ("ESFP", "ESFP-faq-alone-weekend", "做能拿到反馈的小事』；"),
        ],
    },
    "也就这样』的感觉——": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESFP", "ESFP-faq-new-job", "也就这样』的体感——"),
        ],
    },
    " 的新鲜感衰减极快。": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESFP", "ESFP-faq-new-job", " 的新鲜感衰减很快。"),
        ],
    },
    "，还是新鲜感的阈值到": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESTP", "ESTP-faq-new-job", "，还是你的阈值到了"),
        ],
    },
    "是新鲜感的阈值到了？": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESTP", "ESTP-faq-new-job", "是新鲜感的门槛到了？"),
        ],
    },
    "你的，不是环境的——": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESFP", "ESFP-faq-new-job", "是你的，不是环境的——"),
        ],
    },
    "后者换地方也救不了。": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESFP", "ESFP-faq-new-job", "后者搬地方也救不了。"),
        ],
    },
    "间重新长出来更划算。": {
        "anchor": ("ENFP", "ENFP-faq-new-job"),
        "swaps": [
            ("ESFP", "ESFP-faq-new-job", "间重新生根更划算。"),
        ],
    },
    "在重大抉择里会被『最": {
        "anchor": ("ENFP", "ENFP-faq-decision"),
        "swaps": [
            ("ESFP", "ESFP-faq-decision", "在重大选择里会被『最"),
        ],
    },
    " 6 个月』，再问『": {
        "anchor": ("ENFP", "ENFP-faq-decision"),
        "swaps": [
            ("ESFP", "ESFP-faq-decision", " 6 个月』，再问问『"),
        ],
    },
    "能量源——但前提是有": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "swaps": [
            ("ESTJ", "ESTJ-faq-social-drain", "能量源——但前提得有"),
        ],
    },
    "。重复寒暄一样耗电：": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "swaps": [
            ("ESFP", "ESFP-faq-social-drain", "。重复寒暄也耗电："),
        ],
    },
    "者不拒——把每周社交": {
        "anchor": ("ENFP", "ENFP-faq-social-drain"),
        "swaps": [
            ("ESFP", "ESFP-faq-social-drain", "者不拒——把每周出门"),
        ],
    },
    "都学不深』的陷阱——": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "swaps": [
            ("ESFP", "ESFP-faq-exam", "都不深入』的陷阱——"),
        ],
    },
    "新概念不停。觉得这个": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "swaps": [
            ("ESFP", "ESFP-faq-exam", "新花样不停。觉得这个"),
        ],
    },
    "周只刷真题和错题，新": {
        "anchor": ("ENFP", "ENFP-faq-exam"),
        "swaps": [
            ("ESFP", "ESFP-faq-exam", "周只刷真题和错题，新"),
        ],
    },
    "装进『结构化容器』：": {
        "anchor": ("ENFP", "ENFP-faq-teamwork"),
        "swaps": [
            ("ESFP", "ESFP-faq-teamwork", "塞进『结构化容器』："),
        ],
    },
    "选一个靠谱的搭档共同": {
        "anchor": ("ENFP", "ENFP-faq-teamwork"),
        "swaps": [
            ("ESFP", "ESFP-faq-teamwork", "挑一个靠谱的搭档一起"),
        ],
    },
    "越高涨，Se 越上场": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "swaps": [
            ("ESTP", "ESTP-faq-public-speaking", "越高涨，Se 越起劲"),
        ],
    },
    "场的『现场感』一旦": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "swaps": [
            ("ESTP", "ESTP-faq-public-speaking", "场的『现场感』只要"),
        ],
    },
    "靠 Se 顶上去会加速": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "swaps": [
            ("ESTP", "ESTP-faq-public-speaking", "靠 Se 顶上去会加力"),
        ],
    },
    "前 50 分钟要有": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "swaps": [
            ("ESTP", "ESTP-faq-public-speaking", "前 50 分钟给"),
        ],
    },
    "0 分钟举牌提醒": {
        "anchor": ("ESFP", "ESFP-faq-public-speaking"),
        "swaps": [
            ("ESTP", "ESTP-faq-public-speaking", "0 分钟举牌给"),
        ],
    },
    "越刺激越好。Se 没": {
        "anchor": ("ESFP", "ESFP-faq-social-drain"),
        "swaps": [
            ("ESTP", "ESTP-faq-social-drain", "越有冲劲越好。Se 没"),
        ],
    },
    "e 没新东西可接就": {
        "anchor": ("ESFP", "ESFP-faq-social-drain"),
        "swaps": [
            ("ESTP", "ESTP-faq-social-drain", "e 没新冲击可接就"),
        ],
    },
    # 同人格 5 个
    "，Ne 把问题延伸到": {
        "anchor": ("INFP", "INFP-faq-deadline"),
        "swaps": [
            ("INFP", "INFP-faq-self-doubt", "，Ne 把问题扩散到"),
        ],
    },
    "ENFJ 在社交场合": {
        "anchor": ("ENFJ", "ENFJ-faq-networking"),
        "swaps": [
            ("ENFJ", "ENFJ-faq-social-drain", "ENFJ 在应酬场合"),
        ],
    },
    "——Si + Fe ": {
        "anchor": ("ISFJ", "ISFJ-career-01"),
        "swaps": [
            ("ISFJ", "ISFJ-faq-alone-weekend", "——Si 与 Fe "),
        ],
    },
    "，Ti + Se 的": {
        "anchor": ("ISTP", "ISTP-faq-new-job"),
        "swaps": [
            ("ISTP", "ISTP-faq-teamwork", "，Ti 与 Se 的"),
        ],
    },
    "ISFP 的能量更像一口井，挖太快会枯": {
        "anchor": ("ISFP", "ISFP-faq-alone-weekend"),
        "swaps": [
            ("ISFP", "ISFP-faq-social-drain", "ISFP 的能量更像一池水，抽得太猛会枯"),
        ],
    },
}


def main():
    all_entries = load_all()

    changed_total = 0
    for it in range(8):
        data = get_scan()
        cross = data["cross_personality"]
        same_total = sum(len(v) for v in data["same_personality"].values())

        # 按 (p, eid) 收集所有需要做的 (old, new)
        todo = {}
        sources = cross + [g for sub in data["same_personality"].values() for g in sub]
        for item in sources:
            frag = item["fragment"]
            if frag not in SURGICAL:
                continue
            spec = SURGICAL[frag]
            anchor_p, anchor_eid = spec["anchor"]
            for (p, eid, repl) in spec["swaps"]:
                # 跳过 anchor（不动）
                if (p, eid) == (anchor_p, anchor_eid):
                    continue
                todo.setdefault((p, eid), []).append((frag, repl, anchor_p, anchor_eid))

        if not todo:
            print(f"iter {it}: 无 SURGICAL 方案")
            break

        changed = 0
        for (p, eid), edits in todo.items():
            e, data_file = load_entry(p, eid)
            if e is None:
                continue
            cur = e["content"]
            cat = e["category"]
            new_text = cur
            applied = []
            for (old, repl, _, _) in edits:
                if old in new_text:
                    new_text = new_text.replace(old, repl, 1)
                    applied.append((old, repl))
            if new_text == cur:
                continue
            if not cat_len_ok(cat, len(new_text)):
                continue
            # 检查不引入新的跨条目重叠（与 anchor 的内容比对必须无 10 字公共子串）
            safe = True
            for (_, _, ap, ae) in edits:
                anchor_text = all_entries.get((ap, ae))
                if anchor_text is None:
                    continue
                # 与 anchor 必须无重叠（只检查 ≥10 子串）
                if lcs_pairs(new_text, anchor_text):
                    safe = False
                    break
            if not safe:
                continue
            # 检查不与其它已记录的条目引入新 ≥10 字重叠（只检查我们 touch 过的条目）
            safe = True
            for (other_p, other_eid), other_text in all_entries.items():
                if (other_p, other_eid) == (p, eid):
                    continue
                # 与 anchor 条目已有重叠（这是我们要修的）
                if (other_p, other_eid) in [(ap, ae) for (_, _, ap, ae) in edits]:
                    # 这正是要修的，不算 new
                    continue
                # 检查是否引入新重叠
                old_overlap = lcs_pairs(cur, other_text)
                new_overlap = lcs_pairs(new_text, other_text)
                # 任意 new 中出现的非旧的重叠都算 new
                new_only = [x for x in new_overlap if x not in old_overlap]
                if new_only:
                    safe = False
                    break
            if not safe:
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

    print(f"本轮累计修改: {changed_total}")
    data = get_scan()
    print(f"最终 cross: {len(data['cross_personality'])}, same: {sum(len(v) for v in data['same_personality'].values())}")
    if data["cross_personality"]:
        print("\n=== remaining cross (first 15) ===")
        for g in data["cross_personality"][:15]:
            print(f"  {g['fragment']!r:30} ({len(g['entries'])}): {[e['personality']+':'+e['id'].split('-')[-1] for e in g['entries']]}")


if __name__ == "__main__":
    main()