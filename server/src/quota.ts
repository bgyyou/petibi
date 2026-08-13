// 【文件说明】每日对话配额：契约 §4 配额 R4——每日 N 次，超限拒绝。
//
// 表 chat_usage(user_id, date, count, UNIQUE(user_id,date))：每次请求消耗 1 次；
// 计数发生在 "意图过滤未命中 + 即将调 LLM/记日志" 的临界点，
// 即：被意图过滤直接拒绝的请求也计次（契约 §4 描述："命中则流式返回拒绝模板，不计 LLM 调用但计次"）。
//
// 默认上限 10（PRD §3.4）；通过函数参数注入后保持兼容（B 套直接调用、D 套 HTTP 路由都需要）。

import type { Db } from "./db.js"

/** PRD §3.4 红线 R4：每日免费 10 次（无 config 注入时的兜底） */
export const DEFAULT_DAILY_QUOTA = 10

/**
 * 兼容旧代码的别名（老 quota.test.ts 仍使用 DAILY_QUOTA 名称）；
 * 新代码请用 DEFAULT_DAILY_QUOTA 或在路由层注入 config.dailyQuota。
 */
export const DAILY_QUOTA = DEFAULT_DAILY_QUOTA

/** 取得今天日期字符串（YYYY-MM-DD，使用本地时区） */
export function todayKey(date = new Date()): string {
  // 用本地时区切片，避免 UTC 切片把早 8 点的请求算到"昨天"
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * 检查 + 原子 +1：返回新的当日 count。
 * 若已达上限（>= limit）则抛 QuotaExceeded，由路由层转为 SSE error / HTTP 403。
 * 原子性：使用 INSERT OR IGNORE + UPDATE WHERE count<limit，保证并发请求不会绕过限额。
 */
export function consumeOrThrowQuota(
  db: Db,
  userId: number,
  limit: number = DEFAULT_DAILY_QUOTA,
  dateKey: string = todayKey(),
): number {
  // 先尝试插入 0 行（不存在则建档）
  const insert = db.prepare(
    `INSERT OR IGNORE INTO chat_usage(user_id, date, count) VALUES (?, ?, 0)`
  )
  insert.run(userId, dateKey)
  // 自增，但只接受 count<limit 的记录；超过则 changes=0
  const update = db.prepare(
    `UPDATE chat_usage SET count = count + 1
       WHERE user_id = ? AND date = ? AND count < ?`
  )
  const result = update.run(userId, dateKey, limit)
  if (result.changes === 0) {
    const row = db
      .prepare(`SELECT count FROM chat_usage WHERE user_id = ? AND date = ?`)
      .get(userId, dateKey) as { count: number } | undefined
    throw new QuotaExceeded(row?.count ?? limit, limit)
  }
  // 读出新值
  const row = db
    .prepare(`SELECT count FROM chat_usage WHERE user_id = ? AND date = ?`)
    .get(userId, dateKey) as { count: number }
  return row.count
}

/** 仅查询当日用量，不消耗；用于 GET /api/quota */
export function getTodayUsage(
  db: Db,
  userId: number,
  dateKey: string = todayKey(),
): number {
  const row = db
    .prepare(`SELECT count FROM chat_usage WHERE user_id = ? AND date = ?`)
    .get(userId, dateKey) as { count: number } | undefined
  return row?.count ?? 0
}

/** 配额超限错误类 */
export class QuotaExceeded extends Error {
  readonly current: number
  readonly limit: number
  constructor(current: number, limit: number = DEFAULT_DAILY_QUOTA) {
    super(`今日对话次数已用完（${current}/${limit}），请明天再来`)
    this.name = "QuotaExceeded"
    this.current = current
    this.limit = limit
  }
}