// 【文件说明】M5 真 API 接入工单测试：
//   1) PETIBI_DISABLE_QUOTA=1 时 /api/chat 连发 12 次不被拦；
//   2) 未设置 / =0 时 R4 红线仍生效（第 11 次被拒）；
//   3) 测试账号 test@petibi.local + 123456 走快速登录（dev 环境，免 email_codes）；
//   4) 同一邮箱用错误码登录仍按原有路径 400 报错；
//   5) prod 环境测试账号快速通道不生效（仍按普通邮箱处理）；
//   6) loadConfig 把 PETIBI_DISABLE_QUOTA / DEEPSEEK_* 正确读入；
//   7) isTestAccountFastPath 边界条件（大小写 / 空格 / 错误码）；
//   8) /api/quota 响应里 disabled 字段与 config.disableQuota 同步。
//
// 跑法：cd server && npx vitest run tests/env-quota.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import request from "supertest"
import type { Express } from "express"
import type { Server } from "node:http"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { signToken } from "../src/utils/jwt.js"
import {
  TEST_ACCOUNT_EMAIL,
  TEST_ACCOUNT_FIXED_CODE,
  isTestAccountFastPath,
} from "../src/routes/auth.js"
import type { Db } from "../src/db.js"
import type { ServerConfig } from "../src/config.js"
import type { Mailer } from "../src/mailer.js"

interface TestEnv {
  app: Express
  db: Db
  config: ServerConfig
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
    config,
    cleanup: () => {
      try {
        closeDb(db)
      } catch {
        // ignore
      }
    },
  }
}

/** 起一个真实监听 0 端口的 server，返回 baseUrl + token */
function startListenServer(env: TestEnv, email: string, mbti: string): Promise<{ baseUrl: string; server: Server; token: string }> {
  return new Promise((resolve) => {
    const insertInfo = env.db
      .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
      .run(email, "Tester", mbti, "stable")
    const userId = Number(insertInfo.lastInsertRowid)
    const token = signToken({ sub: String(userId), email }, env.config.jwtSecret, env.config.jwtExpiresInSec)
    const server = env.app.listen(0, () => {
      const addr = server.address() as { port: number }
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server, token })
    })
  })
}

/** 解析 SSE 流 */
function parseSse(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith(":")) continue
    const dataLines: string[] = []
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    try {
      events.push(JSON.parse(dataLines.join("\n")))
    } catch {
      // ignore
    }
  }
  return events
}

// ---------------- PETIBI_DISABLE_QUOTA 行为 ----------------

describe("PETIBI_DISABLE_QUOTA 开关", () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv({ dailyQuota: 3, disableQuota: true })
  })
  afterEach(() => env.cleanup())

  it("disableQuota=true：连发 12 次仍不被拦（agent 自动化测试场景）", async () => {
    const r = await startListenServer(env, "agent@petibi.local", "INTJ")
    let allOk = true
    for (let i = 0; i < 12; i++) {
      const resp = await fetch(`${r.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${r.token}` },
        body: JSON.stringify({ question: `帮我写代码 ${i}` }), // 走意图过滤命中路径，触发配额计数
      })
      const raw = await resp.text()
      const events = parseSse(raw)
      // 期望：要么 done 事件（命中意图过滤 + 配额未拦），要么有 guard/error 之外的正常流
      const errorEvent = events.find((e) => e.type === "error") as { message?: string } | undefined
      if (errorEvent?.message?.includes("今日对话次数已用完")) {
        allOk = false
        break
      }
    }
    expect(allOk).toBe(true)
    // 计数应当 == limit（dailyQuota=3；quota.ts 的 UPDATE 仅在 count<limit 时自增，
    // 故达到上限后停止增长，但前 3 次均已记入 chat_usage，验证 "计数照记" 要求）
    const quota = await fetch(`${r.baseUrl}/api/quota`, {
      headers: { Authorization: `Bearer ${r.token}` },
    })
    const body = (await quota.json()) as { used: number; limit: number; disabled?: boolean }
    expect(body.disabled).toBe(true)
    expect(body.used).toBe(body.limit)
    r.server.close()
  })

  it("disableQuota=true：GET /api/quota 返回 disabled=true", async () => {
    const r = await startListenServer(env, "agent@petibi.local", "INTJ")
    const resp = await fetch(`${r.baseUrl}/api/quota`, {
      headers: { Authorization: `Bearer ${r.token}` },
    })
    const body = (await resp.json()) as { used: number; limit: number; disabled?: boolean }
    expect(body.disabled).toBe(true)
    r.server.close()
  })
})

describe("PETIBI_DISABLE_QUOTA 未启用：R4 红线回归", () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv({ dailyQuota: 3, disableQuota: false })
  })
  afterEach(() => env.cleanup())

  it("第 4 次配额拒绝（保留 R4 红线）", async () => {
    const r = await startListenServer(env, "r4@example.com", "INTJ")
    // 跑满 3 次（每次都走意图过滤 + 配额路径）
    for (let i = 0; i < 3; i++) {
      await fetch(`${r.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${r.token}` },
        body: JSON.stringify({ question: `帮我写代码 ${i}` }),
      })
    }
    // 第 4 次：应收到 SSE error
    const resp = await fetch(`${r.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${r.token}` },
      body: JSON.stringify({ question: "帮我写代码 99" }),
    })
    const raw = await resp.text()
    const events = parseSse(raw)
    const err = events.find((e) => e.type === "error") as { message?: string } | undefined
    expect(err?.message).toContain("今日对话次数已用完")
    r.server.close()
  })
})

// ---------------- loadConfig 读 env ----------------

describe("loadConfig 读取 M5 新增 env", () => {
  it("未设 PETIBI_DISABLE_QUOTA → disableQuota=false", () => {
    const prev = process.env["PETIBI_DISABLE_QUOTA"]
    delete process.env["PETIBI_DISABLE_QUOTA"]
    const c = loadConfig({ env: "test", dbPath: ":memory:" })
    expect(c.disableQuota).toBe(false)
    if (prev !== undefined) process.env["PETIBI_DISABLE_QUOTA"] = prev
  })

  it("PETIBI_DISABLE_QUOTA=1 → disableQuota=true", () => {
    const prev = process.env["PETIBI_DISABLE_QUOTA"]
    process.env["PETIBI_DISABLE_QUOTA"] = "1"
    const c = loadConfig({ env: "test", dbPath: ":memory:" })
    expect(c.disableQuota).toBe(true)
    if (prev === undefined) delete process.env["PETIBI_DISABLE_QUOTA"]
    else process.env["PETIBI_DISABLE_QUOTA"] = prev
  })

  it("PETIBI_DISABLE_QUOTA=0 / 2 / 空串 → 仍视为关闭", () => {
    const cases = ["0", "2", "", "true"]
    for (const v of cases) {
      const prev = process.env["PETIBI_DISABLE_QUOTA"]
      process.env["PETIBI_DISABLE_QUOTA"] = v
      const c = loadConfig({ env: "test", dbPath: ":memory:" })
      expect(c.disableQuota).toBe(false)
      if (prev === undefined) delete process.env["PETIBI_DISABLE_QUOTA"]
      else process.env["PETIBI_DISABLE_QUOTA"] = prev
    }
  })

  it("DEEPSEEK_* 读入 LlmConfig", () => {
    const prev = {
      k: process.env["DEEPSEEK_API_KEY"],
      b: process.env["DEEPSEEK_BASE_URL"],
      m: process.env["DEEPSEEK_MODEL"],
      fm: process.env["FORCE_MOCK"],
    }
    process.env["DEEPSEEK_API_KEY"] = "sk-fake"
    process.env["DEEPSEEK_BASE_URL"] = "https://api.fake.deepseek.example"
    process.env["DEEPSEEK_MODEL"] = "deepseek-v3"
    process.env["FORCE_MOCK"] = "0"
    const c = loadConfig({ env: "test", dbPath: ":memory:" })
    expect(c.llm.apiKey).toBe("sk-fake")
    expect(c.llm.baseUrl).toBe("https://api.fake.deepseek.example")
    expect(c.llm.model).toBe("deepseek-v3")
    expect(c.llm.forceMock).toBe(false)
    // restore
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
})

// ---------------- 测试账号快速登录 ----------------

describe("isTestAccountFastPath 边界", () => {
  it("dev 环境：邮箱 + 固定码匹配 → true", () => {
    expect(isTestAccountFastPath(TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_FIXED_CODE, "dev")).toBe(true)
  })

  it("邮箱忽略大小写 + 前后空格", () => {
    expect(isTestAccountFastPath("  TEST@petibi.LOCAL  ", "123456", "dev")).toBe(true)
  })

  it("code 错 → false", () => {
    expect(isTestAccountFastPath(TEST_ACCOUNT_EMAIL, "000000", "dev")).toBe(false)
  })

  it("邮箱错 → false", () => {
    expect(isTestAccountFastPath("hacker@example.com", TEST_ACCOUNT_FIXED_CODE, "dev")).toBe(false)
  })

  it("prod 环境：即使邮箱 + code 都对 → false（prod 默认拒绝白名单滥用）", () => {
    expect(isTestAccountFastPath(TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_FIXED_CODE, "prod")).toBe(false)
  })

  it("email/code 非字符串 → false（防御 undefined）", () => {
    expect(isTestAccountFastPath(undefined, TEST_ACCOUNT_FIXED_CODE, "dev")).toBe(false)
    expect(isTestAccountFastPath(TEST_ACCOUNT_EMAIL, undefined, "dev")).toBe(false)
  })
})

describe("POST /api/auth/email/verify 测试账号快速通道（dev/test 环境）", () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.cleanup())

  it("test@petibi.local + 123456 直接登录成功（无需 /email/code）", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: TEST_ACCOUNT_EMAIL, code: TEST_ACCOUNT_FIXED_CODE })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.email).toBe(TEST_ACCOUNT_EMAIL)
    // users 表应有这一行
    const row = env.db.prepare("SELECT id, email FROM users WHERE email = ?").get(TEST_ACCOUNT_EMAIL)
    expect(row).toBeTruthy()
  })

  it("重复登录：返回同一 user id（不重复注册）", async () => {
    const a = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: TEST_ACCOUNT_EMAIL, code: TEST_ACCOUNT_FIXED_CODE })
    const b = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: TEST_ACCOUNT_EMAIL, code: TEST_ACCOUNT_FIXED_CODE })
    expect(a.body.user.id).toBe(b.body.user.id)
    const rows = env.db.prepare("SELECT id FROM users WHERE email = ?").all(TEST_ACCOUNT_EMAIL)
    expect(rows).toHaveLength(1)
  })

  it("测试账号快速通道不写 email_codes 表", async () => {
    await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: TEST_ACCOUNT_EMAIL, code: TEST_ACCOUNT_FIXED_CODE })
    const codes = env.db.prepare("SELECT * FROM email_codes WHERE email = ?").all(TEST_ACCOUNT_EMAIL)
    expect(codes).toHaveLength(0)
  })

  it("普通邮箱 + 错误 code → 仍走原 400 INVALID_CODE 路径（未误用测试通道）", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: "normal@example.com", code: "000000" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("INVALID_CODE")
  })

  it("测试邮箱 + 错误 code → 也走原 400 INVALID_CODE（不能因邮箱白名单就绕过 code 校验）", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: TEST_ACCOUNT_EMAIL, code: "000000" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("INVALID_CODE")
  })
})

describe("POST /api/auth/email/verify 测试账号快速通道（prod 环境被禁用）", () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv({ env: "prod" })
  })
  afterEach(() => env.cleanup())

  it("prod 环境：test@petibi.local + 123456 仍走 DB 校验，命中 400", async () => {
    const res = await request(env.app)
      .post("/api/auth/email/verify")
      .send({ email: TEST_ACCOUNT_EMAIL, code: TEST_ACCOUNT_FIXED_CODE })
    // email_codes 表里没有这条记录 → 400 INVALID_CODE（不走快速通道）
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("INVALID_CODE")
  })
})

// 让 Mailer 类型导入不报 unused（生产实现里有引用，这里仅占位防止 TS 误判）
void (null as unknown as Mailer)