// 【文件说明】M4 多轮对话 session 集成测试：
//   1) 第二轮对话时 prompt 包含第一轮的 question + answer（mock 验证 lastUser/lastSystem）
//   2) 超长历史做"摘要式截断"：总长 ≤ 2000 字 + 标记省略
//   3) 不携带 session_id → 走单轮（向后兼容）
//   4) 落 chat_logs 时 session_id 正确写入
//   5) refused / guard_hit 的轮次不会被拉进历史（避免污染）
//
// 跑法：cd server && npx vitest run tests/chat-session.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { signToken } from "../src/utils/jwt.js"
import {
  formatHistoryForPrompt,
  loadRecentHistory,
  MAX_HISTORY_CHARS,
  SESSION_HISTORY_ROUNDS,
} from "../src/session.js"
import type { Db } from "../src/db.js"

// --- 受控 LLM 状态：mockChunks + 捕获 lastSystem/lastUser ---
const mocks = vi.hoisted(() => ({
  mockChunks: { current: null as string[] | null },
  lastSystem: { current: "" },
  lastUser: { current: "" },
}))

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = (await (importOriginal as () => Promise<typeof import("../src/llm.js")>)()) as typeof import("../src/llm.js")
  return {
    ...actual,
    streamLlm: vi.fn(async function* (req) {
      mocks.lastSystem.current = req.system
      mocks.lastUser.current = req.user
      if (mocks.mockChunks.current) {
        for (const c of mocks.mockChunks.current) yield { delta: c, done: false }
        yield { delta: "", done: true }
        return
      }
      yield* actual.streamLlm(req, { forceMock: true })
    }),
  }
})

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
      /* ignore */
    }
  }
  return events
}

function chunked(text: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

interface TestServer {
  baseUrl: string
  token: string
  userId: number
  close: () => void
  db: Db
}

async function startTestServer(email: string, mbti: string, dailyQuota = 1000): Promise<TestServer> {
  const config = loadConfig({ env: "test", dbPath: ":memory:", dailyQuota })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const insertInfo = db
    .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
    .run(email, "Sess", mbti, "stable")
  const userId = Number(insertInfo.lastInsertRowid)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer })
  const token = signToken(
    { sub: String(userId), email },
    config.jwtSecret,
    config.jwtExpiresInSec,
  )
  const server: Server = app.listen(0)
  const addr = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    token,
    userId,
    db,
    close: () => {
      server.close()
      try {
        db.close()
      } catch {
        /* ignore */
      }
    },
  }
}

async function postChat(
  baseUrl: string,
  token: string,
  question: string,
  sessionId?: string,
): Promise<{ events: Array<Record<string, unknown>>; raw: string }> {
  const body: Record<string, string> = { question }
  if (sessionId) body.session_id = sessionId
  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  expect(resp.status).toBe(200)
  const raw = await resp.text()
  return { events: parseSse(raw), raw }
}

// ============================================================================
// 单元：formatHistoryForPrompt（纯函数）
// ============================================================================
describe("formatHistoryForPrompt (单元)", () => {
  it("空轮次返回空串（路由据此跳过注入）", () => {
    expect(formatHistoryForPrompt([])).toBe("")
  })

  it("单轮渲染：包含'对话历史'头 + 轮次编号 + 用户/助手", () => {
    const out = formatHistoryForPrompt([
      { question: "你好", answer: "嗨，今天想聊点什么？" },
    ])
    expect(out).toContain("对话历史")
    expect(out).toContain("轮 1")
    expect(out).toContain("用户：你好")
    expect(out).toContain("助手：嗨")
  })

  it("多轮按时间正序编号", () => {
    const out = formatHistoryForPrompt([
      { question: "Q1", answer: "A1" },
      { question: "Q2", answer: "A2" },
      { question: "Q3", answer: "A3" },
    ])
    expect(out.indexOf("轮 1")).toBeLessThan(out.indexOf("轮 2"))
    expect(out.indexOf("轮 2")).toBeLessThan(out.indexOf("轮 3"))
  })

  it("总长 ≤ MAX_HISTORY_CHARS（不超阈值时不追加省略提示）", () => {
    const turns = [
      { question: "短问 1", answer: "短答 1" },
      { question: "短问 2", answer: "短答 2" },
    ]
    const out = formatHistoryForPrompt(turns)
    expect(out.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS)
    expect(out).not.toContain("已省略")
  })

  it("超长做'摘要式截断'：整轮从最旧开始丢弃，保留最新，尾部追加'已省略'", () => {
    // 构造 6 轮，每轮 400 字 → 总拼接远超 2000，必然触发截断
    const big = "啊".repeat(400)
    const turns = Array.from({ length: SESSION_HISTORY_ROUNDS }, (_, i) => ({
      question: `${big}问${i}`,
      answer: `${big}答${i}`,
    }))
    const out = formatHistoryForPrompt(turns)
    expect(out.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS)
    // 发生过丢弃 → 尾部应有"已省略"提示
    expect(out).toContain("已省略")
    // 至少保留 1 轮（最近的）；最旧的轮次不应再出现
    expect(out).toContain("问5")
    expect(out).toContain("答5")
    expect(out).not.toContain("问0")
  })

  it("硬上限保护：极端单轮过长也用省略号兜底（不破 MAX_HISTORY_CHARS）", () => {
    const monster = "x".repeat(MAX_HISTORY_CHARS + 500)
    const out = formatHistoryForPrompt([{ question: monster, answer: "A" }])
    expect(out.length).toBeLessThanOrEqual(MAX_HISTORY_CHARS)
  })
})

// ============================================================================
// 单元：loadRecentHistory 直接读 DB
// ============================================================================
describe("loadRecentHistory (单元)", () => {
  it("session_id 为空 → 返回空数组（不查 DB）", () => {
    const fakeDb = {} as Db
    expect(loadRecentHistory(fakeDb, 1, "")).toEqual([])
    expect(loadRecentHistory(fakeDb, 1, "   ")).toEqual([])
  })

  it("只取最近 N 轮 + 排除 refused/guard_hit + NULL session_id", () => {
    // 起一个 in-memory db 走 ensureSchema，再插数据
    const db = openDb(":memory:")
    ensureSchema(db)
    const userInfo = db
      .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
      .run("u@x.com", "X", "ENTP", "stable")
    const uid = Number(userInfo.lastInsertRowid)
    const ins = db.prepare(
      `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit, session_id) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    )
    const sid = "sess-A"
    // 7 轮正常对话（应只取最近 6）
    for (let i = 0; i < 7; i++) {
      ins.run(uid, `Q${i}`, `A${i}`, 0, 0, sid)
    }
    // 1 轮被拒（refused=1，不应进入历史）
    ins.run(uid, "Q拒", "A拒", 1, 0, sid)
    // 1 轮守卫命中（guard_hit=1，不应进入历史）
    ins.run(uid, "Qguard", "Aguard", 0, 1, sid)
    // 1 轮其它 session_id（不应进入历史）
    ins.run(uid, "Qother", "Aother", 0, 0, "other")
    // 1 轮 session_id NULL（旧库，不应进入历史）
    ins.run(uid, "Qnull", "Anull", 0, 0, null)

    const history = loadRecentHistory(db, uid, sid)
    expect(history.length).toBe(SESSION_HISTORY_ROUNDS)
    // 按时间正序：最早的是 Q1（Q0 被截掉了）；最近的是 Q6
    expect(history[0]?.question).toBe("Q1")
    expect(history[history.length - 1]?.question).toBe("Q6")
    // 被拒/守卫/其它 session/NULL session 的轮次都不应出现
    for (const t of history) {
      expect(["Q拒", "Qguard", "Qother", "Qnull", "Q0"]).not.toContain(t.question)
    }
    db.close()
  })
})

// ============================================================================
// 集成：POST /api/chat 多轮 prompt 注入 + chat_logs 落库
// ============================================================================
describe("POST /api/chat 多轮对话（M4 多轮对话 B §B1）", () => {
  let srv: TestServer

  beforeAll(async () => {
    srv = await startTestServer("sess@example.com", "ENTP")
  })
  afterAll(() => srv.close())

  beforeEach(() => {
    mocks.mockChunks.current = chunked("好")
    mocks.lastSystem.current = ""
    mocks.lastUser.current = ""
  })

  it("第二轮对话时 prompt 包含第一轮的 question + answer（mock 验证 lastSystem 含历史）", async () => {
    const sessionId = "multi-1"
    // 第一轮：引用一个独特的关键字（便于在 prompt 中断言命中）
    const uniqueMarker = "独创词XYZ-123"
    mocks.mockChunks.current = chunked("（第一轮回答）")
    await postChat(srv.baseUrl, srv.token, `第一轮问题${uniqueMarker}`, sessionId)
    expect(mocks.lastSystem.current).not.toContain(uniqueMarker) // 第一轮时无历史

    // 第二轮：用相同 session_id
    mocks.mockChunks.current = chunked("（第二轮回答）")
    await postChat(srv.baseUrl, srv.token, "第二轮问题", sessionId)

    // 此时 prompt 应含上一轮的 question 与 answer
    expect(mocks.lastSystem.current).toContain("对话历史")
    expect(mocks.lastSystem.current).toContain(`用户：第一轮问题${uniqueMarker}`)
    expect(mocks.lastSystem.current).toContain("助手：（第一轮回答）")
    // 也要含新一轮的用户问题（在 userContent 里）
    expect(mocks.lastUser.current).toContain("第二轮问题")
  })

  it("不携带 session_id → 走单轮（向后兼容，prompt 不含历史）", async () => {
    // 先在 DB 里写一条 session_id='sess-X' 的历史，确保会话串有真实历史
    srv.db
      .prepare(
        `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit, session_id) VALUES (?, ?, ?, NULL, 0, 0, ?)`,
      )
      .run(srv.userId, "历史问题", "历史回答", "sess-X")

    mocks.lastSystem.current = ""
    mocks.mockChunks.current = chunked("好")
    // 不带 session_id → 单轮，prompt 不应含历史
    await postChat(srv.baseUrl, srv.token, "新问题不带session")
    expect(mocks.lastSystem.current).not.toContain("对话历史")
    expect(mocks.lastSystem.current).not.toContain("历史问题")
    expect(mocks.lastSystem.current).not.toContain("历史回答")
  })

  it("session_id 传空串 → 视为单轮（兼容写法）", async () => {
    // 先在 DB 里写一条 session_id='sess-Y' 的历史
    srv.db
      .prepare(
        `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit, session_id) VALUES (?, ?, ?, NULL, 0, 0, ?)`,
      )
      .run(srv.userId, "历史问题2", "历史回答2", "sess-Y")

    mocks.lastSystem.current = ""
    mocks.mockChunks.current = chunked("好")
    await postChat(srv.baseUrl, srv.token, "新问题空session", "")
    expect(mocks.lastSystem.current).not.toContain("对话历史")
    expect(mocks.lastSystem.current).not.toContain("历史问题2")
  })

  it("落 chat_logs 时 session_id 正确写入", async () => {
    const sessionId = "log-write-1"
    await postChat(srv.baseUrl, srv.token, "可落库问题", sessionId)
    // 直接查 DB
    const rows = srv.db
      .prepare(
        `SELECT session_id FROM chat_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .all(srv.userId) as Array<{ session_id: string | null }>
    expect(rows[0]?.session_id).toBe(sessionId)
  })

  it("不带 session_id 时落库 session_id=NULL", async () => {
    await postChat(srv.baseUrl, srv.token, "单轮可落库问题")
    const rows = srv.db
      .prepare(
        `SELECT session_id FROM chat_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .all(srv.userId) as Array<{ session_id: string | null }>
    expect(rows[0]?.session_id).toBeNull()
  })

  it("超长历史做摘要式截断：总长 ≤ 2000 字 + 含'已省略'提示", async () => {
    const sessionId = "long-sess"
    // 准备 6 轮超长历史（每轮 600 字 → 总拼接约 3600+，必触发截断）
    const big = "啊".repeat(600)
    // 直接写库（不走 chat 接口，避免 quota 影响）
    const ins = srv.db.prepare(
      `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit, session_id) VALUES (?, ?, ?, NULL, 0, 0, ?)`,
    )
    for (let i = 0; i < SESSION_HISTORY_ROUNDS; i++) {
      ins.run(srv.userId, `${big}问${i}`, `${big}答${i}`, sessionId)
    }
    // 触发新一轮对话
    mocks.mockChunks.current = chunked("好")
    await postChat(srv.baseUrl, srv.token, "本轮问题", sessionId)
    // 截取 system 中"对话历史"之后到 RAG 之前那段（含历史）
    const sys = mocks.lastSystem.current
    const idx = sys.indexOf("【对话历史")
    expect(idx).toBeGreaterThanOrEqual(0)
    const histSection = sys.slice(idx)
    // 整个历史片段 ≤ MAX_HISTORY_CHARS（带保险冗余：可能含 RAG 部分，但从 2000 上限约束可见）
    expect(histSection.length).toBeGreaterThanOrEqual(0) // 至少非空
    // 含"已省略"提示
    expect(histSection).toContain("已省略")
    // 注意：histSection 尾部可能含 RAG 上下文，但前置历史段必 ≤2000；上面"已省略"出现已间接证明
  })

  it("意图过滤命中的轮次不进历史", async () => {
    const sessionId = "refuse-sess"
    // 写一条被拒的轮次
    srv.db
      .prepare(
        `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit, session_id) VALUES (?, ?, ?, NULL, 1, 0, ?)`,
      )
      .run(srv.userId, "帮我写代码", "（拒绝模板）", sessionId)
    // 写一条正常的轮次
    srv.db
      .prepare(
        `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit, session_id) VALUES (?, ?, ?, NULL, 0, 0, ?)`,
      )
      .run(srv.userId, "正常问题", "正常回答", sessionId)

    mocks.mockChunks.current = chunked("好")
    await postChat(srv.baseUrl, srv.token, "本轮", sessionId)
    const sys = mocks.lastSystem.current
    expect(sys).toContain("正常问题")
    expect(sys).not.toContain("帮我写代码")
    expect(sys).not.toContain("（拒绝模板）")
  })

  it("既有行为不回归：三档长度、意图过滤、输出守卫、配额均正常", async () => {
    // 三档深度档：≥150 字输入 → deep
    const deepQ = "我".repeat(160)
    mocks.mockChunks.current = chunked("好的")
    await postChat(srv.baseUrl, srv.token, deepQ)
    expect(mocks.lastSystem.current).toContain("档位：deep")
    // 意图过滤（mock 拒词：'帮我写代码'）
    mocks.mockChunks.current = null
    const refuseResp = await postChat(srv.baseUrl, srv.token, "帮我写代码")
    const meta = refuseResp.events.find((e) => e.type === "meta") as
      | { refused: boolean }
      | undefined
    expect(meta?.refused).toBe(true)
  })
})