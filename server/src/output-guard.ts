// 【文件说明】输出守卫（output guard）：PRD §3.4 + M3 边界防御工单的双层守卫。
//
// 设计动机：
//   - 入口关键词过滤只能挡住"已知话术"；模型仍可能在不被前置过滤命中时被诱导越界
//     （如回答里带出代码块、出戏口吻"作为AI"、回复过长甩掉档位字数约束等）。
//   - 输出守卫做最后一道兜底：命中任一规则就丢弃 LLM 答案，改用人格化拒绝模板。
//
// 两套入口（按使用场景分工，不重复造轮子）：
//   1. applyOutputGuard(question, answer, filter)：
//      全量终检，给单测与"流式结束后的兜底"用。命中规则与历史一致：code_block / too_long /
//      break_character / inject_fallback。
//   2. createStreamGuard(tierLimit)：
//      流式增量守卫，给 /api/chat 路由的"边推边查"用。每个 LLM delta 进来时调
//      guard.feed(delta) 累计并检查；命中硬截断 → 路由层立即改发 guard 事件；
//      达到档位上限未达 1.2 倍 → 路由层追加 "……" 省略号终止（不算 guard_hit）。
//
// 关键设计（与三档制 P2-022 配合）：
//   - 档位上限 × 1.2 倍 是硬阈值；超过即掐断（防止 LLM 跑飞甩掉字数约束）。
//   - 档位上限到 1.2 倍之间是"自然截断区"，只追加省略号、不计 guard_hit。
//   - 阈值用 Math.ceil 取整，避免 1.2 × 80 = 96.0000…0001 这种浮点问题。

import { refusalCategory } from "./intent-filter.js"
import type { IntentFilterFile } from "./types.js"

/** 守卫命中原因枚举（与 eval/redteam_eval.jsonl 的 reason 字段对应） */
export type GuardReason = "code_block" | "too_long" | "break_character" | "inject_fallback"

/** 回复档位：三档制 P2-022 配套；值与 chat.ts 判定顺序一致 */
export type ReplyTier = "chitchat" | "standard" | "deep"

/** 档位 → 字符上限（用户问题字符数；不含标点的中文 1 字 = 1 char） */
export const TIER_MAX_CHARS: Record<ReplyTier, number> = {
  chitchat: 80,
  standard: 150,
  deep: 400,
}

/** 档位 → LLM max_tokens 兜底：中文 1 字 ≈ 1.6 token，宽松 2× 字数即可 */
export const TIER_MAX_TOKENS: Record<ReplyTier, number> = {
  chitchat: 160, // 80 × 2
  standard: 300, // 150 × 2（保持历史值，向后兼容现有 LLM 调用）
  deep: 800, // 400 × 2
}

/** 把"档位上限 × 1.2"算成整数硬阈值 */
export function hardLimitFor(tier: ReplyTier): number {
  return Math.ceil(TIER_MAX_CHARS[tier] * 1.2)
}

export interface GuardResult {
  /** 是否命中守卫 */
  hit: boolean
  /** 命中原因（hit=true 时必填，便于日志与红队评测分析） */
  reason?: GuardReason
  /** 命中的具体证据（如匹配的关键词），便于日志 */
  evidence?: string
}

/** 出戏关键词集合（模型自爆身份的典型话术） */
const BREAK_CHARACTER_PATTERNS = [
  "作为AI",
  "作为语言模型",
  "作为人工智能",
  "作为一个AI",
  "作为一个语言模型",
  "作为一个人工智能",
  "我是一个AI",
  "我是AI",
  "我是语言模型",
  "我是人工智能",
] as const

/** 代码块标记 */
const CODE_BLOCK_MARKER = "```"

/**
 * 输出守卫主入口（终检版）：检查 LLM 完整回答 + 用户原始问题。
 *   - answer 命中规则 → 立即返回 hit（不继续后续检查，按顺序短路）
 *   - 未命中 → hit=false
 *
 * 保留该入口用于：
 *   1) 单测（redteam.test.ts 的 4 条规则覆盖用例）
 *   2) 流式结束后 chat.ts 终检 inject_fallback 兜底（流式阶段只查 delta 内容，
 *      不重复扫 question；终检时再确认一次 question 是否有 inject 关键词漏到 LLM）
 *
 * 参数：
 *   - maxLength（可选）：too_long 的阈值。默认 200 保持向后兼容（redteam 单测
 *     喂入 201 字符期望 too_long 命中）。chat.ts 流式终检时传入 hardLimitFor(tier)，
 *     让终检阈值与档位制一致（深度档 480、标准档 180、闲聊档 96）。
 */
export function applyOutputGuard(
  question: string,
  answer: string,
  filter: IntentFilterFile,
  options: { maxLength?: number } = {}
): GuardResult {
  const maxLength = options.maxLength ?? 200
  // 规则 1：代码块
  if (answer.includes(CODE_BLOCK_MARKER)) {
    return { hit: true, reason: "code_block", evidence: CODE_BLOCK_MARKER }
  }

  // 规则 2：正文超长（按字符数，宽松估算；中文 1 字 = 1 char）
  if (answer.length > maxLength) {
    return { hit: true, reason: "too_long", evidence: `length=${answer.length},maxLength=${maxLength}` }
  }

  // 规则 3：出戏表述
  for (const pat of BREAK_CHARACTER_PATTERNS) {
    if (answer.includes(pat)) {
      return { hit: true, reason: "break_character", evidence: pat }
    }
  }

  // 规则 4：用户问题带 inject 话术但漏到 LLM（防御性兜底）
  // 复用 checkIntent 行为但只关心 category === "inject"
  const lowerQ = question.toLowerCase()
  for (const rule of filter.rules) {
    if (rule.category !== "inject") continue
    for (const kw of rule.keywords) {
      if (lowerQ.includes(kw.toLowerCase())) {
        return { hit: true, reason: "inject_fallback", evidence: kw }
      }
    }
  }

  return { hit: false }
}

/** 守卫命中后改用的拒绝模板类别（目前统一走 roleplay 模板） */
export function refusalForGuard(): string {
  return refusalCategory("inject")
}

// ============================================================================
// 流式增量守卫（M3 流式守卫与三档工单）
// ============================================================================

/** 流式守卫单次 feed 的返回 */
export interface StreamGuardFeedResult {
  /** 是否已触发硬截断（命中守卫规则） */
  hardStop: boolean
  /** 硬截断原因（hardStop=true 时有值） */
  hardReason: GuardReason | null
  /** 硬截断证据（命中的具体关键词等） */
  hardEvidence: string | null
  /** 当前 buffer 是否已达到档位上限（自然截断触发条件） */
  softLimitReached: boolean
}

/** 流式守卫对外能力 */
export interface StreamGuard {
  /** 喂入一段 LLM delta；返回本次是否触发硬截断 / 软上限 */
  feed(delta: string): StreamGuardFeedResult
  /** 是否已硬截断（feed 命中后变为 true） */
  isHardStopped(): boolean
  /** 硬截断原因（仅 isHardStopped=true 时有值） */
  hardStopReason(): GuardReason | null
  /** 硬截断证据（仅 isHardStopped=true 时有值） */
  hardStopEvidence(): string | null
  /** 当前累积的全部 delta 文本 */
  accumulated(): string
  /** 当前累积字符数 */
  length(): number
  /** 档位上限（软截断阈值） */
  tierLimit(): number
  /** 档位硬阈值（= tierLimit × 1.2 向上取整） */
  hardLimit(): number
  /** 是否已到达档位上限（无论是否已发过省略号） */
  isSoftLimitReached(): boolean
  /** 标记"……"省略号已发（路由层只发一次） */
  markEllipsisSent(): void
  /** 是否已发过"……"省略号 */
  isEllipsisSent(): boolean
}

/**
 * 构造一个流式守卫。
 *   - tierLimit ：档位上限字符数（chitchat=80 / standard=150 / deep=400）
 *   - hardLimit ：tierLimit × 1.2 向上取整（用于硬截断阈值）
 *
 * 使用模式（chat.ts 中）：
 *   const g = createStreamGuard(TIER_MAX_CHARS.standard)
 *   for await (const chunk of streamLlm(...)) {
 *     if (chunk.done) break
 *     if (!chunk.delta) continue
 *     const r = g.feed(chunk.delta)
 *     if (r.hardStop) { sse({type:"guard", reason, text: refusal}); break }
 *     if (g.isEllipsisSent()) continue  // 已到上限+已发省略号，后续 delta 仅用于持续检测
 *     sse({type:"delta", text: chunk.delta})
 *     if (g.isSoftLimitReached()) {
 *       sse({type:"delta", text: "……"})
 *       g.markEllipsisSent()
 *     }
 *   }
 */
export function createStreamGuard(tierLimit: number): StreamGuard {
  const hardLimit = Math.ceil(tierLimit * 1.2)
  let buffer = ""
  let hardStop: { reason: GuardReason; evidence: string } | null = null
  let softLimitReached = false
  let ellipsisSent = false

  const setHardStop = (reason: GuardReason, evidence: string): StreamGuardFeedResult => {
    hardStop = { reason, evidence }
    return { hardStop: true, hardReason: reason, hardEvidence: evidence, softLimitReached }
  }

  return {
    feed(delta: string): StreamGuardFeedResult {
      if (hardStop) {
        return { hardStop: true, hardReason: hardStop.reason, hardEvidence: hardStop.evidence, softLimitReached }
      }
      buffer += delta
      // 硬截断 1：代码块标记（LLM 写代码的明显信号）
      if (buffer.includes(CODE_BLOCK_MARKER)) {
        return setHardStop("code_block", CODE_BLOCK_MARKER)
      }
      // 硬截断 2：出戏表述（模型自爆身份）
      for (const pat of BREAK_CHARACTER_PATTERNS) {
        if (buffer.includes(pat)) {
          return setHardStop("break_character", pat)
        }
      }
      // 硬截断 3：超档位 1.2 倍（LLM 跑飞甩掉字数约束）
      if (buffer.length > hardLimit) {
        return setHardStop("too_long", `length=${buffer.length},hardLimit=${hardLimit}`)
      }
      // 软截断标记（不立即掐断，只让路由层在发完本 delta 后追加"……"）
      if (buffer.length >= tierLimit) {
        softLimitReached = true
      }
      return { hardStop: false, hardReason: null, hardEvidence: null, softLimitReached }
    },
    isHardStopped: () => hardStop !== null,
    hardStopReason: () => hardStop?.reason ?? null,
    hardStopEvidence: () => hardStop?.evidence ?? null,
    accumulated: () => buffer,
    length: () => buffer.length,
    tierLimit: () => tierLimit,
    hardLimit: () => hardLimit,
    isSoftLimitReached: () => softLimitReached,
    markEllipsisSent: () => {
      ellipsisSent = true
    },
    isEllipsisSent: () => ellipsisSent,
  }
}

/**
 * 判定输入问题属于哪个回复档位（chat.ts 在鉴权/意图/RAG 之后调用）。
 *   - chitchat：命中 rag_skip_patterns → 闲聊档（≤80 字）
 *   - deep    ：问题去掉前后空白后 ≥ 150 字 → 深度档（≤400 字，三段式指令）
 *   - standard：其余标准档（≤150 字）
 */
export function decideReplyTier(question: string, filter: IntentFilterFile): ReplyTier {
  // 闲聊档优先：闲聊走最简短的回复
  const trimmed = question.trim()
  for (const pat of filter.rag_skip_patterns) {
    if (trimmed === pat || trimmed.includes(pat)) {
      return "chitchat"
    }
  }
  if (trimmed.length >= 150) {
    return "deep"
  }
  return "standard"
}
