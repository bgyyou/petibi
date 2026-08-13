// 【文件说明】后端鉴权 / 邮箱登录集成测试（合并自 M2 工单 __tests__/api.test.ts 鉴权部分 + 新增 JWT 链路）
// 覆盖：发码 / 校验 / 自动注册 / 写档 / quota HTTP 路由 / healthz / 404 / 鉴权失败
//
// 跑法：cd server && npx vitest run tests/auth.test.ts
// 与 chat-route.test.ts / quota.test.ts / intent-filter.test.ts 等并列存在，互不干扰。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import type { Express } from "express"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { ErrorCodes } from "../src/errors.js"
import type { Db } from "../src/db.js"
import type { ServerConfig } from "../src/config.js"
import type { Mailer } from "../src/mailer.js"

interface TestEnv {
  app: Express
  db: Db
  cleanup: () => void
}

function setupEnv(overrides: Partial<ServerConfig> = {}): TestEnv {
  const config = loadConfig({ env: "test", dbPath: ":memory:", ...overrides })
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
        // 忽略：in-memory 关闭失败不影响断言
      }
    },
  }
}

/** 工具：发码 → 拿 devCode → 登录，返回 token + userId */
async function registerAndLogin(
  app: Express,
  email = "alice@example.com",
): Promise<{ token: string; userId: number }> {
  const codeRes = await request(app).post("/api/auth/email/code").send({ email })
  expect(codeRes.status).toBe(200)
  expect(codeRes.body.ok).toBe(true)
  const devCode: string = codeRes.body.devCode
  expect(typeof devCode).toBe("string")
  expect(devCode).toMatch(/^\d{6}$/)

  const verifyRes = await request(app)
    .post("/api/auth/email/verify")
    .send({ email, code: devCode })
  expect(verifyRes.status).toBe(200)
  expect(verifyRes.body.ok).toBe(true)
  expect(verifyRes.body.token).toBeTruthy()
  return { token: verifyRes.body.token, userId: verifyRes.body.user.id }
}

describe("邮箱登录链路", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.cleanup())

  it("完整链路：发码 → 登录 → 拿 token → /api/me 拿到自己", async () => {
    const { token } = await registerAndLogin(env.app)
    const me = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me.status).toBe(200)
    expect(me.body.email).toBe("alice@example.com")
    expect(me.body.hasProfile).toBe(false)
    expect(me.body.mbti).toBeNull()
  })

  it("新用户自动注册：首次登录即创建 users 行", async () => {
    const { token } = await registerAndLogin(env.app, "bob@example.com")
    expect(token).toBeTruthy()
    const row = env.db.prepare("SELECT * FROM users WHERE email = ?").get("bob@example.com")
    expect(row).toBeTruthy()
  })

  it("已存在用户再次登录：返回同一个 user id（不重复注册）", async () => {
    const first = await registerAndLogin(env.app, "carol@example.com")
    const second = await registerAndLogin(env.app, "carol@example.com")
    expect(second.userId).toBe(first.userId)
    const rows = env.db.prepare("SELECT * FROM users WHERE email = ?").all("carol@example.com")
    expect(rows).toHaveLength(1)
  })

  it("/api/auth/email/code devCode 在非 prod 时回显", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/code")
      .send({ email: "devcode@example.com" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.expiresInSec).toBe(600)
    expect(res.body.devCode).toMatch(/^\d{6}$/)
  })
})

describe("邮箱验证码错误路径", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.cleanup())

  it("邮箱格式非法 → 400 INVALID_EMAIL", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/code")
      .send({ email: "not-an-email" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidEmail)
  })

  it("邮箱字段缺失 → 400 INVALID_EMAIL", async () => {
    const res = await request(env.app).post("/api/auth/email/code").send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidEmail)
  })

  it("验证码错误 → 400 INVALID_CODE", async () => {
    await request(env.app).post("/api/auth/email/code").send({ email: "dave@example.com" })
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "dave@example.com", code: "000000" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidCode)
  })

  it("验证码非 6 位 → 400 CODE_FORMAT_INVALID", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "dave@example.com", code: "abc" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.CodeFormatInvalid)
  })

  it("验证码过期 → 400 INVALID_CODE 且表中记录被清掉", async () => {
    // 用一个过期时间极短的 config 重启 env
    env.cleanup()
    env = setupEnv({ codeExpiresInSec: 1 })
    const codeRes = await request(env.app)
      .post("/api/auth/email/code")
      .send({ email: "expired@example.com" })
    const code: string = codeRes.body.devCode
    // 等到下一个整数秒之后验证码必过期
    await new Promise((r) => setTimeout(r, 1100))
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "expired@example.com", code })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidCode)
    // 过期路径会 DELETE 掉该记录
    const row = env.db
      .prepare("SELECT * FROM email_codes WHERE email = ?")
      .get("expired@example.com")
    expect(row).toBeUndefined()
  })

  it("验证码一次性：使用后立即失效（再 verify 同一码也失败）", async () => {
    const codeRes = await request(env.app)
      .post("/api/auth/email/code")
      .send({ email: "once@example.com" })
    const code: string = codeRes.body.devCode
    const first = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "once@example.com", code })
    expect(first.status).toBe(200)
    const second = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "once@example.com", code })
    expect(second.status).toBe(400)
    expect(second.body.error.code).toBe(ErrorCodes.InvalidCode)
  })

  it("Latest wins：再发一次码，旧的被覆盖（用旧码登录失败）", async () => {
    const c1 = await request(env.app)
      .post("/api/auth/email/code")
      .send({ email: "two@example.com" })
    const code1: string = c1.body.devCode
    const c2 = await request(env.app)
      .post("/api/auth/email/code")
      .send({ email: "two@example.com" })
    const code2: string = c2.body.devCode
    expect(code1).not.toBe(code2)

    const oldRes = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "two@example.com", code: code1 })
    expect(oldRes.status).toBe(400)
    expect(oldRes.body.error.code).toBe(ErrorCodes.InvalidCode)

    const newRes = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "two@example.com", code: code2 })
    expect(newRes.status).toBe(200)
  })
})

describe("鉴权与 /api/me", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.cleanup())

  it("无 token 访问 /api/me → 401", async () => {
    const res = await request(env.app).get("/api/me")
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })

  it("非法 token → 401", async () => {
    const res = await request(env.app)
      .get("/api/me")
      .set("Authorization", "Bearer not-a-jwt")
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })

  it("Authorization 缺失 Bearer 前缀 → 401", async () => {
    const res = await request(env.app).get("/api/me").set("Authorization", "Basic abc")
    expect(res.status).toBe(401)
  })

  it("鉴权后 /api/me 返回用户摘要", async () => {
    const { token } = await registerAndLogin(env.app, "who@example.com")
    const me = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me.status).toBe(200)
    expect(me.body.ok).toBe(true)
    expect(me.body.email).toBe("who@example.com")
  })
})

describe("写档 /api/me/profile", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.cleanup())

  it("happy path：写档后 /api/me 看到 mbti + subtype + hasProfile=true", async () => {
    const { token } = await registerAndLogin(env.app, "writer@example.com")
    const write = await request(env.app)
      .post("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "蝴蝶", mbti: "INFP", subtype: "sensitive" })
    expect(write.status).toBe(200)
    expect(write.body.mbti).toBe("INFP")
    expect(write.body.subtype).toBe("sensitive")
    expect(write.body.hasProfile).toBe(true)

    const me = await request(env.app).get("/api/me").set("Authorization", `Bearer ${token}`)
    expect(me.body.nickname).toBe("蝴蝶")
    expect(me.body.hasProfile).toBe(true)
  })

  it("MBTI 非 16 型 → 400 INVALID_PROFILE", async () => {
    const { token } = await registerAndLogin(env.app, "badmbti@example.com")
    const res = await request(env.app)
      .post("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "X", mbti: "XXXX", subtype: "stable" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidProfile)
  })

  it("subtype 非两档之一 → 400 INVALID_PROFILE", async () => {
    const { token } = await registerAndLogin(env.app, "badsub@example.com")
    const res = await request(env.app)
      .post("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "X", mbti: "INTJ", subtype: "xxxxx" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidProfile)
  })

  it("昵称为空 → 400", async () => {
    const { token } = await registerAndLogin(env.app, "nonick@example.com")
    const res = await request(env.app)
      .post("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "  ", mbti: "INTJ", subtype: "stable" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidProfile)
  })

  it("重复写档 → 409", async () => {
    const { token } = await registerAndLogin(env.app, "dup@example.com")
    const first = await request(env.app)
      .post("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "A", mbti: "INTJ", subtype: "stable" })
    expect(first.status).toBe(200)
    const second = await request(env.app)
      .post("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ nickname: "B", mbti: "INFP", subtype: "sensitive" })
    expect(second.status).toBe(409)
  })
})

describe("配额 HTTP /api/quota", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv({ dailyQuota: 3 }) })
  afterEach(() => env.cleanup())

  it("新用户未使用时 remaining = limit", async () => {
    const { token } = await registerAndLogin(env.app, "q1@example.com")
    const res = await request(env.app).get("/api/quota").set("Authorization", `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.limit).toBe(3)
    expect(res.body.used).toBe(0)
    expect(res.body.remaining).toBe(3)
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("直接读写库模拟已用 2 次后，remaining = 1", async () => {
    const { token, userId } = await registerAndLogin(env.app, "q2@example.com")
    const date = new Date().toISOString().slice(0, 10)
    env.db
      .prepare("INSERT INTO chat_usage (user_id, date, count) VALUES (?, ?, ?)")
      .run(userId, date, 2)
    const res = await request(env.app).get("/api/quota").set("Authorization", `Bearer ${token}`)
    expect(res.body.used).toBe(2)
    expect(res.body.remaining).toBe(1)
  })

  it("已用满 → remaining = 0，used = limit", async () => {
    const { token, userId } = await registerAndLogin(env.app, "q3@example.com")
    const date = new Date().toISOString().slice(0, 10)
    env.db
      .prepare("INSERT INTO chat_usage (user_id, date, count) VALUES (?, ?, ?)")
      .run(userId, date, 3)
    const res = await request(env.app).get("/api/quota").set("Authorization", `Bearer ${token}`)
    expect(res.body.used).toBe(3)
    expect(res.body.remaining).toBe(0)
  })

  it("/api/quota 未鉴权 → 401", async () => {
    const res = await request(env.app).get("/api/quota")
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })
})

describe("健康检查 & 404", () => {
  it("GET /healthz → 200 ok", async () => {
    const env = setupEnv()
    const res = await request(env.app).get("/healthz")
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    env.cleanup()
  })

  it("未知路径 → 404 NotFound", async () => {
    const env = setupEnv()
    const res = await request(env.app).get("/api/nope")
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe(ErrorCodes.NotFound)
    env.cleanup()
  })
})

describe("/api/chat 鉴权 + profile 完整性", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.cleanup())

  it("未鉴权访问 /api/chat → 401", async () => {
    const res = await request(env.app).post("/api/chat").send({ question: "hello" })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe(ErrorCodes.Unauthorized)
  })

  it("鉴权但未写档 → 409 InvalidProfile", async () => {
    const { token } = await registerAndLogin(env.app, "chat-incomplete@example.com")
    const res = await request(env.app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "你好" })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(ErrorCodes.InvalidProfile)
  })
})

// 防止 TypeScript 认为 Mailer 是 unused（构造时已注入；类型导入仅用于 setupEnv 签名）
void (null as unknown as Mailer)