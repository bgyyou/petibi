// 【文件说明】用户表访问层：从 users 表读 / 自动创建用户（合并自 M3 工单 B 套）
// 鉴权 JWT 校验已挪到 utils/jwt.ts + middleware.ts；本文件只剩 DB 层用户查询，
// 供 routes/chat.ts / routes/me.ts 等使用。

import type { Db } from "./db.js"
import type { Personality, Subtype, UserRow } from "./types.js"

/** 把 node:sqlite prepare().get(...) 的 unknown 结果断言成目标行类型 */
function asUserRow(value: unknown): UserRow | undefined {
  return value === undefined || value === null
    ? undefined
    : (value as UserRow)
}

/**
 * 通过 userId 查用户行；找不到返回 undefined（不抛错）。
 * 兼容旧库：自动给 pet_nickname / pet_nickname_changed_at 兜底为 null / 0，
 * 调用方拿到行后无需再判 undefined。
 */
export function findUserById(db: Db, userId: number): UserRow | undefined {
  const row = asUserRow(
    db
      .prepare(
        `SELECT id, email, nickname, mbti, subtype, created_at,
                pet_nickname, pet_nickname_changed_at
         FROM users WHERE id = ?`,
      )
      .get(userId),
  )
  if (row) {
    if (row.pet_nickname === undefined) row.pet_nickname = null
    if (row.pet_nickname_changed_at === undefined) row.pet_nickname_changed_at = 0
  }
  return row
}

/**
 * 通过 email 查用户行；找不到返回 undefined（不抛错）。
 */
export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  const row = asUserRow(
    db
      .prepare(
        `SELECT id, email, nickname, mbti, subtype, created_at,
                pet_nickname, pet_nickname_changed_at
         FROM users WHERE email = ?`,
      )
      .get(email),
  )
  if (row) {
    if (row.pet_nickname === undefined) row.pet_nickname = null
    if (row.pet_nickname_changed_at === undefined) row.pet_nickname_changed_at = 0
  }
  return row
}

/**
 * 通过 email 自动创建用户（已存在则直接返回）。
 * 副作用：DB 写入；幂等（同 email 多次调用只产生一行）。
 *
 * 注意：本项目当前不直接调用此函数（邮箱登录走 routes/auth.ts 显式 INSERT）；
 * 保留作为 chat 链路 "演示模式" 兜底，避免鉴权挡住聊天。
 */
export function getOrCreateUserByEmail(db: Db, email: string): UserRow {
  const existing = findUserByEmail(db, email)
  if (existing) return existing

  db.prepare(
    `INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`,
  ).run(email, null, null, null)
  const row = findUserByEmail(db, email)
  // 理论上一定能查到；若异常返回占位行（兜底）
  return row ?? {
    id: 0,
    email,
    nickname: null,
    mbti: null,
    subtype: null,
    created_at: new Date().toISOString(),
    pet_nickname: null,
    pet_nickname_changed_at: 0,
  }
}

/** 检查用户是否已初始化（mbti + subtype + nickname 都已设置） */
export function isProfileComplete(
  user: UserRow,
): user is UserRow & { mbti: Personality; subtype: Subtype } {
  return user.mbti !== null && user.subtype !== null && user.nickname !== null
}