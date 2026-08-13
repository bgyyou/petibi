// 【文件说明】计分引擎：纯函数 score(answers, bank) → TypeResult（M2 工单 / R5 红线）
// 严格遵守数据契约 §4：
//   - 单题得分：direction 为第一极 → answer - 1；direction 为第二极 → 5 - answer；区间 [0, 4]
//   - 维度内求和后归一化到 0..100（百分比）
//   - 阈值 50：≥50 取第一极（含恰好 50，红线 R5 平局取第一极，确定性）
//   - 无任何 IO / 随机 / 时间依赖；同 answers 调用结果严格一致

import {
  DIMENSIONS,
  FIRST_POLE,
  type Answers,
  type AnswerValue,
  type Dimension,
  type Percentages,
  type Question,
  type QuestionBank,
  type TypeResult,
} from "./types"

// 单题最大可能得分：4。direction 为第一极时 answer=5 → 4；direction 为第二极时 answer=1 → 4
const PER_QUESTION_MAX = 4

/**
 * 单题得分：加给该题所属性"第一极"方向的分数。
 * - 当 direction 等于该维度的 FIRST_POLE[0]（第一极），分数 = answer - 1
 *   例：direction="E"（第一极），answer=5 → 加给 E 的 4 分；answer=1 → 0 分
 * - 当 direction 等于第二极（反向题），分数 = 5 - answer
 *   例：direction="I"（第二极），answer=5 → 0 分；answer=1 → 加给第一极 4 分
 * 这样反向题与正向题"得分方向相反但加的都是第一极分"，便于后续百分化
 */
export function scoreOne(question: Question, answer: AnswerValue): number {
  const firstPole = FIRST_POLE[question.dimension][0]
  return question.direction === firstPole ? answer - 1 : 5 - answer
}

/**
 * 引擎主入口：输入答案 + 题库，输出最终 MBTI 类型 + 细分 + 五维百分比。
 * 抛错情形：
 *   - 缺题：题库中某道题在 answers 里没有键
 *   - 越界评分：答案不是 1..5 的整数
 */
export function score(answers: Answers, bank: QuestionBank): TypeResult {
  // 第一步：输入校验，同时锁住"缺题"与"越界评分"两种非法情形
  // 这一步必须在聚合之前完成，否则空字符串/NaN 会进入累加器污染结果
  for (const q of bank.questions) {
    const a = answers[q.id]
    if (a === undefined || a === null) {
      throw new Error(`缺少题号 ${q.id} 的答案`)
    }
    if (typeof a !== "number" || !Number.isInteger(a) || a < 1 || a > 5) {
      throw new Error(`题号 ${q.id} 的答案 ${String(a)} 非法，必须为 1..5 的整数`)
    }
  }

  // 第二步：按维度聚合"第一极得分总和"与"最大可能得分总和"
  // 第一极分数的方向：恒定为该维度 FIRST_POLE[0] 这一极
  const firstSum: Record<Dimension, number> = { EI: 0, SN: 0, TF: 0, JP: 0, ES: 0 }
  const maxSum: Record<Dimension, number> = { EI: 0, SN: 0, TF: 0, JP: 0, ES: 0 }

  for (const q of bank.questions) {
    const raw = answers[q.id] as AnswerValue  // 上方已校验
    firstSum[q.dimension] += scoreOne(q, raw)
    maxSum[q.dimension] += PER_QUESTION_MAX
  }

  // 第三步：归一化到 0..100，并对浮点结果保留两位小数
  // 保留两位小数是为了：① UI 显示稳定；② 不同平台浮点末位不抖动（R5 确定性）
  const percentages = {} as Percentages
  for (const dim of DIMENSIONS) {
    percentages[dim] = round2((firstSum[dim] / maxSum[dim]) * 100)
  }

  // 第四步：阈值判定 → 字母；恰好 50 也归第一极（红线 R5 / 契约 §4 平局取第一极）
  // 这一步是确定性的唯一来源：所有相等的分支必须落在一处
  const ei = percentages.EI >= 50 ? "E" : "I"
  const sn = percentages.SN >= 50 ? "S" : "N"
  const tf = percentages.TF >= 50 ? "T" : "F"
  const jp = percentages.JP >= 50 ? "J" : "P"
  const subtype: "stable" | "sensitive" = percentages.ES >= 50 ? "stable" : "sensitive"

  return {
    type: `${ei}${sn}${tf}${jp}`,
    subtype,
    percentages,
  }
}

/**
 * 四舍五入保留两位小数：用于百分比归一化。
 * 用乘法 + round + 除法，避免 toFixed 返回 string
 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
