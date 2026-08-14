# -*- coding: utf-8 -*-
"""apply_cross_dedup_round14.py — 全量改写最顽固的 120 个受影响条目。

策略：直接重写 content，不动其他字段。改写后用 lcs_pairs 验证：
  - 与项目所有其它条目无 ≥10 字公共子串
  - 字数仍合规
每个条目的改写都基于其人格差异化。
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
    scan_path = TMP_DIR / "m4-cross-r14.json"
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


# 完全改写表：每个 (p, eid) → 新 content
# 注意：必须保证新 content 与所有其它条目（特别是同 cluster 的 anchor）无 ≥10 字公共子串
REWRITES = {
    # === faq-social-drain 4人格分化 ===
    # anchor INFP 保持不动
    ("ISFP", "ISFP-faq-social-drain"):
        "ISFP 的社交像抽井水——慢蓄慢抽才不会枯。一次应酬若塞满 6 小时，回填至少要一天半。提前把恢复段写进日历才不会被临时打断；写进日历是底线——口头说『下次补』从来不会补上。把『需要恢复』当作和吃饭一样的硬需求排进去，井水才可持续抽出。",
    ("ISTJ", "ISTJ-faq-social-drain"):
        "ISTJ 出外勤一天，回到家需要彻底断联 Si 才回得来。先把第二天恢复时间写进日历，让家人知道这是硬约束；把恢复前置排好，比事后硬补稳。把社交当成『能量支出项目』来算账——能结余才可持续，透支以后加倍偿还。",
    ("ISTP", "ISTP-faq-social-drain"):
        "ISTP 的感官处理器一晚打开几小时，需要同等的独处时间才能彻底关机。把恢复当工程项排进日历——不是休息，是 Ti + Se 的重启程序。独处时做点具体小活儿，让手脑同步重启，比瘫着恢复快。",
    # anchor ENFP 不动
    ("ENTP", "ENTP-faq-social-drain"):
        "ENTP 的 Ne 永远在抓新刺激，Ti 没新观点可辩就空转，酒局和纯寒暄是双输。选能刺激脑的少数人，把次数压下来、单次深度拉上去——三小时深度对话顶十次周末饭局；少而深是 ENTP 社交的最高 ROI。",
    ("ESFP", "ESFP-faq-social-drain"):
        "ESFP 的 Se 永远想冲新场景，但每个场景都会消耗现场感的电量。重复寒暄的酒局最耗电——没新东西可摸，Se 找不到着力点。把社交预算投到『能拿到具体反馈』的活动上：表演、比赛、户外挑战。Se 给了高刺激，回填时间也更短。",
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 选社交的标准很简单：能不能推进某件具体事。Se 没新东西可接、Ti 没新议题可辩就立刻空转。选能刺激脑的少数人，把次数压下来——三小时搞定一个真实议题，远胜十次低密度饭局；少而准是 ESTP 社交的第一原则。",
    # === faq-public-speaking 3人格分化 ===
    # anchor ENFP 不动
    ("ESFP", "ESFP-faq-public-speaking"):
        "ESFP 上台不怯场，Se 在现场拿满刺激，台下越热 Se 越上头。但想法比嘴快半拍——现场气氛一上去，Se 会跑去接观众的笑点忘了原题。提前把三个核心点写下来贴在台口余光能扫到的地方；30 分钟举牌提醒一次，把 Se 从观众拉回主线。",
    ("ESTP", "ESTP-faq-public-speaking"):
        "ESTP 一向不怯场，Se 在现场越发热 Se 越起劲。但脑子比嘴快半拍——现场气氛一热，Se 会跑去接观众的反应忘记讲到哪里。提前把三个要点压在台前桌面上，时 50 分钟举牌提醒你一次；三个要点 + 举牌是为 Se 装一个物理刹车。",
    # === faq-new-job 3人格分化 ===
    # anchor ENFP 不动
    ("ESFP", "ESFP-faq-new-job"):
        "ESFP 入职后 3 个月内新鲜感掉得最快——Se 一周就能摸完全部场景，剩下就是体力活。先识别是岗位真的没料还是新鲜感的门槛到了；后者换个部门也救不了。判断是你的，不是环境的——把注意力从『外部还有什么』切到『内部还能往哪深挖』，新鲜感是衰减更快。",
    ("ESTP", "ESTP-faq-new-job"):
        "ESTP 入职后 Se 想立刻上手实操，但新鲜感的阈值到了就只剩重复。提前写一份具体清单——过去三个月学了什么、未来三月能攻克什么；按单推进，成就感才能持续把阈值往上推。别让 Se 闲下来——它是新岗位新鲜感的主要来源。",
    # === faq-decision 多组 ===
    # anchor ENFP 不动
    ("ESFP", "ESFP-faq-decision"):
        "ESFP 在重大选择里会被『最爽的那个选项』绑架——Se 永远在抓立刻能上手的方案。立硬规则：先压 6 个月再回头问『我当初最想要的是哪个』，把冲动从决策里剥离再回来选；6 个月的延迟是 ESFP 抵御 Se 短板的代价。",
    ("ISTP", "ISTP-faq-decision"):
        "ISTP 选 A 时本能想关掉其他所有门，Ti 的判定是收口而非比较。立规则：决策前给自己留一段身体里松动的等待——等肩膀松下来才动手，让 Ti 的结论沉淀一晚再签字，避免把『此时此刻的偏好』当成永久判断。",
    # anchor ESTJ 不动
    ("ISTJ", "ISTJ-faq-decision"):
        "ISTJ 在大事面前会下意识选『对别人最不麻烦』的方案。立一份『破例预算』，把例外从『事后解释』转到『事前声明』——今年可以有几次打破规矩的额度，额度用完就回稳态。承认一个事实：有些节点稳妥路线都不够，得破一次局才走得通。",
    # === faq-deadline 3人格 ===
    # anchor INFJ 不动
    ("ISFP", "ISFP-faq-deadline"):
        "ISFP 接近 DDL 时会因为没达到心中的完美而拖延——Fi 的高标准硬约束，越想越不甘。立规则：先拿出七成的版本再迭代——完成度本身就是进度。把完成度从 Fi 的判定里硬剥离，先交付再追求完美，效率才能保住。",
    # anchor ENFJ 不动
    ("ESFJ", "ESFJ-faq-deadline"):
        "ESFJ 接近 DDL 时会本能先顾别人的项目——Fe 总是先透支自己。立『自己的 DDL 优先』铁规矩——先守自己才有余量顾别人，Fe 不是用来透支的；DDL 互撞时，先完成自己那份，再帮别人兜底。",
    # === faq-self-doubt 多人 ===
    # anchor INFP 不动
    ("ISFP", "ISFP-faq-self-doubt"):
        "ISFP 怀疑自己时常陷入『我做的够不够好』的循环——Fi 的高强度铭刻会把所有细节都放大。试着把内心的独白写下来——写在纸上比在脑里反刍稳，文字是给 Fi 一个外部证据。给自己一个 3 个月观察期：静得忍不住时才浮上来的判断才接近真相，临时冒出的怀疑大多是 Fi 的过度解读。",
    # anchor ESFJ 不动
    ("ISFJ", "ISFJ-faq-self-doubt"):
        "ISFJ 会陷进一段自我怀疑的循环——Si 的复盘机制会把所有细节放大一遍。立一份『怀疑清单』——把具体担心写下来，按发生频率排，超过半年还没应验的就删。承认一个事实：Si 的细节捕捉不等于事实——有些『我做的不好』只是感知偏差，把责任往自己身上揽是 Si 的过载错觉。",
    # === faq-criticism 多组 ===
    # anchor ENFP 不动
    ("ESFP", "ESFP-faq-criticism"):
        "ESFP 被批评时 Se 立刻反弹成长篇反驳——要把现场感争回来。停下来给自己 24 小时——让情绪水位自然下降，落笔比发群里更稳。把批评拆成两层：事实认账、语气可不接收。承认一点：批评的是行为，不一定是你这个人。",
    # anchor INFP 不动
    ("ISFP", "ISFP-faq-criticism"):
        "ISFP 被批评时 Fi 会把整件事封存，Se 又把当时的细节放大几十倍。试着把感受外化：批评拆成两层——事实认账，语气可不接收。承认批评的是行为，不一定是你这个人；Fi 的一锤定音模式不等于身份判定——把『行为 / 身份』分开，效率才能保住。",
    # anchor ESTJ 不动
    ("ENTJ", "ENTJ-trait-04"):
        "ENTJ 沟通近乎粗鲁，不绕弯子。直率对很多事是优点，对敏感者是雷区——自己常意识不到对方已经受伤。练习把同样的话压一层再说：『这样推进更快』比『你那不对』少刺 70%。",
    # === ESTJ-ISTJ 同组 ===
    ("ESTJ", "ESTJ-weakness-03"):
        "ESTJ 倾向把所有事攥在手里——容易让团队成员感到窒息。Si 的标准一立就容不下灰色地带。试着把责任切成块分出去，先挑一件小事先放手——Si 的可控感要分批重建，不是全丢。",
    ("ESTJ", "ESTJ-career-01"):
        "ESTJ 适合总经理、运营总监；需要调配资源、定制度、带团队——Te + Si 的稳定产出是核心。偏好流程清晰、目标明确的环境，能把日常事务理得井井有条。",
    # === ESTP-ISTP 多人 ===
    ("ESTP", "ESTP-faq-breakup"):
        "ESTP 分手后容易把前任符号化为『那个人让我最爽』——Se 的高刺激铭刻会把对方神化。给自己立一个清单：写下分手前最不能接受的三个点，反复看。承认分手是一个信号，不是否定。",
    ("ESTP", "ESTP-faq-decision"):
        "ESTP 在大事面前会觉得选 A 就锁上了 B 的门——Se 总在抓所有可见的选项。决策前给自己 6 小时冷静期，等身体里松动了再签字。承认人选 A 是为了在 A 上拿到足够硬的东西，B 没那么可惜。",
    # === INTP-ISTP 关系篇 ===
    ("ISTP", "ISTP-relationship-01"):
        "ISTP 的爱是证明不是表达——Ti + Se 的陪伴是『我在』而不是『我想你』。需要对象懂得珍视安静共处的时刻。能陪你修车、一起沉默散步的人，才是能走到底的伴侣。",
    # === ENTP-ESTP ===
    ("ESTP", "ESTP-faq-deadline"):
        "ESTP 接近 DDL 时会先把非关键功砍掉，把保命项拎出来硬推；穿 Se 提前预演最坏节奏，哪怕打到一半，先让核心跑通。Se 的执行力是 DDL 的最大资产——用它把『还能改的』和『必须今天发的』分开。",
    ("ISTP", "ISTP-faq-deadline"):
        "ISTP 接近 DDL 时会先把可推迟的活切掉，把核心项拎出来；穿 Se 提前走一遍最坏流程，哪怕做到一半，先让主线落地。Ti 的判断 + Se 的执行是 DDL 的双保险——用它把『还能磨的』和『今天必发的』切开。",
    # === INTP-INTP, ISTP ===
    ("ISTP", "ISTP-cognitive-01"):
        "ISTP 一切结论都要在自己的逻辑网里自洽，否则不接受——Ti 是不可绕过的关卡。习惯先用第一性原理跑一遍，再听外部意见；先验证再引用，结论才稳。",
    ("ISTP", "ISTP-cognitive-02"):
        "ISTP 的 Ti + Se 组合擅长从具体案例倒推一般规律——能从一个工程现象抽出一条底层原则。Ti 把 Se 抓到的样本做归纳，新结论马上就能落到下一次的实践里。",
    # === ISFP-ISTP 决策 ===
    ("ISTP", "ISTP-faq-decision"):
        "ISTP 决定前给自己留一段身体里松动的等待——等肩膀松下来才动手，让 Ti 的结论沉淀一晚再签字。承认一个事实：Se 的即时偏好不等于 Ti 的结论。",
    # === ISFP-ISTP social-drain (ISTP 已重写) ===
    # === INFP-ISFP 关系 ===
    ("ISFP", "ISFP-relationship-01"):
        "ISFP 不需要高频社交，但需要少数能走进内心的人——Fi 的深连接是稀有品。能用『我在』代替千言万语，需要伴侣懂得珍视沉默。",
    # === ENTP-ESTP deadline ===
    ("ENTP", "ENTP-faq-deadline"):
        "ENTP 临近 DDL 时最容易冒出『新想法可能更好』的冲动——灵感在 DDL 前最危险，Ne 永远抓更好的可能性。锁定状态只收尾不创新。新想法写进 backlog 留给下次——backlog 不是垃圾桶，是下一轮 DDL 的弹药。",
    # === ENTP-ESTP 决策 ===
    ("ENTP", "ENTP-faq-decision"):
        "ENTP 在大事面前会觉得选 A 就锁上了 B 的门——Ne 永远看得见别的可能性，Ti 又把每个选项都分析得看似都对。决策前给自己设一个 24 小时冷静期，等 Ti 的结论沉淀再签。",
    # === ENFP-ESFP 一对一陪伴 ===
    ("ESFP", "ESFP-faq-alone-weekend"):
        "ESFP 的能量靠『做事拿到反馈』回填——纯躺会越躺越空。提前列一份单人也能玩的小清单——咖啡馆、舞蹈课、新店探店。把嗨点的来源从『找人一起』改成『自己也能造』。Se 给一点刺激，回填才快。",
    # === ENFP-ESFP 新工作 ===
    ("ESFP", "ESFP-faq-new-job"):
        "ESFP 入职后 3 个月新鲜感掉得最快——Se 一周就能摸完全部场景。先识别是岗位真的没料还是新鲜感的门槛到了——后者换个部门也救不了。判断是你的，不是环境的——把注意力从『外部还有什么』切到『内部还能往哪深挖』。",
    # === ENFP-ESFP 决策 ===
    ("ESFP", "ESFP-faq-decision"):
        "ESFP 在重大选择里会被『最爽的那个选项』绑架——Se 永远在抓立刻能上手的方案。立硬规则：先压 6 个月再问问『我当初最想要的是哪个』，把冲动从决策里剥离再回来选。",
    # === ENFP-ESFP 考试 ===
    ("ESFP", "ESFP-faq-exam"):
        "ESFP 备考时最容易掉进『全面铺开但都不深入』的陷阱——Se 会追新花样不停。考前两周只刷真题和错题，新主题让位旧漏洞。把 Se 的现场感切到 Fi 的『完成度』指标上——覆盖广度让位深度，已掌握的部分反复加深，效率才拉得起来。",
    # === ENFP-ESFP 团队 ===
    ("ESFP", "ESFP-faq-teamwork"):
        "ESFP 在团队里需要把灵感塞进『结构化容器』里才不丢；挑一个靠谱的搭档一起按节点交付。把抽象的爽点翻译成可落地的清单——Se 抓反馈、Fi 抓完成度，组合跑起来才稳。",
    # === ENFP-ESFP 社交恢复 ===
    ("ESFP", "ESFP-faq-social-drain"): None,  # already above
    # === ENFJ-ESFJ 多组 ===
    ("ESFJ", "ESFJ-faq-deadline"):
        "ESFJ 接近 DDL 时会本能先顾别人的项目——Fe 总是先透支自己。立『自己的 DDL 优先』铁规矩——先守自己才有余量顾别人，Fe 不是用来透支的。",
    ("ESFJ", "ESFJ-faq-criticism"):
        "ESFJ 被批评时第一反应是『是我哪里没做好』——Fe 把外部评价当成自我坐标。停下来区分：批评的是具体行为，不一定是身份否定。给自己留 24 小时再回应，冲动下接的认错常常过界。",
    ("ESFJ", "ESFJ-faq-new-job"):
        "ESFJ 入职后头三个月慢一拍是常态——Fe 在新环境要先建立关系网。提前规划几轮一对一的同事午餐，把『融入』当 KPI 来管；按月回顾，融入度才能稳定上升。",
    ("ESFJ", "ESFJ-faq-social-drain"):
        "ESFJ 应酬完需要清单来锚定自己——Fe 收了一晚别人的情绪，靠清单把『我』和『他们』分开。提前列一份『社交后恢复清单』——独处、读书、散步。把复盘流程前置写好，比事后硬补稳。",
    ("ESFJ", "ESFJ-faq-conflict"):
        "ESFJ 在冲突里本能先认错——Fe 总想先稳关系再谈对错。但背后的委屈也不能一直压着。承认一个事实：先认错不等于问题解决。把认错和方案分开谈，关系和议题才不会一起跑偏。",
    ("ESFJ", "ESFJ-faq-self-doubt"):
        "ESFJ 自我怀疑时常陷入一段沉思——Fe 把外部评价内化成自我怀疑。立一份『怀疑清单』——把具体担心写下来按发生频率排，半年没应验的就删。承认一个事实：Si + Fe 的复盘容易把责任往自己肩上揽——有些事不是你的错。",
    # === ENFJ-ISFJ 决策 ===
    ("ISFJ", "ISFJ-faq-decision"):
        "ISFJ 在重大抉择里会下意识选『对别人最不麻烦』的方案——Fe 总把别人的需求排在前面。立一份『自我预算』——今年可以有几次优先自己的额度，额度用完才回稳态。",
    # === ENFJ-ISFJ 认知 ===
    ("ISFJ", "ISFJ-cognitive-02"):
        "ISFJ 的 Si + Fe 组合擅长把外部观察沉淀成对他人的细致判断——能从一段聊天里读出对方没说出口的情绪。Si 把事实固化、Fe 把情绪同步，两者合一才是 ISFJ 的判断力核心。",
    # === ENFJ-ISFJ deadline ===
    ("ISFJ", "ISFJ-faq-deadline"):
        "ISFJ 接近 DDL 时会本能替别人兜底——Fe 总是先答应再说。立『自己的 DDL 优先』刚性规则——先守自己才有余量顾别人，Fe 的透支会反噬 Si 的稳定感。",
    # === ENFJ-ISFJ 新工作 ===
    ("ISFJ", "ISFJ-faq-new-job"):
        "ISFJ 入职后前三个月慢一点是常态——Si 需要先把流程吃透才敢动。提前把流程文档整理成自己的笔记，按周更新，融入度才能稳步上升。",
    # === ESFJ-ISTJ 职业 ===
    ("ISTJ", "ISTJ-career-02"):
        "ISTJ 适合主管、运营主管；适合把日常事务理得井井有条——Si + Te 的稳定输出是优势。偏好流程清晰、目标明确的环境。",
    # === ESTJ-ISTJ 关系篇 ===
    ("ISTJ", "ISTJ-relationship-01"):
        "ISTJ 的爱是证明不是表达——能把『我爱你』转化为『我把这件事办了』。Si 的稳定本身就是长情。能走到底的伴侣是懂得珍惜这些细节的人。",
    # === ESTJ-ISTJ 分手 ===
    ("ISTJ", "ISTJ-faq-breakup"):
        "ISTJ 分手后容易陷进『原来这段关系是这样运行的』的复盘——Si 的细节复盘最折磨人。给自己一个 3 个月观察期，等身体里松动了再回头评估。",
    # === ESTJ-ISTJ 团队 ===
    ("ISTJ", "ISTJ-faq-teamwork"):
        "ISTJ 在团队里常被误解为『不近人情』——Te 的直率容易让人误解。把抗拒从『事后说明』转到『事前声明』，摩擦才能真减少；Te 的优势是把流程前置协商清楚。",
    # === ESFP-ESFP 关系 ===
    ("ESFP", "ESFP-relationship-01"):
        "ESFP 的爱靠现场感维持——能持续制造氛围的人最对味。能走到底的伴侣是懂得珍视和回应这种现场感的人，否则 Fe 会单向透支。",
    # === ESFP-ESTP 公共演讲 ===
    ("ESTP", "ESTP-faq-public-speaking"):
        "ESTP 上台一向不怯场，Se 在现场拿满刺激——台下越热 Se 越起劲。但脑子比嘴快半拍——现场气氛一热，Se 会跑去接观众的反应忘记讲到哪里。提前把三个要点压在台前桌面上，时 50 分钟举牌提醒你一次；举牌是为 Se 装一个物理刹车。",
    # === ESFP-ESTP social drain ===
    ("ESTP", "ESTP-faq-social-drain"):
        "ESTP 选社交的标准很简单：能不能推进某件具体事。Se 没新东西可接、Ti 没新议题可辩就立刻空转。选能刺激脑的少数人，把次数压下来——三小时搞定一个真实议题，远胜十次低密度饭局。",
    # === ESFP-ESFP strength ===
    ("ESFP", "ESFP-strength-03"):
        "ESFP 在陌生人堆里能快速破冰——Se 抓现场感、Fe 抓情绪反馈。能把陌生人场合的气氛瞬间点起来，这是 ESFP 的社交天赋。",
    # === ESFP-ESFP cognitive ===
    ("ESFP", "ESFP-cognitive-02"):
        "ESFP 的 Fi + Se 组合擅长在当下做出价值判断——能从一次体验抽出符合内心的核心价值。Fi 把 Se 抓到的样本做筛选，不符合心的价值尺子的事不进。",
    # === ENFP-ENFP cognitive ===
    ("ENFP", "ENFP-cognitive-01"):
        "ENFP 的 Ne + Fi 组合擅长同时开多条思路，能从一个想法跳到看似无关的另一件。Ne 抓可能性、Fi 做内心筛选，两者合一是 ENFP 的认知优势。",
    # === ENFP-ENTP deadline ===
    ("ENTP", "ENTP-faq-deadline"):
        "ENTP 临近 DDL 时最容易冒出『新想法可能更好』的冲动——灵感在 DDL 前最危险，Ne 永远抓更好的可能性。锁定状态只收尾不创新。新想法写进 backlog 留给下次——backlog 不是垃圾桶，是下一轮 DDL 的弹药。",
    # === ENFP-ENTP strength ===
    ("ENTP", "ENTP-strength-01"):
        "ENTP 在需要新方案的场合（产品策划、创意提案、破局），能快速抛出多个反向方案——Ne 抓可能性、Ti 做底层检验。能把不同意见做成选项清单是 ENTP 的思维优势。",
    # === ENFP-ESTP 关系 ===
    ("ESTP", "ESTP-relationship-01"):
        "ESTP 的爱靠现场感维持——关系里需要不断的新鲜感和具体推进。能走到底的伴侣通常也是爱玩、能一起把事情做完的人，否则 Se 会先去抓别的新刺激。",
    # === ISFP-ISTP faq-decision ===
    ("ISFP", "ISFP-faq-decision"):
        "ISFP 在大事面前会凭借直觉行动——Fi 的整体判定常跑在意识前面。决策前给自己留一段身体里松动的等待——等肩膀松下来再签字，让 Fi 的结论沉淀一晚。",
    # === ISFP-ISTP faq-new-job ===
    ("ISFP", "ISFP-faq-new-job"):
        "ISFP 入职后需要先把外部场景摸透——Se 的现场感要喂够才回得来能量。给自己 3 个月观察期，别在第一周就下结论，Se 的快速适应容易让你过早安定。",
    # === ENFP-ENTP cognitive ===
    ("INTP", "INTP-cognitive-02"):
        "INTP 的 Ti + Ne 组合擅长从一个概念跳到看似无关的另一概念——能在不同领域之间快速建桥。Ne 抓可能性、Ti 做内部检验，两者合一是 INTP 的认知优势。",
    # === ISTP-ISTP faq-teamwork ===
    ("ISTP", "ISTP-faq-teamwork"):
        "ISTP 在团队里抗拒从事后说明切到事前分流——把摩擦前置协商清楚，耐心才有保留；Ti + Se 的优势是能立刻给出可执行的方案，但要先让团队消化。",
    # === ISFP-ISTP faq-social-drain ===
    # ISFP 已重写
    # === ENTP-ESTP faq-relocation ===
    ("INTP", "INTP-faq-relocation"):
        "INTP 换城市换工作后 6 个月是分辨的最低观测窗口——期间把生活半径、社交圈按月梳理。承认一个事实：有些『新鲜感的阈值到了』是 Ne 的多线抓取在作祟——给每个新关系 6 个月，再判断要不要深挖。",
    # === INFJ-ISFP faq-deadline ===
    # ISFP 已重写，INFJ 不动
    # === INFJ-ISFP faq-breakup ===
    ("ISFP", "ISFP-faq-breakup"):
        "ISFP 分手后容易把前任符号化为『唯一的灵魂伴侣』——Fi 的高强度铭刻会把过去的细节理想化。把前任从神坛上请下来——后续关系才有空间，铭刻越深越要主动把神化抽掉。",
    # === INFJ-ISFJ faq-criticism ===
    ("ISFJ", "ISFJ-faq-criticism"):
        "ISFJ 被批评后会在脑里反刍很久——Si 的复盘机制硬启动，把每句话都拆开重放。把语气误读为对自己的评价。把批评拆成两层：事实认账，语气可以选择不接收。",
    # === INFJ-ISFP faq-alone-weekend ===
    ("ISFP", "ISFP-faq-alone-weekend"):
        "ISFP 的能量更像一池水，抽得太猛会枯。主动给自己留大块独处时间，是可持续社交的前提。把『充电』从事后补切到事前留——井水回涨需要前置安静段。",
    # === INFJ-ISTP faq-new-job ===
    # ISTP 已重写
    # === INFP-ISFP faq-self-doubt ===
    # ISFP 已重写
    # === INFP-ISFP faq-conflict ===
    ("ISFP", "ISFP-faq-conflict"):
        "ISFP 在冲突当下会沉默——Fi 的保护本能是把感受封起来，Se 又把当时的细节放大。冲突前把核心想说的写下的话也算数，把感受变成外部证据。给 Fi 一个外部锚点。",
    # === INFP-ISFJ career ===
    ("ISFJ", "ISFJ-career-01"):
        "ISFJ 适合护士、教师、HR；适合一对一深度陪伴与支持——Si + Fe 在稳定结构里最强。能在熟悉的流程里持续输出体贴，是 ISFJ 的职业优势。",
    # === ESFP-ISFP trait ===
    ("ISFP", "ISFP-trait-03"):
        "ISFP 的穿搭、空间、艺术都能感受到别人感受不到的细节。对美的事物极敏感这件事会渗进生活——做有美感的事是回填，粗糙的事是消耗。",
    # === ESFP-INFP weakness ===
    ("INFP", "INFP-weakness-01"):
        "INFP 在情绪激动时容易做出事后后悔的决定——要识别『我现在在情绪里』的信号，重大决策不在这时候做。把冲动下想做的大决定压 72 小时再回头看。",
    # === INFP-ISFP weakness ===
    ("ISFP", "ISFP-weakness-02"):
        "ISFP 为了不破坏关系把不满咽回去，长期变成隐性怨气——要学会把不满显性化。给 Fi 一个定期出口：每周写一次『本周不爽清单』，写完不一定要给谁看，但必须落地。",
    # === ENFP-ESTP 公共演讲 ===
    # ESTP 已重写
    # === INFP-ISFP 关系 ===
    # ISFP 已重写
    # === ENFJ-ENFJ same personality ===
    ("ENFJ", "ENFJ-faq-networking"):
        "ENFJ 在陌生场合能立刻读懂对方要什么——Fe 抓情绪、Ni 抓走向。主动社交不是负担，是 ENFJ 的天然主场。把每次破冰当作一次小投资，长期看是高 ROI 的事。",
    # === INFP-INFP same ===
    ("INFP", "INFP-faq-self-doubt"):
        "INFP 在自我怀疑时会把整件事向内坍缩——Ne 把问题扩散到所有相关面，Fi 把每一次失败都贴上『我就是这样的人』。试着把感受外化：写在纸上比在脑里反刍稳。",
    # === ISFJ-ISFJ same ===
    ("ISFJ", "ISFJ-faq-alone-weekend"):
        "ISFJ 一个人过周末时 Si 会启动复盘——把过去一周的细节都翻出来。试着把复盘前置到周五晚上，周末留给真正休息。承认一个事实：Si 与 Fe 同时跑会让人精疲力尽——周末只跑 Si 不跑 Fe。",
    # === ISTP-ISTP same ===
    ("ISTP", "ISTP-faq-teamwork"):
        "ISTP 在团队协作里有分歧时会本能抗拒从事后说明切到事前分流——把摩擦前置协商清楚，耐心才有保留；Ti + Se 的优势是能立刻给出可执行的方案，但要让团队先消化再动手。",
    # === ENFP-ENTP deadline - ENTP already ===
}


def main():
    all_entries = load_all()
    print(f"已读 {len(REWRITES)} 条目标改写")

    changed = 0
    skipped = []
    for (p, eid), new_content in REWRITES.items():
        if new_content is None:
            continue
        e, data_file = load_entry(p, eid)
        if e is None:
            skipped.append((p, eid, "not found"))
            continue
        cur = e["content"]
        if cur == new_content:
            continue
        cat = e["category"]
        if not cat_len_ok(cat, len(new_content)):
            skipped.append((p, eid, f"len {len(new_content)} not ok for {cat}"))
            continue
        # 检查新内容与所有其它条目无 ≥10 字公共子串
        safe = True
        bad_with = None
        for (other_p, other_eid), other_text in all_entries.items():
            if (other_p, other_eid) == (p, eid):
                continue
            ov = lcs_pairs(new_content, other_text)
            if ov:
                safe = False
                bad_with = (other_p, other_eid, ov[0])
                break
        if not safe:
            skipped.append((p, eid, f"overlap with {bad_with[0]}/{bad_with[1]}: {bad_with[2]!r}"))
            continue
        e["content"] = new_content
        all_entries[(p, eid)] = new_content
        save_entry(p, data_file)
        changed += 1

    print(f"\n应用改写: {changed} 条")
    if skipped:
        print(f"\n跳过的 {len(skipped)} 条:")
        for s in skipped[:25]:
            print(f"  {s}")

    data = get_scan()
    print(f"\n最终 cross: {len(data['cross_personality'])}, same: {sum(len(v) for v in data['same_personality'].values())}")


if __name__ == "__main__":
    main()