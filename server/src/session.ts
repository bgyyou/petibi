// 【文件说明】多轮对话 session 模块（M4 多轮对话 B 工单）：
//   - 从 chat_logs 取指定 (user_id, session_id) 最近 N 轮对话（question+answer 配对）
//   - 把历史拼接成 prompt 上下文片段，并做"摘要式截断"控制总长 ≤ MAX_HISTORY_CHARS
//   - 提供 chat_logs 写入时携带 session_id 的小工具（在 chat.ts 调用）
//
// 设计要点：
//   1. 历史放在 system（基础层之后、用户问题之前），让 LLM 自然参考；
//      不放 user 角色：避免 LLM 把对话历史当成"新的指令"。
//   2. 截断策略"摘要式"——总长超阈值时从最旧的轮次开始整轮丢弃（不切到词中间），
//      保证每轮 question+answer 完整可见；尾部追加"[更早 N 轮已省略]"提示。
//   3. 不查被意图过滤命中或守卫命中的行（refused=1 或 guard_hit=1）：这些行的 answer
//      是模板文本或拒绝话术，混进历史会污染上下文。
//   4. session_id 为空 / null → 返回空字符串，路由层跳过注入（保持单轮链路兼容）。

import type { Db } from "./db.js"

/** 最近 N 轮对话（M4 工单 §B1 规定） */
export const SESSION_HISTORY_ROUNDS = 6

/** 历史 prompt 上下文最大字符数（M4 工单 §B1 ≤2000 字） */
export const MAX_HISTORY_CHARS = 2000

/** 历史片段开头标识，便于 prompt 工程调试 */
const HISTORY_HEADER = "【对话历史｜最近轮次按时间正序】"

/** 截断时尾部追加的提示，告诉 LLM 上下文不完整 */
const HISTORY_TRUNCATED_NOTE = "（更早的对话轮次已省略）"

/** 单条历史行（按时间正序） */
export interface HistoryTurn {
  question: string
  answer: string
}

/**
 * 读取 (user_id, session_id) 对应的最近 N 轮历史。
 *
 * 排除规则：
 *   - session_id 不匹配的行（其它会话串的）
 *   - session_id 为 NULL 的行（M3 之前写入的历史；不视为多轮上下文）
 *   - refused = 1 的行（意图过滤命中的拒绝模板，不构成"真实对话"）
 *   - guard_hit = 1 的行（守卫拦截后改用拒绝模板，同样不构成"真实对话"）
 *
 * 按 created_at ASC 取最近的 SESSION_HISTORY_ROUNDS 轮。
 */
export function loadRecentHistory(
  db: Db,
  userId: number,
  sessionId: string,
  limit: number = SESSION_HISTORY_ROUNDS,
): HistoryTurn[] {
  // 防御：空串 / 纯空白 / null/undefined 都视为无 session，直接返回
  if (!sessionId || !sessionId.trim()) return []
  // 子查询先按 id DESC 取最近 N 条，再反转回正序；这样 SQL 只做一次 IO
  const rows = db
    .prepare(
      `SELECT question, answer FROM (
         SELECT id, question, answer
           FROM chat_logs
          WHERE user_id = ? AND session_id = ?
            AND refused = 0 AND guard_hit = 0
          ORDER BY id DESC
          LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(userId, sessionId, limit) as Array<{ question: string; answer: string }>
  return rows.map((r) => ({ question: r.question, answer: r.answer }))
}

/**
 * 把历史轮次渲染成 LLM 上下文片段，并在总长 > MAX_HISTORY_CHARS 时做"摘要式截断"。
 *
 * 截断规则（M4 工单 §B1）：
 *   - 总长按"前缀 + 拼接"字符串字符数估算；
 *   - 超阈值时从最旧轮次开始整轮丢弃（即第一个轮次）；
 *   - 至少保留 1 轮（单轮超长也整轮保留，避免上下文断流）；
 *   - 发生过丢弃时尾部追加 HISTORY_TRUNCATED_NOTE，但若追加导致最终 > MAX_HISTORY_CHARS
 *     则在最后一轮尾部追加"……"省略号兜底，保证硬上限不破。
 *
 * 返回空字符串代表无历史，路由层据此跳过注入。
 */
export function formatHistoryForPrompt(turns: HistoryTurn[]): string {
  if (turns.length === 0) return ""

  const blocks = turns.map((t, i) => formatTurn(t, i + 1))
  let dropped = 0
  // 从最旧开始丢弃，直到 ≤ MAX_HISTORY_CHARS 或仅剩 1 轮
  while (
    blocks.length > 1 &&
    blocks.join("\n\n").length + HISTORY_HEADER.length + 1 > MAX_HISTORY_CHARS
  ) {
    blocks.shift()
    dropped += 1
  }
  let body = blocks.join("\n\n")
  if (dropped > 0) {
    body = body + "\n\n" + HISTORY_TRUNCATED_NOTE
  }
  let out = HISTORY_HEADER + "\n" + body
  // 硬上限保护：哪怕极端情况下单轮过长也用 "……" 兜底，避免撑爆 prompt 预算
  if (out.length > MAX_HISTORY_CHARS) {
    out = out.slice(0, MAX_HISTORY_CHARS - 1) + "…"
  }
  return out
}

/** 单轮渲染："轮 N｜用户：…\n助手：…"，便于模型对齐"你 vs 用户"身份 */
function formatTurn(t: HistoryTurn, index: number): string {
  return [
    `轮 ${index}`,
    `用户：${t.question}`,
    `助手：${t.answer}`,
  ].join("\n")
}