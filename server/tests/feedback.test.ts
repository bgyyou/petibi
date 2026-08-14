// 【文件说明】测评反馈路由测试（M4 反馈路由补齐工单）：POST /api/me/feedback。
//
// 背景：owner 实测「很符合 / 测的不准」点了报 404——前端一直在调这个接口，server 没实现。
// 反馈是题库迭代的唯一真实数据源（PRD §3.3），本测试钉死契约：
//   1. 鉴权：无 token → 401；
//   2. 正例：accepted=true / false 都落 test_feedback，返回 recorded_at；
//   3. 落库字段正确：mbti / subtype / accepted(0|1) / comment，且能重复反馈（不 UNIQUE）；
//   4. 参数校验：accepted 非布尔 / mbti 非 16 型 / subtype 非法 / comment 超 200 字 → 400 INVALID_FEEDBACK；
//   5. 反馈接口只写库，不动 users 表（用户反馈完可能不点「完成」，人格不该被它改掉）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import type { Express } from "express"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { ErrorCodes } from "../src/errors.js"
import type { Db } from "../src/db.js"

interface TestEnv {
  app: Express
  db: Db
  cleanup: () => void
}

function setupEnv(): TestEnv {
  const config = loadConfig({ env: "test", dbPath: ":memory:" })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer })
  return {
    app,
    db,
    cleanup: () => {
      try {
        closeDb(db)
      } catch {
        /* ignore */
      }
    },
  }
}

/** 注册并写档，返回 token + userId（写档让 users 行的 mbti 有初值，便于断言"反馈不改档"） */
async function registerAndProfile(app: Express, email: string): Promise<{ token: string; userId: number }> {
  const codeRes = await request(app).post("/api/auth/email/code").send({ email })
  const devCode: string = codeRes.body.devCode
  const verifyRes = await request(app).post("/api/auth/email/verify").send({ email, code: devCode })
  const token: string = verifyRes.body.token
  const userId: number = verifyRes.body.user.id
  await request(app)
    .post("/api/me/profile")
    .set("Authorization", `Bearer ${token}`)
    .send({ nickname: "阿狐", mbti: "ENTP", subtype: "stable" })
  return { token, userId }
}

/** 读某用户的全部反馈行（按时间序） */
function readFeedbackRows(db: Db, userId: number): Array<{
  mbti: string
  subtype: string
  accepted: number
  comment: string | null
  created_at: string
}> {
  return db
    .prepare(
      `SELECT mbti, subtype, accepted, comment, created_at
         FROM test_feedback WHERE user_id = ? ORDER BY id ASC`,
    )
    .all(userId) as unknown as Array<{
    mbti: string
    subtype: string
    accepted: number
    comment: string | null
    created_at: string
  }>
}

describe("测评反馈 POST /api/me/feedback", () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv()
  })
  afterEach(() => {
    env.cleanup()
  })

  it("路由存在且鉴权生效：不带 token → 401（不是 404）", async () => {
    const res = await request(env.app)
      .post("/api/me/feedback")
      .send({ mbti: "ENTP", subtype: "stable", accepted: true })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })

  it("「很符合」：accepted=true 落库，返回 recorded_at", async () => {
    const { token, userId } = await registerAndProfile(env.app, "yes@example.com")
    const res = await request(env.app)
      .post("/api/me/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ mbti: "ENTP", subtype: "stable", accepted: true })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.recorded_at).toBe("string")
    expect(res.body.recorded_at.length).toBeGreaterThan(0)

    const rows = readFeedbackRows(env.db, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].mbti).toBe("ENTP")
    expect(rows[0].subtype).toBe("stable")
    expect(rows[0].accepted).toBe(1)
    expect(rows[0].comment).toBeNull()
  })

  it("「测的不准」：accepted=false + comment 一并落库", async () => {
    const { token, userId } = await registerAndProfile(env.app, "no@example.com")
    const res = await request(env.app)
      .post("/api/me/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ mbti: "INFP", subtype: "sensitive", accepted: false, comment: "第 3 题选项都不像我" })

    expect(res.status).toBe(200)
    const rows = readFeedbackRows(env.db, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].mbti).toBe("INFP")
    expect(rows[0].subtype).toBe("sensitive")
    expect(rows[0].accepted).toBe(0)
    expect(rows[0].comment).toBe("第 3 题选项都不像我")
  })

  it("同一用户可多次反馈（多轮测评全部留痕，不做 UNIQUE 覆盖）", async () => {
    const { token, userId } = await registerAndProfile(env.app, "multi@example.com")
    for (const [mbti, accepted] of [["ENTP", true], ["INTJ", false], ["ENTP", false]] as const) {
      const res = await request(env.app)
        .post("/api/me/feedback")
        .set("Authorization", `Bearer ${token}`)
        .send({ mbti, subtype: "stable", accepted })
      expect(res.status).toBe(200)
    }
    const rows = readFeedbackRows(env.db, userId)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.mbti)).toEqual(["ENTP", "INTJ", "ENTP"])
    expect(rows.map((r) => r.accepted)).toEqual([1, 0, 0])
  })

  it("mbti 小写也接受，落库统一存大写（前端可能直接传 state 里的原值）", async () => {
    const { token, userId } = await registerAndProfile(env.app, "lower@example.com")
    const res = await request(env.app)
      .post("/api/me/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ mbti: "entp", subtype: "stable", accepted: true })
    expect(res.status).toBe(200)
    expect(readFeedbackRows(env.db, userId)[0].mbti).toBe("ENTP")
  })

  it("参数非法一律 400 INVALID_FEEDBACK，且不落库", async () => {
    const { token, userId } = await registerAndProfile(env.app, "bad@example.com")
    const badBodies: Array<Record<string, unknown>> = [
      { mbti: "ENTP", subtype: "stable" }, // accepted 缺失
      { mbti: "ENTP", subtype: "stable", accepted: "true" }, // accepted 非布尔
      { mbti: "XXXX", subtype: "stable", accepted: true }, // mbti 非 16 型
      { subtype: "stable", accepted: true }, // mbti 缺失
      { mbti: "ENTP", subtype: "unknown", accepted: true }, // subtype 非法
      { mbti: "ENTP", subtype: "stable", accepted: true, comment: "凑".repeat(201) }, // comment 超长
      { mbti: "ENTP", subtype: "stable", accepted: true, comment: 42 }, // comment 类型错
    ]
    for (const body of badBodies) {
      const res = await request(env.app)
        .post("/api/me/feedback")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe(ErrorCodes.InvalidFeedback)
    }
    expect(readFeedbackRows(env.db, userId)).toHaveLength(0)
  })

  it("comment 边界：恰好 200 字通过；纯空白按未填处理存 NULL", async () => {
    const { token, userId } = await registerAndProfile(env.app, "edge@example.com")
    const ok200 = await request(env.app)
      .post("/api/me/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ mbti: "ENTP", subtype: "stable", accepted: false, comment: "凑".repeat(200) })
    expect(ok200.status).toBe(200)

    const blank = await request(env.app)
      .post("/api/me/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ mbti: "ENTP", subtype: "stable", accepted: false, comment: "   " })
    expect(blank.status).toBe(200)

    const rows = readFeedbackRows(env.db, userId)
    expect(rows[0].comment).toHaveLength(200)
    expect(rows[1].comment).toBeNull()
  })

  it("反馈不修改 users 表人格（用户可能反馈完不点「完成」）", async () => {
    const { token, userId } = await registerAndProfile(env.app, "keep@example.com")
    await request(env.app)
      .post("/api/me/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ mbti: "ISFJ", subtype: "sensitive", accepted: false })

    const user = env.db
      .prepare("SELECT mbti, subtype FROM users WHERE id = ?")
      .get(userId) as { mbti: string; subtype: string }
    expect(user.mbti).toBe("ENTP")
    expect(user.subtype).toBe("stable")
  })
})
