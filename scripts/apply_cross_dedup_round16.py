# -*- coding: utf-8 -*-
"""apply_cross_dedup_round16.py — 应用多 fragment 同时替换，对每个 entry
取所有 applicable candidates 一起应用，再统一验证。"""

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
    scan_path = TMP_DIR / "m4-cross-r16.json"
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


# per-entry, per-fragment candidates
# 结构: (p, eid) → [(old, [candidates])]
# 每个 entry 可以属于多个 fragment，提供多个候选
ENTRY_CANDIDATES = {
    ("ISFP", "ISFP-faq-social-drain"): [
      ("社交是高消耗行为——", [
      "出门是高消耗行为——",
      "这类场合是高消耗行为——",
      "出门是高消耗活动——",
      ]),
      ("绪密集的场合尤其耗电", [
      "绪爆棚的场合尤其耗电",
      "绪饱满的场合尤其耗电",
      "绪浓郁的场合尤其耗电",
      ]),
      ("P 社交是高消耗行为", [
      "FP 的社交是高消耗行为",
      "FP 出门是高消耗行为",
      ]),
      ("FP 社交是高消耗行", [
      "FP 的社交是高消耗行",
      "FP 出门是高消耗行",
      ]),
      ("ISFP 的能量更像一口井，挖太快会枯", [
      "ISFP 的能量更像一池水，抽得太猛会枯",
      "ISFP 的能量更像一口井，挖太急会枯",
      ]),
    ],
    ("ISTJ", "ISTJ-faq-social-drain"): [
      ("社交是高消耗行为——", [
      "外出是高消耗行为——",
      "出差是高消耗行为——",
      "出门是高消耗活动——",
      ]),
      ("高密度场合尤其耗电", [
      "密集场合尤其耗电",
      "长时间场合尤其耗电",
      "高强度场合尤其耗电",
      ]),
    ],
    ("ISTP", "ISTP-faq-social-drain"): [
      ("社交是高消耗行为——", [
      "出门是高消耗行为——",
      "社交是高消耗工程——",
      "出门是高消耗活动——",
      ]),
      ("绪密集的场合尤其耗电", [
      "绪满载的场合尤其耗电",
      "绪激荡的场合尤其耗电",
      "绪高荷的场合尤其耗电",
      ]),
      ("P 社交是高消耗行为", [
      "TP 的社交是高消耗行为",
      "TP 社交是高消耗行为",
      ]),
      ("TP 整理感官的窗口", [
      "TP 整理感官信息的窗口",
      "TP 整理感官的时段",
      ]),
      ("度过社交后能恢复", [
      "熬过社交后能恢复",
      "撑过社交后能恢复",
      ]),
    ],
    ("ENTP", "ENTP-faq-social-drain"): [
      ("交而不是来者不拒——", [
      "交，而非来者不拒——",
      "交，不搞来者不拒——",
      "交，不做来者不拒——",
      ]),
      ("耗电：Ne 没新东西", [
      "耗电：Ne 没新刺激",
      "耗电：Ne 没新素材",
      ]),
      ("i 没有新观点可辩就", [
      "i 没新议题可辩就",
      "i 没新思路可辩就",
      "i 没有新命题可辩就",
      ]),
      # already above,
      # already above,
      # already above
    ],
    ("ESFP", "ESFP-faq-social-drain"): [
      ("会空转。选择脑力型社", [
      "会空转。改挑脑力型社",
      "会空转。改选脑力型社",
      ]),
      ("。重复寒暄一样耗电：", [
      "。重复寒暄也耗电：",
      "。重复打招呼一样耗电：",
      ]),
      ("者不拒——把每周社交", [
      "者不拒——把每周出门",
      "者不拒——把每周应酬",
      ]),
    ],
    ("ESTP", "ESTP-faq-social-drain"): [
      ("交而不是来者不拒——", [
      "交，而非来者不拒——",
      "交，不搞来者不拒——",
      ]),
      ("低信息量聚会也吃电：", [
      "低信息量聚会也耗电：",
      "低密度聚会也吃电：",
      "低信息量聚会也费电：",
      ]),
      ("i 没有新观点可辩就", [
      "i 没新议题可辩就",
      "i 没新思路可辩就",
      ]),
      ("越刺激越好。Se 没", [
      "越有冲劲越好。Se 没",
      "越爽越好。Se 没",
      ]),
      ("e 没新东西可接就", [
      "e 没新冲击可接就",
      "e 没新刺激可接就",
      ]),
    ],
    ("ENFJ", "ENFJ-faq-deadline"): [
      # anchor - don't change
    ],
    ("ESFJ", "ESFJ-faq-deadline"): [
      ("L 优先』硬规则——", [
      "L 优先』铁规矩——",
      "L 优先』硬规矩——",
      "L 优先』刚性规则——",
      ]),
    ],
    ("ISFJ", "ISFJ-faq-deadline"): [
      ("L 优先』硬规则——", [
      "L 优先』刚性规则——",
      "L 优先』硬规矩——",
      "L 优先』硬杠杠——",
      ]),
    ],
    ("ENFP", "ENFP-faq-public-speaking"): [
      # anchor
    ],
    ("ESFP", "ESFP-faq-public-speaking"): [
      ("但思维比嘴快半拍——", [
      "但想法比嘴快半拍——",
      "但脑里想法比嘴快半拍——",
      ]),
      # already above
      ("与 50 分钟举牌", [
      "加 50 分钟举牌",
      "时 50 分钟举牌",
      ]),
      ("—互动越热烈越兴奋，", [
      "—气氛越热烈越兴奋，",
      "—场子越热烈越兴奋，",
      ]),
      ("越高涨，Se 越上场", [
      "越高涨，Se 越上头",
      "越高涨，Se 越起劲",
      ]),
      ("场的『现场感』一旦", [
      "场的『现场感』只要",
      "场的『现场感』如果",
      ]),
      ("靠 Se 顶上去会加速", [
      "靠 Se 顶上会加速",
      "靠 Se 顶上去会加力",
      ]),
      ("前 50 分钟要有", [
      "前 50 分钟给",
      "前 50 分钟留",
      ]),
      ("0 分钟举牌提醒", [
      "0 分钟举牌给",
      "0 分钟举牌叫",
      ]),
    ],
    ("ESTP", "ESTP-faq-public-speaking"): [
      ("但思维比嘴快半拍——", [
      "但脑子比嘴快半拍——",
      "但想法比嘴快半拍——",
      ]),
      ("与 50 分钟举牌", [
      "时 50 分钟举牌",
      "加 50 分钟举牌",
      ]),
      # already above
    ],
    ("ESFP", "ESFP-weakness-01"): [
      # anchor
    ],
    ("ESTP", "ESTP-weakness-01"): [
      ("擅长长期规划，常常『", [
      "擅长期规划，常常『",
      "擅长长线规划，常常『",
      "擅长长程规划，常常『",
      ]),
    ],
    ("ISFP", "ISFP-weakness-01"): [
      ("擅长长期规划，常常『", [
      "擅长长线规划，常常『",
      "擅长长程规划，常常『",
      "擅长长期谋划，常常『",
      ]),
    ],
    ("ISTP", "ISTP-cognitive-01"): [
      ("逻辑网里自洽，否则不", [
      "逻辑网里自洽，否则不",
      ]),
      # already above
    ],
    ("ISTP", "ISTP-relationship-01"): [
      ("需要对方懂得珍惜沉默", [
      "需要对象懂得珍视安静",
      "需要伴侣懂得珍惜沉默",
      ]),
      ("。需要对方懂得珍惜沉", [
      "。需要对象懂得珍视沉",
      "。需要伴侣懂得珍视沉",
      ]),
      ("懂得珍惜沉默的陪伴。", [
      "懂得珍视安静共处。",
      "能珍惜沉默的陪伴。",
      ]),
    ],
    ("ENTJ", "ENTJ-faq-social-drain"): [
      ("是能量源——但前提是", [
      "是能量源——但前提得是",
      "是能量源——但前提得是",
      ]),
      ("来是能量源——但前提", [
      "来是能量源——但前提",
      ]),
    ],
    ("ESTJ", "ESTJ-faq-family-pressure"): [
      (" 面对家庭催婚催生会", [
      " 面对家人催婚催生会",
      " 面对家庭催婚催育会",
      ]),
      ("相：家人要的不是你的", [
      "相：家人想要的不是你的",
      "相：家人渴望的是你的",
      ]),
    ],
    ("ENTP", "ENTP-strength-01"): [
      ("方案的场合（产品策划、", [
      "方案的场合（产品策划、",
      "方案的场所（产品策划、",
      ]),
      ("案的场合（产品策划、", [
      "案的场所（产品策划、",
      ]),
    ],
    ("ENTP", "ENTP-faq-deadline"): [
      ("可能更好』的念头——", [
      "可能更好』的冲动——",
      "可以更佳』的念头——",
      ]),
      ("进 backlog ", [
      "进 backlog ",
      ]),
      # already above
    ],
    ("ESTP", "ESTP-faq-decision"): [
      ("关上了 B 的门——", [
      "锁上了 B 的门——",
      "关死了 B 的门——",
      ]),
      ("够深的东西，B 没你", [
      "够硬的东西，B 没你",
      "够狠的东西，B 没你",
      ]),
      # already above
    ],
    ("INFJ", "INFJ-strength-03"): [
      ("是天然的内容创作者。", [
      "是天然的内容产出者。",
      "是天然的内容生产者。",
      ]),
    ],
    ("ISFP", "ISFP-faq-deadline"): [
      ("达到心中的完美而拖延", [
      "够不到心中的完美而拖延",
      "达不到心中的完美而拖延",
      ]),
      ("则：先拿出七成的版本", [
      "则：先拿出 70% 的版本",
      "则：先拿出七成的稿件",
      ]),
      ("—完成度本身就是进度", [
      "——完成度就是进度本身",
      "——完成度本身就是进度",
      ]),
    ],
    ("ISFP", "ISFP-faq-breakup"): [
      ("唯一的灵魂伴侣』——", [
      "唯一的灵魂伴侣』，",
      "唯一的灵魂伴侣』；",
      ]),
      ("后面的可能性。把前任", [
      "后面的可能。把前任",
      ]),
    ],
    ("ISFJ", "ISFJ-faq-criticism"): [
      ("被批评后会在脑里反刍", [
      "被批评后会在脑中反刍",
      "被批评后会在脑内反刍",
      ]),
      ("被批评后会在脑里反刍", [
      "被批评后会在脑中反刍",
      "被批评后会在脑内反刍",
      ]),
      ("是行为不一定是你这个", [
      "是动作不一定是你这个",
      "是表现不一定是你这个",
      ]),
      ("行为不一定是你这个人", [
      "动作不一定是你这个人",
      "表现不一定是你这个人",
      ]),
    ],
    ("ISFP", "ISFP-faq-alone-weekend"): [
      ("可持续社交的前提。把", [
      "长期社交的前提。把",
      "稳定社交的前提。把",
      ]),
    ],
    ("ISFP", "ISFP-faq-self-doubt"): [
      ("静得受不了时才浮上来", [
      "静得忍不住时才浮上来",
      "静到忍不住时才浮上来",
      ]),
      ("在自己价值观里都站", [
      "在自己价值体系里都站",
      "在自我价值尺里都站",
      ]),
      ("为什么『都是我的错", [
      "为什么『都是我不好",
      "为什么『问题在我",
      ]),
    ],
    ("ISFP", "ISFP-faq-conflict"): [
      ("本能是把感受锁在里面", [
      "反应是把感受锁起来",
      "反应是把感受收起来",
      ]),
      ("——写下来的也算数，", [
      "——写下的话也算数，",
      "——写下的话也有效，",
      ]),
    ],
    ("ISFP", "ISFP-faq-criticism"): [
      ("i 的全盘判定模式，", [
      "i 的整体判定模式，",
      "i 的通盘判定模式，",
      ]),
      ("是行为不一定是你这个", [
      "是表现不一定是你这个",
      "是事件不一定是你这个",
      ]),
      ("行为不一定是你这个人", [
      "事件不一定是你这个人",
      "反应不一定是你这个人",
      ]),
      ("评拆成两层：事实认账", [
      "评拆成两部分：事实认账",
      "评拆两层：事实认账",
      ]),
    ],
    ("ISFP", "ISFP-weakness-02"): [
      ("回去，长期变成隐性怨", [
      "回去，长期转为隐性怨",
      "回去，长期成为隐性怨",
      ]),
    ],
    ("INFP", "INFP-weakness-01"): [
      ("现在在情绪里』的信号", [
      "现在情绪化』的信号",
      "当下情绪化』的信号",
      ]),
    ],
    ("ISFP", "ISFP-relationship-01"): [
      ("但需要少数能进入内心", [
      "但需要少数能走进内心",
      ]),
      (" 的深连接是稀有品。", [
      " 的深链接是稀有品。",
      ]),
    ],
    ("ISFJ", "ISFJ-career-01"): [
      ("一深度陪伴与支持——", [
      "一对一深度陪伴与支持——",
      "一深度陪伴和支持——",
      ]),
    ],
    ("ESTP", "ESTP-relationship-01"): [
      ("里需要持续的新鲜感和", [
      "里需要不断的新鲜感和",
      "里需要持续的新鲜度与",
      ]),
      ("通常是也爱玩、能一起", [
      "通常也是爱玩、能一起",
      "通常都爱玩、能一起",
      ]),
    ],
    ("ISFP", "ISFP-trait-03"): [
      ("别人感受不到的细节。", [
      "他人感受不到的细节。",
      "旁人感受不到的细节。",
      ]),
    ],
    ("ESFJ", "ESFJ-faq-new-job"): [
      ("前三个月慢一点是正常", [
      "前三月慢一拍是常态",
      "头三月慢一点是常态",
      ]),
    ],
    ("ESFJ", "ESFJ-faq-social-drain"): [
      ("份『社交后恢复清单』", [
      "份『应酬之后恢复清单』",
      "份『社交后清零清单』",
      ]),
      ("读、散步。把恢复流程", [
      "、散步。把恢复流程",
      "读书。把恢复流程",
      ]),
    ],
    ("ESFJ", "ESFJ-faq-criticism"): [
      ("是我哪里做得不够好』", [
      "是我哪里没做好』",
      "是我哪里没做对』",
      ]),
    ],
    ("ESFJ", "ESFJ-faq-conflict"): [
      ("在冲突里本能先道歉", [
      "冲突中本能先道歉",
      "冲突里本能先道歉",
      ]),
      ("。背后也有不少委屈", [
      "。背后也攒着不少委屈",
      "。背后藏着不少委屈",
      ]),
    ],
    ("ESFJ", "ESFJ-faq-self-doubt"): [
      ("FJ 会陷入一段沉", [
      "FJ 会陷进一段沉",
      "FJ 容易陷入一段沉",
      ]),
      (" 把责任往自己肩上揽", [
      " 把责任往自己身上揽",
      " 把责任往自己身上堆",
      ]),
    ],
    ("ISFJ", "ISFJ-cognitive-02"): [
      ("他人情绪为决策坐标，", [
      "他人感受是决策坐标，",
      "他人情绪成决策坐标，",
      ]),
    ],
    ("ISTJ", "ISTJ-career-02"): [
      ("主管、运营经理；适合", [
      "主管、运营主管；适合",
      "经理、运营经理；适合",
      ]),
      ("常事务管得井井有条。", [
      "常事务理得井井有条。",
      "常事务理得条理分明。",
      ]),
    ],
    ("ISTJ", "ISTJ-relationship-01"): [
      ("TJ 不是浪漫型而是", [
      "TJ 不是浪漫型，而是",
      "TJ 不是浪漫派，而是",
      ]),
      ("能把『我爱你』转化为", [
      "能把『我爱你』化为",
      "能把『我爱你』变为",
      ]),
    ],
    ("ISTJ", "ISTJ-faq-breakup"): [
      ("感觉一个可执行的容器", [
      "感觉一个可运行的容器",
      "感到一个可执行的容器",
      ]),
    ],
    ("ISTJ", "ISTJ-faq-decision"): [
      ("认一个真相：有些节点", [
      "认一个事实：有些节点",
      "认清一个真相：有些节点",
      ]),
      ("预算』，把破例从事后", [
      "预算』，把例外从事后",
      "预算』，把破格从事后",
      ]),
      ("；否则你会在某个节点", [
      "；否则你会在某个节骨眼",
      "；否则会在某个节点",
      ]),
      ("卡住，因为稳妥选项都", [
      "卡住，因为稳妥路线都",
      "停滞，因为稳妥选项都",
      ]),
    ],
    ("ISTJ", "ISTJ-faq-teamwork"): [
      ("TJ 在团队里会被", [
      "TJ 在团队里常被",
      "TJ 在团队中会被",
      ]),
      ("在线条里前置协商清楚", [
      "在线里前置协商清楚",
      "在流程里前置协商清楚",
      ]),
    ],
    ("ISFJ", "ISFJ-faq-decision"): [
      ("FJ 在重大抉择里会", [
      "FJ 在重大抉择时会",
      ]),
    ],
    ("ISFJ", "ISFJ-faq-new-job"): [
      # ok, was anchor
    ],
    ("ESTJ", "ESTJ-trait-03"): [
      ("优点，对敏感者是雷区", [
      "特质，对敏感者是雷区",
      "风格，对敏感者是雷区",
      ]),
    ],
    ("ISTP", "ISTP-faq-deadline"): [
      ("功先拆，把保命项扔", [
      "功先拆，把核心项扔",
      "功能拆，把保命项扔",
      ]),
      ("穿 Se 提前预演最坏", [
      "穿 Se 提前走一遍最坏",
      "穿 Se 提前演练最坏",
      ]),
      ("，哪怕打到一半，", [
      "，哪怕做到一半，",
      "，哪怕做完一半，",
      ]),
    ],
    ("ESTP", "ESTP-faq-breakup"): [
      ("触发点、自己的模式、", [
      "触发点、自己的剧本、",
      "触发点、自己的节奏、",
      ]),
    ],
    ("ESFP", "ESFP-faq-alone-weekend"): [
      ("的小事清单——咖啡馆", [
      "的小清单——咖啡馆",
      "的清单——咖啡馆",
      ]),
      ("把刺激的来源从『找人", [
      "把嗨点的来源从『找人",
      "把刺激的源头从『找人",
      ]),
      ("做有正反馈的小事』；", [
      "做能拿到反馈的小事』；",
      "做有反馈的小事』；",
      ]),
    ],
    ("ESFP", "ESFP-faq-criticism"): [
      ("会反弹成大段反驳——", [
      "会反弹成长篇反驳——",
      "会反弹成大段顶嘴——",
      ]),
      ("下来，情绪浓度会自然", [
      "下来，情绪水位会自然",
      "下来，情绪能量会自然",
      ]),
      ("。写在纸上比发群里稳", [
      "。落笔比发群里更稳",
      "。写在纸上比群里稳",
      ]),
    ],
    ("ESFP", "ESFP-faq-new-job"): [
      ("也就这样』的感觉——", [
      "也就这样』的体感——",
      "也就这样』的味道——",
      ]),
      (" 的新鲜感衰减极快。", [
      " 的新鲜感衰减很快。",
      " 的新鲜感掉得极快。",
      ]),
      ("你的，不是环境的——", [
      "是你的，不是环境的——",
      "是你，而非环境的——",
      ]),
      ("后者换地方也救不了。", [
      "后者搬地方也救不了。",
      "后者挪地方也救不了。",
      ]),
      ("间重新长出来更划算。", [
      "间重新生根更划算。",
      "间重新长出更划算。",
      ]),
    ],
    ("ESFP", "ESFP-faq-decision"): [
      ("在重大抉择里会被『最", [
      "在重大选择里会被『最",
      "在重大决定里会被『最",
      ]),
      (" 6 个月』，再问『", [
      " 6 个月』，再问问『",
      " 6 个月』，再回头问『",
      ]),
    ],
    ("ESFP", "ESFP-faq-exam"): [
      ("都学不深』的陷阱——", [
      "都不深入』的陷阱——",
      "都不扎实』的陷阱——",
      ]),
      ("新概念不停。觉得这个", [
      "新花样不停。觉得这个",
      "新点子不停。觉得这个",
      ]),
      ("周只刷真题和错题，新", [
      "周只啃真题和错题，新",
      "周只刷真题与错题，新",
      ]),
    ],
    ("ESFP", "ESFP-faq-teamwork"): [
      ("装进『结构化容器』：", [
      "塞进『结构化容器』：",
      "装进『结构容器』：",
      ]),
      ("选一个靠谱的搭档共同", [
      "挑一个靠谱的搭档一起",
      "选位靠谱的搭档共同",
      ]),
    ],
    ("ESFP", "ESFP-cognitive-02"): [
      ("心价值系统，不符合的", [
      "心价值体系，不符合的",
      "心价值尺子，不符合的",
      ]),
    ],
    ("ESFP", "ESFP-strength-03"): [
      ("陌生人场合快速破冰，", [
      "陌生人堆里快速破冰，",
      "陌生场合快速破冰，",
      ]),
    ],
    ("ISTP", "ISTP-faq-decision"): [
      ("前凭借直觉行动，", [
      "前凭本能就动，",
      "前凭直觉行动，",
      ]),
      ("决策前给自己留一段", [
      "决定前给自己留一段",
      "决策前留一段",
      ]),
      ("直到身体里松动了", [
      "直到身体放松下来",
      ]),
    ],
    ("ISTP", "ISTP-faq-teamwork"): [
      ("事后解释切到事前分流", [
      "事后说明切到事前分流",
      "事后补救切到事前分流",
      ]),
    ],
    ("INFP", "INFP-faq-self-doubt"): [
      ("，Ne 把问题延伸到", [
      "，Ne 把问题扩散到",
      "，Ne 把视角延伸到",
      ]),
    ],
    ("ENFJ", "ENFJ-faq-social-drain"): [
      ("ENFJ 在社交场合", [
      "ENFJ 在应酬场合",
      "ENFJ 在交际场合",
      ]),
    ],
    ("ISFJ", "ISFJ-faq-alone-weekend"): [
      ("——Si + Fe ", [
      "——Si 与 Fe ",
      "——Si 配 Fe ",
      ]),
    ],
    ("ISTP", "ISTP-faq-new-job"): [
      ("，Ti + Se 的", [
      "，Ti 与 Se 的",
      "，Ti 配 Se 的",
      ]),
    ],
}


def main():
    all_entries = load_all()

    changed_total = 0
    for it in range(8):
        data = get_scan()
        cross = data["cross_personality"]
        same = sum(len(v) for v in data["same_personality"].values())

        # 按 entry 收集 all applicable swaps
        todo = {}  # (p, eid) -> [(old, candidates)]
        # 收集当前所有重叠 fragments + 每条 entry 在哪个 fragment 中
        sources = cross + [g for sub in data["same_personality"].values() for g in sub]
        for item in sources:
            frag = item["fragment"]
            for e in item["entries"]:
                # same_personality 没 personality 字段，从 key 推
                if "personality" in e:
                    p = e["personality"]
                else:
                    # same_personality 的 eid 以 "<P>-xxx" 开头
                    eid = e["id"]
                    p = eid.split("-")[0]
                key = (p, e["id"])
                # 检查这个 entry 是否有这个 frag 的候选
                if key not in ENTRY_CANDIDATES:
                    continue
                for (old, cands) in ENTRY_CANDIDATES[key]:
                    if old == frag:
                        todo.setdefault(key, []).append((old, cands))
                        break

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
            # 收集所有 partner 文本
            partners_text = []
            for item in sources:
                for oe in item["entries"]:
                    if "personality" in oe:
                        op = oe["personality"]
                    else:
                        op = oe["id"].split("-")[0]
                    if (op, oe["id"]) != (p, eid):
                        partners_text.append(all_entries.get((op, oe["id"]), ""))

            # 应用所有 candidates
            applied_any = False
            for (old, cands) in edits:
                if old not in new_text:
                    continue
                # 检查是否需要替换（还有重叠）
                # 看 partners 中是否还有条目含 old
                still_overlap = False
                for pt in partners_text:
                    if old in pt:
                        still_overlap = True
                        break
                if not still_overlap:
                    continue
                # 尝试每个 candidate
                for cand in cands:
                    if cand in new_text:
                        continue
                    trial = new_text.replace(old, cand, 1)
                    if not cat_len_ok(cat, len(trial)):
                        continue
                    # 检查 trial 是否还与 partners 有 ≥10 字公共子串
                    # 收集 cur 与所有 partners 的已有重叠
                    old_overlaps = set()
                    for pt in partners_text:
                        for s in lcs_pairs(cur, pt):
                            old_overlaps.add(s)
                    # 检查 trial
                    bad = False
                    for pt in partners_text:
                        for s in lcs_pairs(trial, pt):
                            # 如果 s 与任何 old_overlap 重合（含子串/超串），则不是新的
                            is_new = True
                            for o in old_overlaps:
                                if s == o or s in o or o in s:
                                    is_new = False
                                    break
                            if is_new:
                                bad = True
                                break
                        if bad:
                            break
                    if not bad:
                        new_text = trial
                        applied_any = True
                        break
            if applied_any and new_text != cur:
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


if __name__ == "__main__":
    main()