// 【文件说明】把 data/questions/questions.json 加载到运行时可用的 QuestionBank。
//
// 选型理由：JSON 文件 → import 直接读为对象，零运行时 IO、零依赖；同 tsconfig 的
// resolveJsonModule 已打开，无需额外插件。data/ 不进 src/，但 TS 路径上能解析到。
//
// 校验：导入后立即对 version / dimensions / questions 形状做最小校验，缺字段就抛错，
// 避免 UI 拿到残缺题库再报错（错误信息暴露在用户面前）。
import bankJson from '../../data/questions/questions.json'
import type { Dimension, Question, QuestionBank } from './types'

const RAW = bankJson as unknown as QuestionBank

function isQuestion(x: unknown): x is Question {
  if (!x || typeof x !== 'object') return false
  const q = x as Record<string, unknown>
  return (
    typeof q.id === 'string' &&
    typeof q.dimension === 'string' &&
    typeof q.direction === 'string' &&
    typeof q.text === 'string' &&
    typeof q.source === 'string' &&
    typeof q.source_ref === 'string'
  )
}

function validate(bank: QuestionBank): QuestionBank {
  if (!bank || typeof bank !== 'object') {
    throw new Error('题库文件不是合法对象')
  }
  if (typeof bank.version !== 'string') {
    throw new Error('题库 version 字段缺失')
  }
  const dims = bank.dimensions
  if (!Array.isArray(dims) || dims.length !== 5) {
    throw new Error(`题库 dimensions 应为 5 个维度，实际 ${Array.isArray(dims) ? dims.length : 'N/A'}`)
  }
  const allowed: Dimension[] = ['EI', 'SN', 'TF', 'JP', 'ES']
  for (const d of dims) {
    if (!allowed.includes(d)) {
      throw new Error(`题库含非法维度 ${String(d)}`)
    }
  }
  if (!Array.isArray(bank.questions) || bank.questions.length === 0) {
    throw new Error('题库 questions 不能为空')
  }
  for (const q of bank.questions) {
    if (!isQuestion(q)) {
      throw new Error(`题库含非法题目：${JSON.stringify(q).slice(0, 60)}`)
    }
  }
  return bank
}

/** 校验后的题库（运行时直接消费） */
export const questionBank: QuestionBank = validate(RAW)

/** 题目数量（40 题符合 PRD §3.3 题量） */
export const questionCount: number = questionBank.questions.length