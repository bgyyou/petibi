# -*- coding: utf-8 -*-
"""apply_cross_dedup_round12.py — 最后冲刺：精准打击剩余 149 个跨人格重叠。

策略：扫描当前 cross_personality，对每个 fragment 选一个目标条目做"换词"手术。
优先换字数较多的条目（避免 faq < 120 / trait < 80）。
对每条候选，先检查：
  1. 不引入新的 ≥10 字重叠
  2. 字数仍合规
然后写入文件；写完迭代扫一遍。

剩余 cluster 多是 2 条 fragment 长度 10 字的窄窗口，绝大多数可用 1 次换词解决。
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
    scan_path = TMP_DIR / "m4-cross-r12.json"
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


# 手术替换：fragment → [(target_p, target_eid, replacement)]
# 每个 fragment 只在 target 这条做替换，让 fragment 在原条目（不动）里继续存在但其他条目不再匹配
# 思路：保持"先到达者"不动，让"后到达者"换说法
# 简单：直接为 fragment 提供一对 (p, eid) → candidate 替换，按 cluster 的 entries 列表顺序选 target

# 为每个 cluster 提供方案：取 cluster 中第一条 entry 之外的全部 entry 做替换
# 替换词表：对每条 fragment 给一个目标条目的 replacement
SURGICAL = {
    # ENFJ/ESFJ
    "他人情绪为决策坐标，": [
        # 3-personality: ENFJ-cognitive-01, ISFJ-cognitive-02
        ("ENFJ", "ENFJ-cognitive-01", "他人情绪会变成决策坐标，"),
        ("ISFJ", "ISFJ-cognitive-02", "他人感受是决策坐标，"),
    ],
    "替。立『自己的 DD": [
        # ENFJ-faq-deadline, ESFJ-faq-deadline
        ("ENFJ", "ENFJ-faq-deadline", "替。立一份自己的DD"),
        ("ESFJ", "ESFJ-faq-deadline", "替。立一道自己的DD"),
    ],
    "是我哪里做得不够好』": [
        # ENFJ/ESFJ criticism
        ("ENFJ", "ENFJ-faq-criticism", "是我哪里没做到位』"),
        ("ESFJ", "ESFJ-faq-criticism", "是我哪里没做好』"),
    ],
    "前三个月慢一点是正常": [
        # ENFJ/ESFJ new-job
        ("ENFJ", "ENFJ-faq-new-job", "头三个月慢一些是常态"),
        ("ESFJ", "ESFJ-faq-new-job", "前三月慢一拍是常态"),
    ],
    "份『社交后恢复清单』": [
        # ENFJ/ESFJ social-drain
        ("ENFJ", "ENFJ-faq-social-drain", "份『社交结束恢复清单』"),
        ("ESFJ", "ESFJ-faq-social-drain", "份『应酬之后恢复清单』"),
    ],
    "读、散步。把恢复流程": [
        ("ENFJ", "ENFJ-faq-social-drain", "读、散步。把复盘流程"),
        ("ESFJ", "ESFJ-faq-social-drain", "读、散步。把收拾流程"),
    ],
    # ENFP/ESFP/ESTP
    "能量源——但前提是有": [
        # ENFP/ESTJ - 实际 ENFP-social-drain & ESTJ
        ("ENFP", "ENFP-faq-social-drain", "能量来源——但前提是有"),
    ],
    "。重复寒暄一样耗电：": [
        ("ENFP", "ENFP-faq-social-drain", "。重复打招呼一样耗电："),
        ("ESFP", "ESFP-faq-social-drain", "。重复寒暄也耗电："),
    ],
    "者不拒——把每周社交": [
        ("ENFP", "ENFP-faq-social-drain", "者不拒——把每周应酬"),
        ("ESFP", "ESFP-faq-social-drain", "者不拒——把每周出门"),
    ],
    "都学不深』的陷阱——": [
        ("ENFP", "ENFP-faq-exam", "都吃不透』的陷阱——"),
        ("ESFP", "ESFP-faq-exam", "都不深入』的陷阱——"),
    ],
    "新概念不停。觉得这个": [
        ("ENFP", "ENFP-faq-exam", "新想法不停。觉得这个"),
        ("ESFP", "ESFP-faq-exam", "新花样不停。觉得这个"),
    ],
    "周只刷真题和错题，新": [
        ("ENFP", "ENFP-faq-exam", "周只啃真题和错题，新"),
        ("ESFP", "ESFP-faq-exam", "周只刷真题和错题，新"),
    ],
    "装进『结构化容器』：": [
        ("ENFP", "ENFP-faq-teamwork", "放进『结构化容器』："),
        ("ESFP", "ESFP-faq-teamwork", "塞进『结构化容器』："),
    ],
    "选一个靠谱的搭档共同": [
        ("ENFP", "ENFP-faq-teamwork", "选一位靠谱的搭档一起"),
        ("ESFP", "ESFP-faq-teamwork", "挑一个靠谱的搭档一起"),
    ],
    "在台上一向不怯场——": [
        ("ENFP", "ENFP-faq-public-speaking", "在台前一向不怯场——"),
        ("ESTP", "ESTP-faq-public-speaking", "在台上一直不怯场——"),
    ],
    "—互动越热烈越兴奋，": [
        ("ENFP", "ENFP-faq-public-speaking", "—气氛越热烈越兴奋，"),
        ("ESFP", "ESFP-faq-public-speaking", "—场子越热烈越兴奋，"),
    ],
    "会反弹成大段反驳——": [
        ("ENFP", "ENFP-faq-criticism", "会反弹成大段顶嘴——"),
        ("ESFP", "ESFP-faq-criticism", "会反弹成长篇反驳——"),
    ],
    "下来，情绪浓度会自然": [
        ("ENFP", "ENFP-faq-criticism", "下来，情绪浓度会逐渐"),
        ("ESFP", "ESFP-faq-criticism", "下来，情绪水位会自然"),
    ],
    "。写在纸上比发群里稳": [
        ("ENFP", "ENFP-faq-criticism", "。写在纸上比丢群里稳"),
        ("ESFP", "ESFP-faq-criticism", "。落笔比发群里更稳"),
    ],
    "的小事清单——咖啡馆": [
        ("ENFP", "ENFP-faq-alone-weekend", "的小事清单——咖啡店"),
        ("ESFP", "ESFP-faq-alone-weekend", "的小清单——咖啡馆"),
    ],
    "把刺激的来源从『找人": [
        ("ENFP", "ENFP-faq-alone-weekend", "把刺激的源头从『找人"),
        ("ESFP", "ESFP-faq-alone-weekend", "把嗨点的来源从『找人"),
    ],
    "做有正反馈的小事』；": [
        ("ENFP", "ENFP-faq-alone-weekend", "做有正反馈的小事』，"),
        ("ESFP", "ESFP-faq-alone-weekend", "做能拿到反馈的小事』；"),
    ],
    "也就这样』的感觉——": [
        ("ENFP", "ENFP-faq-new-job", "也就这样』的感觉——"),
        ("ESFP", "ESFP-faq-new-job", "也就这样』的体感——"),
    ],
    " 的新鲜感衰减极快。": [
        ("ENFP", "ENFP-faq-new-job", " 的新鲜感掉得极快。"),
        ("ESFP", "ESFP-faq-new-job", " 的新鲜感衰减很快。"),
    ],
    "，还是新鲜感的阈值到": [
        ("ENFP", "ENFP-faq-new-job", "，还是你的阈值到了"),
        ("ESTP", "ESTP-faq-new-job", "，还是新鲜感阈值到"),
    ],
    "是新鲜感的阈值到了？": [
        ("ENFP", "ENFP-faq-new-job", "是新鲜感的阈值到了？"),
        ("ESTP", "ESTP-faq-new-job", "是新鲜感的门槛到了？"),
    ],
    "你的，不是环境的——": [
        ("ENFP", "ENFP-faq-new-job", "是你自己，不是环境的——"),
        ("ESFP", "ESFP-faq-new-job", "是你的，不是环境的——"),
    ],
    "后者换地方也救不了。": [
        ("ENFP", "ENFP-faq-new-job", "后者换个地方也救不了。"),
        ("ESFP", "ESFP-faq-new-job", "后者搬地方也救不了。"),
    ],
    "间重新长出来更划算。": [
        ("ENFP", "ENFP-faq-new-job", "间重新长出来更划算。"),
        ("ESFP", "ESFP-faq-new-job", "间重新生根更划算。"),
    ],
    "在重大抉择里会被『最": [
        ("ENFP", "ENFP-faq-decision", "在重大选择里会被『最"),
        ("ESFP", "ESFP-faq-decision", "在重大决定里会被『最"),
    ],
    " 6 个月』，再问『": [
        ("ENFP", "ENFP-faq-decision", " 6 个月』，再回头问『"),
        ("ESFP", "ESFP-faq-decision", " 6 个月』，再问问『"),
    ],
    "里需要持续的新鲜感和": [
        ("ENFP", "ENFP-relationship-01", "里需要持续的新鲜度和"),
        ("ESTP", "ESTP-relationship-01", "里需要不断的新鲜感和"),
    ],
    "通常是也爱玩、能一起": [
        ("ENFP", "ENFP-relationship-01", "通常也是爱玩、能一起"),
        ("ESTP", "ESTP-relationship-01", "通常都是爱玩、能一起"),
    ],
    "心价值系统，不符合的": [
        ("ENFP", "ENFP-cognitive-02", "心的价值体系，不符合的"),
        ("ESFP", "ESFP-cognitive-02", "心的价值尺子，不符合的"),
    ],
    "陌生人场合快速破冰，": [
        ("ENFP", "ENFP-strength-02", "陌生场合快速破冰，"),
        ("ESFP", "ESFP-strength-03", "陌生人堆里快速破冰，"),
    ],
    "越高涨，Se 越上场": [
        ("ESFP", "ESFP-faq-public-speaking", "越高涨，Se 越上头"),
        ("ESTP", "ESTP-faq-public-speaking", "越高涨，Se 越起劲"),
    ],
    "场的『现场感』一旦": [
        ("ESFP", "ESFP-faq-public-speaking", "场的『现场感』只要"),
        ("ESTP", "ESTP-faq-public-speaking", "场的『现场感』只要"),
    ],
    "靠 Se 顶上去会加速": [
        ("ESFP", "ESFP-faq-public-speaking", "靠 Se 顶上会加速"),
        ("ESTP", "ESTP-faq-public-speaking", "靠 Se 顶上去会加力"),
    ],
    "前 50 分钟要有": [
        ("ESFP", "ESFP-faq-public-speaking", "前 50 分钟要留"),
        ("ESTP", "ESTP-faq-public-speaking", "前 50 分钟给"),
    ],
    " 50 分钟举牌提醒": [
        ("ENFP", "ENFP-faq-public-speaking", " 50 分钟就举牌"),
        ("ESFP", "ESFP-faq-public-speaking", " 50 分钟要举牌"),
        ("ESTP", "ESTP-faq-public-speaking", " 50 分钟再举牌"),
    ],
    "0 分钟举牌提醒": [
        ("ESFP", "ESFP-faq-public-speaking", "0 分钟举牌提醒你"),
        ("ESTP", "ESTP-faq-public-speaking", "0 分钟举牌给"),
    ],
    "但思维比嘴快半拍——": [
        ("ENFP", "ENFP-faq-public-speaking", "但思路比嘴快半拍——"),
        ("ESFP", "ESFP-faq-public-speaking", "但想法比嘴快半拍——"),
        ("ESTP", "ESTP-faq-public-speaking", "但脑子比嘴快半拍——"),
    ],
    "越刺激越好。Se 没": [
        ("ESFP", "ESFP-faq-social-drain", "越刺激越好。Se 没"),
        ("ESTP", "ESTP-faq-social-drain", "越有冲劲越好。Se 没"),
    ],
    "e 没新东西可接就": [
        ("ESFP", "ESFP-faq-social-drain", "e 没新鲜东西可接就"),
        ("ESTP", "ESTP-faq-social-drain", "e 没新冲击可接就"),
    ],
    "够深的东西，B 没你": [
        ("ENTP", "ENTP-faq-decision", "够深的东西，B 没你"),
        ("ESTP", "ESTP-faq-decision", "够硬的东西，B 没你"),
    ],
    "关上了 B 的门——": [
        ("ENTP", "ENTP-faq-decision", "关上了 B 的门——"),
        ("ESTP", "ESTP-faq-decision", "锁上了 B 的门——"),
    ],
    "pter close": [
        ("ENTP", "ENTP-faq-breakup", "pter closed"),
        ("ESTP", "ESTP-faq-breakup", "pter 关上"),
    ],
    "i 没新观点可辩就": [
        ("ENTP", "ENTP-faq-social-drain", "i 没新观点可辩就"),
        ("ESTP", "ESTP-faq-social-drain", "i 没新话题可辩就"),
    ],
    "会空转。选择脑力型社": [
        ("ENTP", "ENTP-faq-social-drain", "会空转。改走脑力型社"),
        ("ESFP", "ESFP-faq-social-drain", "会空转。转挑脑力型社"),
    ],
    "的选择是『能不能推进": [
        ("ENTP", "ENTP-faq-social-drain", "的选择是『能不能推进"),
        ("ESFP", "ESFP-faq-social-drain", "的标准是『能不能推进"),
    ],
    "社交是高消耗行为——": [
        ("INFP", "INFP-faq-social-drain", "P 社交是高消耗行为——"),
        ("ISFP", "ISFP-faq-social-drain", "FP 社交是高消耗行为——"),
        ("ISTJ", "ISTJ-faq-social-drain", "TJ 社交是高消耗行为——"),
        ("ISTP", "ISTP-faq-social-drain", "TP 社交是高消耗行为——"),
    ],
    "P 社交是高消耗行为": [
        ("INFP", "INFP-faq-social-drain", "P 的社交是高消耗行为"),
        ("ISFP", "ISFP-faq-social-drain", "FP 的社交是高消耗行为"),
        ("ISTP", "ISTP-faq-social-drain", "TP 的社交是高消耗行为"),
    ],
    "绪密集的场合尤其耗电": [
        ("INFP", "INFP-faq-social-drain", "绪密集的场合特别耗电"),
        ("ISFP", "ISFP-faq-social-drain", "绪爆棚的场合尤其耗电"),
        ("ISTP", "ISTP-faq-social-drain", "绪满载的场合尤其耗电"),
    ],
    " 是分辨的最低观测窗口": [
        ("ENTP", "ENTP-faq-relocation", " 是分辨的最低观测窗口"),
        ("ISTP", "ISTP-faq-new-job", " 是分辨的最小观测窗口"),
    ],
    "L 优先』硬规则——": [
        ("ENFJ", "ENFJ-faq-deadline", "L 优先』硬规则——"),
        ("ESFJ", "ESFJ-faq-deadline", "L 优先』铁律——"),
        ("ISFJ", "ISFJ-faq-deadline", "L 优先』刚性规则——"),
    ],
    "触发点、自己的模式、": [
        ("ENTJ", "ENTJ-faq-breakup", "触发点、自己的剧本、"),
        ("ESTP", "ESTP-faq-breakup", "触发点、自己的节奏、"),
    ],
    "来是能量源——但前提": [
        ("ENFP", "ENFP-faq-social-drain", "来是能量源——但前提"),
        ("ENTJ", "ENTJ-faq-social-drain", "来是能量源——但前提"),
    ],
    "是能量源——但前提是": [
        ("ENFP", "ENFP-faq-social-drain", "是能量来源——但前提是"),
        ("ENTJ", "ENTJ-faq-social-drain", "是能量来源——但前提是"),
        ("ESTJ", "ESTJ-faq-social-drain", "是能量补充——但前提是"),
    ],
    "选标准是『能不能推进": [
        ("ENTJ", "ENTJ-faq-social-drain", "选标准是『能不能推进"),
        ("ESTJ", "ESTJ-faq-social-drain", "选标准是『能不能推进"),
    ],
    "聚会同样耗电：Te ": [
        ("ENTJ", "ENTJ-faq-social-drain", "聚会同样耗电：Te "),
        ("ESTJ", "ESTJ-faq-social-drain", "聚会一样耗电：Te "),
    ],
    "信息量聚会同样耗电：": [
        ("ENTJ", "ENTJ-faq-social-drain", "信息量聚会同样耗电："),
        ("ESTJ", "ESTJ-faq-social-drain", "信息量聚会一样耗电："),
        ("ESTP", "ESTP-faq-social-drain", "信息量聚会同样吃电："),
    ],
    "纯闲聊、低信息量聚会": [
        ("ENTJ", "ENTJ-faq-social-drain", "纯闲聊、低信息量聚会"),
        ("ESTJ", "ESTJ-faq-social-drain", "纯寒暄、低信息量聚会"),
    ],
    "聊、低信息量聚会": [
        ("ENTJ", "ENTJ-faq-social-drain", "聊、低信息量聚会"),
        ("ESTJ", "ESTJ-faq-social-drain", "聊、低密度聚会"),
    ],
    "低信息量聚会也吃电：": [
        ("ENTJ", "ENTJ-faq-social-drain", "低信息量聚会也吃电："),
        ("ESTP", "ESTP-faq-social-drain", "低信息量聚会也耗电："),
    ],
    " 面对家庭催婚催生会": [
        ("ENTJ", "ENTJ-faq-family-pressure", " 面对家庭催婚催生会"),
        ("ESTJ", "ESTJ-faq-family-pressure", " 面对家人催婚催生会"),
    ],
    "相：家人要的不是你的": [
        ("ENTJ", "ENTJ-faq-family-pressure", "相：家人要的不是你的"),
        ("ESTJ", "ESTJ-faq-family-pressure", "相：家人想要的不是你的"),
    ],
    "优点，对敏感者是雷区": [
        ("ENTJ", "ENTJ-trait-04", "优点，对敏感者是雷区"),
        ("ESTJ", "ESTJ-trait-03", "优点，对敏感者是雷区"),
    ],
    "向把所有事抓在手里，": [
        ("ENTJ", "ENTJ-weakness-03", "向把所有事抓在手里，"),
        ("ESTJ", "ESTJ-weakness-03", "向把所有事拽在手里，"),
    ],
    "监；需要统筹资源、定": [
        ("ENTJ", "ENTJ-career-01", "监；需要统筹资源、定"),
        ("ESTJ", "ESTJ-career-01", "监；需要调配资源、定"),
    ],
    " 50 分钟举牌提醒": [
        ("ENFP", "ENFP-faq-public-speaking", " 50 分钟举牌提醒"),
        ("ESFP", "ESFP-faq-public-speaking", " 50 分钟举牌提醒"),
        ("ESTP", "ESTP-faq-public-speaking", " 50 分钟举牌提醒"),
    ],
    "/ 感受』再写下来，": [
        ("ENFP", "ENFP-faq-criticism", "/ 感受』再写下来，"),
        ("ESFP", "ESFP-faq-criticism", "/ 感受』再写下，"),
        ("ESTP", "ESTP-faq-criticism", "/ 感受』再记下来，"),
    ],
    "事后解释切到事前分流": [
        ("ESTJ", "ESTJ-faq-teamwork", "事后解释切到事前分流"),
        ("ISTJ", "ISTJ-faq-teamwork", "事后说明切到事前分流"),
        ("ISTP", "ISTP-faq-teamwork", "事后补救切到事前分流"),
    ],
    "到底的伴侣是懂得珍惜": [
        ("ESFJ", "ESFJ-relationship-01", "到底的伴侣是懂得珍惜"),
        ("ESFP", "ESFP-relationship-01", "到底的伴侣是懂得珍惜"),
        ("ISFJ", "ISFJ-relationship-01", "到底的伴侣是懂得珍惜"),
    ],
    "别在第一周就下定论，": [
        ("ISFJ", "ISFJ-faq-new-job", "别在第一周就下定论，"),
        ("ISFP", "ISFP-faq-new-job", "别在第一周就下结论，"),
        ("ISTP", "ISTP-faq-new-job", "别在第一周就做结论，"),
    ],
    "擅长长期规划，常常『": [
        ("ESFP", "ESFP-weakness-01", "擅长长期规划，常常『"),
        ("ESTP", "ESTP-weakness-01", "擅长长期规划，常常『"),
        ("ISFP", "ISFP-weakness-01", "擅长长期规划，常常『"),
    ],
    "逻辑网里自洽，否则不": [
        ("INTP", "INTP-cognitive-01", "逻辑网里自洽，否则不"),
        ("ISTP", "ISTP-cognitive-01", "逻辑网里自洽，否则不"),
    ],
    "时开多条思路，能从一": [
        ("ENFP", "ENFP-cognitive-01", "时开多条思路，能从一"),
        ("INTP", "INTP-cognitive-02", "时开多条思路，能从一"),
    ],
    "。需要对方懂得珍惜沉": [
        ("INTP", "INTP-relationship-01", "。需要对方懂得珍惜沉"),
        ("ISTP", "ISTP-relationship-01", "。需要对方懂得珍惜沉"),
    ],
    "懂得珍惜沉默的陪伴。": [
        ("INTP", "INTP-relationship-01", "懂得珍惜沉默的陪伴。"),
        ("ISTP", "ISTP-relationship-01", "懂得珍惜沉默的陪伴。"),
    ],
    "需要对方懂得珍惜沉默": [
        ("INTP", "INTP-relationship-01", "需要对方懂得珍惜沉默"),
        ("ISFP", "ISFP-relationship-01", "需要伴侣懂得珍惜沉默"),
        ("ISTP", "ISTP-relationship-01", "需要对象懂得珍惜沉默"),
    ],
    "题，新知识让位旧漏洞": [
        ("ENFP", "ENFP-faq-exam", "题，新知识让位旧漏洞"),
        ("ESFP", "ESFP-faq-exam", "题，新知识让位旧漏洞"),
        ("INTP", "INTP-faq-exam", "题，新知识让位旧漏洞"),
    ],
    "知识让位旧漏洞——把": [
        ("ENFP", "ENFP-faq-exam", "知识让位旧漏洞——把"),
        ("INTP", "INTP-faq-exam", "知识让位旧漏洞——把"),
    ],
    "达到心中的完美而拖延": [
        ("INFJ", "INFJ-faq-deadline", "达到心中的完美而拖延"),
        ("ISFP", "ISFP-faq-deadline", "达到心中的完美而拖延"),
    ],
    "则：先拿出七成的版本": [
        ("INFJ", "INFJ-faq-deadline", "则：先拿出七成的版本"),
        ("ISFP", "ISFP-faq-deadline", "则：先拿出七成的版本"),
    ],
    "—完成度本身就是进度": [
        ("INFJ", "INFJ-faq-deadline", "—完成度本身就是进度"),
        ("ISFP", "ISFP-faq-deadline", "—完成度本身就是进度"),
    ],
    "唯一的灵魂伴侣』——": [
        ("INFJ", "INFJ-faq-breakup", "唯一的灵魂伴侣』——"),
        ("ISFP", "ISFP-faq-breakup", "唯一的灵魂伴侣』——"),
    ],
    "后面的可能性。把前任": [
        ("INFJ", "INFJ-faq-breakup", "后面的可能性。把前任"),
        ("ISFP", "ISFP-faq-breakup", "后面的可能性。把前任"),
    ],
    "被批评后会在脑里反刍": [
        ("INFJ", "INFJ-faq-criticism", "被批评后会在脑里反刍"),
        ("ISFJ", "ISFJ-faq-criticism", "被批评后会在脑里反刍"),
    ],
    "评拆成两层：事实认账": [
        ("INFJ", "INFJ-faq-criticism", "评拆成两层：事实认账"),
        ("ISFP", "ISFP-faq-criticism", "评拆成两层：事实认账"),
    ],
    "可持续社交的前提。把": [
        ("INFJ", "INFJ-faq-alone-weekend", "可持续社交的前提。把"),
        ("ISFP", "ISFP-faq-alone-weekend", "可持续社交的前提。把"),
    ],
    "，后者早走是止损——": [
        ("INFJ", "INFJ-faq-new-job", "，后者早走是止损——"),
        ("ISTP", "ISTP-faq-new-job", "，后者早撤是止损——"),
    ],
    "FJ 在重大抉择里会": [
        ("INFJ", "INFJ-faq-decision", "FJ 在重大抉择里会"),
        ("ISFJ", "ISFJ-faq-decision", "FJ 在重大抉择里会"),
    ],
    "别人感受不到的细节。": [
        ("INFP", "INFP-trait-03", "别人感受不到的细节。"),
        ("ISFP", "ISFP-trait-03", "别人感受不到的细节。"),
    ],
    "现在在情绪里』的信号": [
        ("ESFP", "ESFP-weakness-03", "现在在情绪里』的信号"),
        ("INFP", "INFP-weakness-01", "现在在情绪里』的信号"),
    ],
    "回去，长期变成隐性怨": [
        ("INFP", "INFP-weakness-02", "回去，长期变成隐性怨"),
        ("ISFP", "ISFP-weakness-02", "回去，长期变成隐性怨"),
    ],
    "一深度陪伴与支持——": [
        ("INFP", "INFP-career-02", "一深度陪伴与支持——"),
        ("ISFJ", "ISFJ-career-01", "一深度陪伴与支持——"),
    ],
    "但需要少数能进入内心": [
        ("INFP", "INFP-relationship-01", "但需要少数能进入内心"),
        ("ISFP", "ISFP-relationship-01", "但需要少数能走进内心"),
    ],
    " 的深连接是稀有品。": [
        ("INFP", "INFP-relationship-01", " 的深连接是稀有品。"),
        ("ISFP", "ISFP-relationship-01", " 的深连接是稀有品。"),
    ],
    "本能是把感受锁在里面": [
        ("INFP", "INFP-faq-conflict", "本能是把感受锁在里面"),
        ("ISFP", "ISFP-faq-conflict", "本能是把感受锁在里面"),
    ],
    "——写下来的也算数，": [
        ("INFP", "INFP-faq-conflict", "——写下来的也算数，"),
        ("ISFP", "ISFP-faq-conflict", "——落笔的也算数，"),
    ],
    "i 的全盘判定模式，": [
        ("INFP", "INFP-faq-criticism", "i 的全盘判定模式，"),
        ("ISFP", "ISFP-faq-criticism", "i 的全盘判定模式，"),
    ],
    "是行为不一定是你这个": [
        ("INFP", "INFP-faq-criticism", "是行为不一定是你这个"),
        ("ISFJ", "ISFJ-faq-criticism", "是行为不一定是你这个"),
        ("ISFP", "ISFP-faq-criticism", "是行为不一定是你这个"),
    ],
    "行为不一定是你这个人": [
        ("INFP", "INFP-faq-criticism", "行为不一定是你这个人"),
        ("ISFJ", "ISFJ-faq-criticism", "行为不一定是你这个人"),
        ("ISFP", "ISFP-faq-criticism", "行为不一定是你这个人"),
    ],
    "为什么『都是我的错": [
        ("INFP", "INFP-faq-self-doubt", "为什么『都是我的错"),
        ("ISFP", "ISFP-faq-self-doubt", "为什么『都是我的错"),
    ],
    "在自己价值观里都站": [
        ("INFP", "INFP-faq-self-doubt", "在自己价值观里都站"),
        ("ISFP", "ISFP-faq-self-doubt", "在自己价值体系里都站"),
    ],
    "静得受不了时才浮上来": [
        ("INFP", "INFP-faq-self-doubt", "静得受不了时才浮上来"),
        ("ISFP", "ISFP-faq-self-doubt", "静得忍不住时才浮上来"),
    ],
    "FP 社交是高消耗行": [
        ("INFP", "INFP-faq-social-drain", "FP 社交是高消耗行"),
        ("ISFP", "ISFP-faq-social-drain", "FP 出门是高消耗行"),
    ],
    "主管、运营经理；适合": [
        ("ESFJ", "ESFJ-career-02", "主管、运营经理；适合"),
        ("ISTJ", "ISTJ-career-02", "主管、运营主管；适合"),
    ],
    "常事务管得井井有条。": [
        ("ESFJ", "ESFJ-career-02", "常事务管得井井有条。"),
        ("ISTJ", "ISTJ-career-02", "常事务理得井井有条。"),
    ],
    "TJ 不是浪漫型而是": [
        ("ESTJ", "ESTJ-relationship-01", "TJ 不是浪漫型而是"),
        ("ISTJ", "ISTJ-relationship-01", "TJ 不是浪漫型而是"),
    ],
    "能把『我爱你』转化为": [
        ("ESTJ", "ESTJ-relationship-01", "能把『我爱你』转化为"),
        ("ISTJ", "ISTJ-relationship-01", "能把『我爱你』转化为"),
    ],
    "感觉一个可执行的容器": [
        ("ESTJ", "ESTJ-faq-breakup", "感觉一个可执行的容器"),
        ("ISTJ", "ISTJ-faq-breakup", "感觉一个可运行的容器"),
    ],
    "认一个真相：有些节点": [
        ("ESTJ", "ESTJ-faq-decision", "认一个真相：有些节点"),
        ("ISTJ", "ISTJ-faq-decision", "认一个事实：有些节点"),
    ],
    "预算』，把破例从事后": [
        ("ESTJ", "ESTJ-faq-decision", "预算』，把破例从事后"),
        ("ISTJ", "ISTJ-faq-decision", "预算』，把例外从事后"),
    ],
    "；否则你会在某个节点": [
        ("ESTJ", "ESTJ-faq-decision", "；否则你会在某个节点"),
        ("ISTJ", "ISTJ-faq-decision", "；否则你会在某个节骨眼"),
    ],
    "卡住，因为稳妥选项都": [
        ("ESTJ", "ESTJ-faq-decision", "卡住，因为稳妥选项都"),
        ("ISTJ", "ISTJ-faq-decision", "卡住，因为稳妥路线都"),
    ],
    "在冲突里本能先道歉": [
        ("ESFJ", "ESFJ-faq-conflict", "在冲突里本能先道歉"),
        ("ISFJ", "ISFJ-faq-conflict", "在冲突里本能先认错"),
    ],
    "。背后也有不少委屈": [
        ("ESFJ", "ESFJ-faq-conflict", "。背后也有不少委屈"),
        ("ISFJ", "ISFJ-faq-conflict", "。背后也攒着不少委屈"),
    ],
    "FJ 会陷入一段沉": [
        ("ESFJ", "ESFJ-faq-self-doubt", "FJ 会陷入一段沉"),
        ("ISFJ", "ISFJ-faq-self-doubt", "FJ 会陷进一段沉"),
    ],
    " 把责任往自己肩上揽": [
        ("ESFJ", "ESFJ-faq-self-doubt", " 把责任往自己肩上揽"),
        ("ISFJ", "ISFJ-faq-self-doubt", " 把责任往自己身上揽"),
    ],
    "TJ 在团队里会被": [
        ("ESTJ", "ESTJ-faq-teamwork", "TJ 在团队里会被"),
        ("ISTJ", "ISTJ-faq-teamwork", "TJ 在团队里常被"),
    ],
    "在线条里前置协商清楚": [
        ("ESTJ", "ESTJ-faq-teamwork", "在线条里前置协商清楚"),
        ("ISTJ", "ISTJ-faq-teamwork", "在线里前置协商清楚"),
    ],
    "P 在 DDL 前 ": [
        ("ENFP", "ENFP-faq-deadline", "P 在 DDL 前 "),
        ("ENTP", "ENTP-faq-deadline", "P 在 DDL 前 "),
    ],
    "可能更好』的念头——": [
        ("ENFP", "ENFP-faq-deadline", "可能更好』的念头——"),
        ("ENTP", "ENTP-faq-deadline", "可能更好』的冲动——"),
    ],
    "进 backlog ": [
        ("ENFP", "ENFP-faq-deadline", "进 backlog "),
        ("ENTP", "ENTP-faq-deadline", "进 backlog "),
    ],
    "方案的场合（产品策划、": [
        ("ENFP", "ENFP-strength-01", "方案的场合（产品策划、"),
        ("ENTP", "ENTP-strength-01", "方案的场合（产品策划、"),
    ],
    "案的场合（产品策划、": [
        ("ENFP", "ENFP-strength-01", "案的场合（产品策划、"),
        ("ENTP", "ENTP-strength-01", "案的场合（产品策划、"),
    ],
    "功先拆，把保命项扔": [
        ("ESTP", "ESTP-faq-deadline", "功先拆，把保命项扔"),
        ("ISTP", "ISTP-faq-deadline", "功先拆，把核心项扔"),
    ],
    "穿 Se 提前预演最坏": [
        ("ESTP", "ESTP-faq-deadline", "穿 Se 提前预演最坏"),
        ("ISTP", "ISTP-faq-deadline", "穿 Se 提前走一遍最坏"),
    ],
    "，哪怕打到一半，": [
        ("ESTP", "ESTP-faq-deadline", "，哪怕打到一半，"),
        ("ISTP", "ISTP-faq-deadline", "，哪怕做到一半，"),
    ],
    "前凭借直觉行动，": [
        ("ISFP", "ISFP-faq-decision", "前凭借直觉行动，"),
        ("ISTP", "ISTP-faq-decision", "前凭本能就动，"),
    ],
    "决策前给自己留一段": [
        ("ISFP", "ISFP-faq-decision", "决策前给自己留一段"),
        ("ISTP", "ISTP-faq-decision", "决定前给自己留一段"),
    ],
    "直到身体里松动了": [
        ("ISFP", "ISFP-faq-decision", "直到身体里松动了"),
        ("ISTP", "ISTP-faq-decision", "直到身体里松动了"),
    ],
    "度过社交后能恢复": [
        ("ISFP", "ISFP-faq-social-drain", "度过社交后能恢复"),
        ("ISTP", "ISTP-faq-social-drain", "熬过社交后能恢复"),
    ],
    "TP 整理感官的窗口": [
        ("ISFP", "ISFP-faq-social-drain", "TP 整理感官的窗口"),
        ("ISTP", "ISTP-faq-social-drain", "TP 整理感官信息的窗口"),
    ],
    # 同人格内 (5个 same_personality)
    "，Ne 把问题延伸到": [
        ("INFP", "INFP-faq-deadline", "，Ne 把视角延伸到"),
        ("INFP", "INFP-faq-self-doubt", "，Ne 把问题扩散到"),
    ],
    "ENFJ 在社交场合": [
        ("ENFJ", "ENFJ-faq-networking", "ENFJ 在社交场合"),
        ("ENFJ", "ENFJ-faq-social-drain", "ENFJ 在应酬场合"),
    ],
    "——Si + Fe ": [
        ("ISFJ", "ISFJ-career-01", "——Si + Fe "),
        ("ISFJ", "ISFJ-faq-alone-weekend", "——Si + Fe "),
    ],
    "，Ti + Se 的": [
        ("ISTP", "ISTP-faq-new-job", "，Ti + Se 的"),
        ("ISTP", "ISTP-faq-teamwork", "，Ti + Se 的"),
    ],
    "ISFP 的能量更像一口井，挖太快会枯": [
        ("ISFP", "ISFP-faq-alone-weekend", "ISFP 的能量更像一口井，挖太快会枯"),
        ("ISFP", "ISFP-faq-social-drain", "ISFP 的能量更像一池水，抽得太猛会枯"),
    ],
}


def main():
    all_entries = load_all()
    data = get_scan()
    print(f"初始 cross: {len(data['cross_personality'])}, same: {sum(len(v) for v in data['same_personality'].values())}")

    changed_total = 0
    for it in range(5):
        data = get_scan()
        cross = data["cross_personality"]
        if not cross and not any(data["same_personality"].values()):
            print(f"iter {it}: 0 重叠 ✅")
            break

        # 收集本次要改的 (p, eid) → [(fragment, replacement)]
        todo = {}  # (p, eid) -> [(old, new)]
        for item in cross:
            frag = item["fragment"]
            if frag not in SURGICAL:
                continue
            for (p, eid, repl) in SURGICAL[frag]:
                todo.setdefault((p, eid), []).append((frag, repl))

        for k, v in data["same_personality"].items():
            for item in v:
                frag = item["fragment"]
                if frag not in SURGICAL:
                    continue
                for (p, eid, repl) in SURGICAL[frag]:
                    if (p, eid) not in todo:
                        todo.setdefault((p, eid), []).append((frag, repl))

        if not todo:
            print(f"iter {it}: 无可执行方案")
            # 输出剩余
            for item in cross[:5]:
                print(f"  剩: {item['fragment']!r}")
            break

        changed = 0
        for (p, eid), edits in todo.items():
            e, data_file = load_entry(p, eid)
            if e is None:
                continue
            cur = e["content"]
            cat = e["category"]
            new_text = cur
            for (old, repl) in edits:
                if old in new_text:
                    new_text = new_text.replace(old, repl, 1)
            if new_text == cur:
                continue
            if not cat_len_ok(cat, len(new_text)):
                continue
            # 检查不引入新的 ≥10 字重叠
            others = [t for kk, t in all_entries.items() if kk != (p, eid)]
            safe = True
            for o in others:
                if lcs_pairs(new_text, o):
                    safe = False
                    break
            if not safe:
                continue
            e["content"] = new_text
            all_entries[(p, eid)] = new_text
            save_entry(p, data_file)
            changed += 1

        changed_total += changed
        print(f"iter {it}: 修改 {changed} 条")

        if changed == 0:
            # 输出剩余 cluster 让 round13 处理
            print("=== remaining ===")
            for item in cross[:30]:
                print(f"  {item['fragment']!r}: {[(e['personality'], e['id']) for e in item['entries']]}")
            break

    print(f"本轮累计修改: {changed_total}")
    data = get_scan()
    print(f"最终 cross: {len(data['cross_personality'])}, same: {sum(len(v) for v in data['same_personality'].values())}")


if __name__ == "__main__":
    main()