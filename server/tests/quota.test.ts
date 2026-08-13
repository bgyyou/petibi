// 【文件说明】配额模块测试：第 11 次请求应抛 QuotaExceeded
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureSchema, getDb, openDb, closeDb } from "../src/db.js"
import {
  consumeOrThrowQuota,
  DAILY_QUOTA,
  getTodayUsage,
  QuotaExceeded,
} from "../src/quota.js"

describe("quota", () => {
  let tmp: string
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "petibi-quota-"))
    db = openDb(join(tmp, "test.db"))
    ensureSchema(db)
    // 准备一个测试用户
    db.prepare(`INSERT INTO users(email) VALUES (?)`).run("test@example.com")
  })

  afterEach(() => {
    closeDb(db)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("前 10 次应成功，第 11 次抛 QuotaExceeded", () => {
    // 通过查询获取用户 id
    const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get("test@example.com") as { id: number }
    for (let i = 1; i <= DAILY_QUOTA; i++) {
      const count = consumeOrThrowQuota(db, user.id)
      expect(count).toBe(i)
    }
    expect(() => consumeOrThrowQuota(db, user.id)).toThrowError(QuotaExceeded)
  })

  it("getTodayUsage 默认 0；消耗后递增", () => {
    const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get("test@example.com") as { id: number }
    expect(getTodayUsage(db, user.id)).toBe(0)
    consumeOrThrowQuota(db, user.id)
    expect(getTodayUsage(db, user.id)).toBe(1)
  })

  it("不同日期互不影响", () => {
    const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get("test@example.com") as { id: number }
    consumeOrThrowQuota(db, user.id, DAILY_QUOTA, "2026-08-13")
    consumeOrThrowQuota(db, user.id, DAILY_QUOTA, "2026-08-13")
    // 换一个日期应该从头开始
    expect(getTodayUsage(db, user.id, "2026-08-14")).toBe(0)
    expect(getTodayUsage(db, user.id, "2026-08-13")).toBe(2)
  })

  it("getDb 在测试环境中也可用（DB 单例）", () => {
    // 仅做烟雾测试：不期望与本次测试一致的状态，仅验证不抛错
    expect(() => getDb()).not.toThrow()
  })
})