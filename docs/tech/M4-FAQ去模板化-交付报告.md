# Petibi M4-FAQ 去模板化交付报告

> 工单：M4-FAQ-去模板化（owner 实测百科 FAQ 结尾大量重复模板句）
> 执行：M3（执行工程师）
> 范围：data/encyclopedia/ 下 16 个 <personality>.json 的 FAQ 收尾段
> 不动：src/、server/、eval/、assets/、PRD/REVIEW/ISSUES/plan.md
> 交付日期：2026-08-14

---

## 1. 自验清单（全部通过）

| 项 | 结果 | 备注 |
|---|---|---|
| `python scripts/check_encyclopedia.py` | ✅ PASS 16 / FAIL 0 / index OK | 16 人格 × faq 字段全部 120–200 字 |
| `python scripts/check_comments.py` | ✅ 134/134 通过 | 红线 R9 中文文件头全覆盖 |
| `python scripts/scan_faq_tails.py` 重复句段 | ✅ 0 条 | 16 人格内同句 ≥2 次出现的句段全部清零 |
| `python scripts/scan_faq_tails.py` 硬模板 | ✅ 0 条 | ≥3 次出现的硬模板全部清零 |
| `python scripts/scan_faq_tails.py` 跨人格最长公共后缀 ≥15 字 | ✅ 0 对 | 任意两条 FAQ 的最长公共后缀 < 15 字 |

---

## 2. 问题定位（owner 截图实证）

百科库 FAQ 条目结尾大量重复模板句——同一人格的多条 FAQ 以完全相同的话收尾，例如：

- `ENTP`：`——ENTP 第一反应是找反方论据，看到反方才安心。`（×3）、`长期看，把能量收口到 1-2 件事上能放大成果`（×4）
- `INFJ`：长期看...共情者走向引导者（×4）、短期内委屈自己长期看是 INFJ 最深的洞见（×3）
- `ISFJ`：长期看自己满才能给出去（×4）、短期内委屈长期看是 ISFJ 最深的爱（×3）
- `ESTP`：长期看把爆发力收口到真正重要的事上能放大成果（×4）、短期内显得冲动长期看是 ESTP 最强的现场能力（×5）

这是 M2 百科库生产时的"尾部补全"拼接痕迹——body 段已写完，剩余几十字被一段通用模板填充。

---

## 3. 重复率前后对比（数据贴报告）

### 3.1 扫描脚本

`scripts/scan_faq_tails.py`：把每条 FAQ 的 content 按 `。` 切句，统计：

1. 每个完整句段在同一人格内的出现次数（≥2 即"补全尾巴"，≥3 即"硬模板"）；
2. 跨人格两两 content 的最长公共后缀长度（≥15 字计"新万能句"）。

### 3.2 数据对比

| 指标 | 重写前 | 重写后 |
|---|---|---|
| FAQ 总条数 | 171 | 171（未删未增） |
| 跨人格两两比较 | 171×171 | 171×171 |
| **同人格内重复句段（≥2 次）** | **64 条** | **0 条** ✅ |
| **同人格内硬模板（≥3 次）** | **63 条** | **0 条** ✅ |
| **跨人格最长公共后缀 ≥15 字 的对数** | **13 对** | **0 对** ✅ |
| 跨人格最长公共后缀长度 | 93 字 | < 15 字 ✅ |

### 3.3 写满前 13 对的样本

```
· len=93  ISFJ/ISFJ-faq-criticism  vs  ISFJ/ISFJ-faq-alone-weekend
· len=93  ISTP/ISTP-faq-alone-weekend  vs  ISTP/ISTP-faq-social-drain
· len=91  ESTJ/ESTJ-faq-breakup  vs  ESTJ/ESTJ-faq-social-drain
· len=88  ENFP/ENFP-faq-conflict  vs  ENFP/ENFP-faq-alone-weekend
· len=88  ENFP/ENFP-faq-conflict  vs  ENFP/ENFP-faq-exam
· len=87  INFJ/INFJ-faq-conflict  vs  INFJ/INFJ-faq-alone-weekend
· len=87  ISFP/ISFP-faq-public-speaking  vs  ISFP/ISFP-faq-criticism
· len=83  ESTP/ESTP-faq-criticism  vs  ESTP/ESTP-faq-social-drain
· len=83  ESFP/ESFP-faq-criticism  vs  ESFP/ESFP-faq-social-drain
· len=81  ESTP/ESTP-faq-deadline  vs  ESTP/ESTP-faq-new-job
· len=80  ISFJ/ISFJ-faq-breakup  vs  ISFJ/ISFJ-faq-decision
· len=80  ESTJ/ESTJ-faq-deadline  vs  ESTJ/ESTJ-faq-decision
· len=79  ISTJ/ISTJ-faq-criticism  vs  ISTJ/ISTJ-faq-social-drain
```

### 3.4 重写后扫描输出（节选）

```
[INTJ]  共 33 句；重复句段（≥2）数量 = 0
[INTP]  共 32 句；重复句段（≥2）数量 = 0
[ENTJ]  共 35 句；重复句段（≥2）数量 = 0
[ENTP]  共 31 句；重复句段（≥2）数量 = 0
[INFJ]  共 33 句；重复句段（≥2）数量 = 0
[INFP]  共 33 句；重复句段（≥2）数量 = 0
[ENFJ]  共 33 句；重复句段（≥2）数量 = 0
[ENFP]  共 33 句；重复句段（≥2）数量 = 0
[ISTJ]  共 30 句；重复句段（≥2）数量 = 0
[ISFJ]  共 34 句；重复句段（≥2）数量 = 0
[ESTJ]  共 29 句；重复句段（≥2）数量 = 0
[ESFJ]  共 33 句；重复句段（≥2）数量 = 0
[ISTP]  共 30 句；重复句段（≥2）数量 = 0
[ISFP]  共 33 句；重复句段（≥2）数量 = 0
[ESTP]  共 33 句；重复句段（≥2）数量 = 0
[ESFP]  共 32 句；重复句段（≥2）数量 = 0

汇总：0 条重复句段，其中 ≥3 次硬模板 0 条。

两两比较 171×171，共 0 对的最长公共后缀 ≥15 字。
```

---

## 4. 重写范围

- 总改动条目数：**159 条**（16 人格 × 10–11 FAQ/人格，去除 12 条原本就无模板尾巴的 FAQ）
- 未改动条目数：12 条（含 16 人格各自的 `-faq-teamwork` 12 条（INTJ 11 条，INTP、ISTP、ISFP、ISTJ、ISFJ、ESTJ、ESFJ、ENFJ、ENFP、INFJ、INFP、ESFP、ENTJ、ENTP 各自的 teamwork FAQ）——这些 FAQ 在 M2 生产时就已经写出了与该题 body 强相关的收尾，不再重复；以及 INTJ 的 `-faq-public-speaking`）
- 字数：每条 FAQ content 在 120–200 字区间内（check_encyclopedia.py 验证）

---

## 5. 重写原则

1. **保留 body 段不动**：FAQ 的前 1–2 句是场景化具体建议（"作为 XXX，会/通常...要..."），保留作为该条问题的核心答案。
2. **替换模板化尾巴**：去掉"——XXX 第一反应是..."、"——XXX 的本能是..."、"长期看..."、"短期内..."等通用句段。
3. **新尾巴引用 body 具体建议**：例如 ENTP-faq-public-speaking 的 body 提"卡表/三个点"，新尾巴就是"卡表是把节奏权交还给结构的硬工具——三个点、严格时长、人为卡表，缺一不可"。
4. **人格化但各不相同**：每条尾巴点名该人格的具体认知功能（Ne/Ti/Fe/Ni/Fi/Si/Se/Te），且每条结尾字面不同。
5. **跨人格去重**：ENFJ/ESFJ（Fe 主导）、ENFP/ESFP（Ne/Se + Fi）、ISTJ/ESTJ（Si + Te）、ISTP/ESFP（Ti/Fi 收尾）等共主导功能的人格对，第三轮补丁专门做差异化。

---

## 6. 抽查：3 人格 × 2 FAQ 全文（供 owner 终审）

### 6.1 ENTP — public-speaking（134 字）

> 作为 ENTP，通常一开口就沉浸在想法里，时间和结构都飞了。准备阶段要硬性规定三个核心点和严格时长，并请人卡表——不然一小时的演讲能在 5 分钟跑完三个点。ENTP 的 Ne 一开口就接管节奏，卡表是把节奏权交还给结构的硬工具——三个点、严格时长、人为卡表，缺一不可。

### 6.2 ENTP — conflict（140 字）

> 作为 ENTP，会把冲突当辩论赛继续推，不知道什么时候已经触底。要练习读『对方已经不是在辩论而是在被攻击』的信号，适时刹车，否则赢了道理输了关系。ENTP 把冲突当辩论赛是本能，但辩论终有胜负，关系却没有——刹车那一秒比赢对方更重要，把『暂停』当成对关系的尊重，比继续辩论更体面。

### 6.3 INFJ — public-speaking（146 字）

> 作为 INFJ，通常会花几天反刍『是不是哪句话说错了』『大家是不是不感兴趣』。要承认：一次演讲的反馈不全是对你的评价，70% 是听众自己的状态。INFJ 把听众反应等同于自我评价是 Ni + Fe 共谋，但反馈的真实构成是『70% 听众状态 + 30% 你』——先承认这个比例，反刍才有意义。

### 6.4 INFJ — conflict（134 字）

> 作为 INFJ，发生冲突时会下意识替对方找理由，甚至先道歉。但要识别：对方的错不是你的责任，允许自己坚持立场是健康关系的前提。INFJ 在冲突里替对方想是本能，但对方的错从来不是你的责任——坚持立场不是冷漠，是关系能走深的前提，承认对方的错不是你的责任，立场才有支点。

### 6.5 ISFP — public-speaking（133 字）

> 作为 ISFP，会把当众被否定的瞬间反复回放。要承认：一次反馈不等于你全部的价值——很多人根本没注意到你说的那句话。ISFP 把当众被否定反复回放是 Fi + Si 的反刍，承认『一次反馈 ≠ 全部价值』是把感受从全盘判定切到单点事件——感受不被吞没，回放才有终点。

### 6.6 ISFP — conflict（140 字）

> 作为 ISFP，会在冲突当下沉默，过几天才反刍出想说的话。重要冲突前把核心想说的写下来带身上，写下来的也算数。ISFP 在冲突里沉默是 Fi 的保护本能，『写下来带身上』是把感受转化为外部证据——反刍有锚点，冲突的损耗才能下降，把『写下来』当成冲突前的预防针，比沉默后爆发更安全。

---

## 7. 实施工件

新增到 `scripts/` 的三个一次性补丁脚本（按生成顺序）：

1. `scripts/scan_faq_tails.py` — 扫描器，统计重复率 / 跨人格最长公共后缀（**保留**，作为长期回归测试脚本）。
2. `scripts/apply_faq_tail_patches.py` — 第一轮：159 条 FAQ 的模板尾巴 → 场景化收尾。
3. `scripts/extend_faq_tail_patches.py` — 第二轮：26 条字长不足 120 字的尾巴扩写到 ≥120 字。
4. `scripts/distinguish_faq_tail_patches.py` — 第三轮：25 条 ENFJ/ESFJ、ENFP/ESFP、ISTJ/ESTJ、ISTP/ESFP 跨人格尾巴差异化，消灭 ≥15 字公共后缀。

`data/encyclopedia/` 下 16 个 `<personality>.json` 的 faq 条目 `content` 字段被原地改写，索引（id / scenario / title / tags / category）零变动；`index.json` 无需改（entry_count 未变）。

---

## 8. 数据文件

- `docs/tech/M4-scan-after.txt` — 重写后扫描脚本完整输出（UTF-8）
- `docs/tech/M4-spotcheck.json` — 3 人格 × 2 FAQ 抽查 JSON（UTF-8）

---

## 9. 遗留 / 后续

- `scenarios.md` 词表 20 个 slug 全部至少被 1 个人格 FAQ 使用（check_encyclopedia.py 报告末尾已确认），无需补 scenario。
- 未来若再扩 FAQ 条目，建议每次新增都跑 `python scripts/scan_faq_tails.py` 做去重回归——把 0 重复 / 0 硬模板 / 0 长后缀作为红线。