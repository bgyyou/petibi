// 【文件说明】计分引擎的类型定义（M2 工单 / 数据契约 §1 题库 schema + §4 引擎接口）
// 本文件只放类型与极性常量表；可被 score.ts 与 score.test.ts 同时 import
// 对应红线：R5（确定性）、R9（中文注释）

// 五维度，按数据契约 §1 的 dimensions 字段顺序
export type Dimension = "EI" | "SN" | "TF" | "JP" | "ES"

// 极性方向：
// - EI 用 "E" / "I"
// - SN 用 "S" / "N"
// - TF 用 "T" / "F"
// - JP 用 "J" / "P"
// - ES 用 "stable" / "sensitive"（数据契约 §1 注释：避免与 EI 的 E 混淆）
export type EIPole = "E" | "I"
export type SNPole = "S" | "N"
export type TFPole = "T" | "F"
export type JPPole = "J" | "P"
export type ESPole = "stable" | "sensitive"
export type Direction = EIPole | SNPole | TFPole | JPPole | ESPole

// 单道题；字段顺序与契约 §1 题库 schema 完全一致
export interface Question {
  id: string
  dimension: Dimension
  // 该题"同意时加分的方向"：第二极题（反向题）必须与第一极题成对存在，防止默认赞同偏差
  direction: Direction
  text: string
  // 数据契约 §1 / 红线 R6：每题必须有题源与出处，便于溯源
  source: string
  source_ref: string
}

// 题库聚合；对应 data/questions/questions.json 的内存形态
// 引擎不读文件、不做 IO，这里只定义"引擎消费的结构"
export interface QuestionBank {
  version: string
  dimensions: Dimension[]
  questions: Question[]
}

// 答案向量：题号 → 1..5 评分（5 级量表，见数据契约 §1）
export type AnswerValue = 1 | 2 | 3 | 4 | 5
export type Answers = Record<string, AnswerValue>

// 各维度"第一极"得分占比（0..100），即 percentages[dim] 数值越高 → 该极越强
// 平局（恰好 50）按数据契约 §4 / 红线 R5 取第一极
export type Percentages = Record<Dimension, number>

// 最终人格结果
export interface TypeResult {
  // 四字母 MBTI 类型，如 "INTJ"
  type: string
  // 细分标签：基于 ES 维度是否 ≥ 50
  // - 第一极（stable）对应 "坚定型"
  // - 第二极（sensitive）对应 "善感型"
  subtype: "stable" | "sensitive"
  // 各维度第一极百分比，用于 UI 展示与可解释性
  percentages: Percentages
}

// 第一极表（≥50% 取第一极，平局 50 也取第一极）：
// EI → "E"，SN → "S"，TF → "T"，JP → "J"，ES → "stable"
// 该表是契约 §4 平局取第一极规则的"真理源"，score.ts 据此判定极性
export const FIRST_POLE = {
  EI: ["E", "I"] as [EIPole, EIPole],
  SN: ["S", "N"] as [SNPole, SNPole],
  TF: ["T", "F"] as [TFPole, TFPole],
  JP: ["J", "P"] as [JPPole, JPPole],
  ES: ["stable", "sensitive"] as [ESPole, ESPole],
} as const

// 维度全集合（用于百分比 Record 的 keyof 与 cycles）
export const DIMENSIONS: readonly Dimension[] = ["EI", "SN", "TF", "JP", "ES"]
