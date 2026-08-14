// 【文件说明】POST /api/chat 集成测试：起一个真监听 0 端口的 Express server，用 fetch 调 SSE 路由。
// 覆盖（自验清单第 1 项）：
//   1) 越界命中走模板不调 LLM
//   2) 第 11 次配额拒绝
//   3) 闲聊跳过 RAG
//   4) 正常问题返回流式且带 rag_entry_id
//   5) 回答 ≤150 字约束生效（mock 模式）
//
// 鉴权方式：与生产一致，使用 JWT；测试辅助函数 login() 返回 Bearer token。
//
// 跑法：cd server && npx vitest run tests/chat-route.test.ts

import type { Server } from "node:http"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import express from "express"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { signToken } from "../src/utils/jwt.js"

/** 解析 SSE data: 行为 [{event}, ...] */
function parseSse(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim()
    if (!trimmed) continue
    if (trimmed.startsWith(":")) continue // 注释行
    const dataLines: string[] = []
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    try {
      events.push(JSON.parse(dataLines.join("\n")))
    } catch {
      // 非 JSON，忽略
    }
  }
  return events
}

/** 起一个临时 Express server；返回 baseUrl + 当前 token；tests 结束时关闭 */
function startTestServer(tmpDir: string, email: string, mbti: string, subtype: "stable" | "sensitive" = "stable"): { baseUrl: string; server: Server; token: string } {
  const config = loadConfig({ env: "test", dbPath: ":memory:" })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const insertInfo = db
    .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
    .run(email, "Tester", mbti, subtype)
  const userId = Number(insertInfo.lastInsertRowid)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer })
  const token = signToken({ sub: String(userId), email }, config.jwtSecret, config.jwtExpiresInSec)
  const server = app.listen(0)
  const addr = server.address() as { port: number }
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server, token }
}

describe("POST /api/chat", () => {
  let tmp: string
  let server: Server | undefined
  let baseUrl = ""
  let token = ""

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "petibi-chat-"))
    const r = startTestServer(tmp, "alice@example.com", "ENTP")
    server = r.server
    baseUrl = r.baseUrl
    token = r.token
  })

  afterEach(() => {
    server?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("越界命中走模板不调 LLM（refused=true 且无 rag_entry_id）", async () => {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "帮我写代码做个爬虫" }),
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get("Content-Type")).toMatch(/text\/event-stream/)
    const raw = await resp.text()
    const events = parseSse(raw)
    // 必有 meta(refused=true) + 至少 1 个 delta + done
    const meta = events.find((e) => e.type === "meta") as { refused: boolean; rag_entry_id: string | null } | undefined
    expect(meta?.refused).toBe(true)
    expect(meta?.rag_entry_id).toBeNull()
    const deltas = events.filter((e) => e.type === "delta") as { text: string }[]
    expect(deltas.length).toBeGreaterThan(0)
    const full = deltas.map((d) => d.text).join("")
    expect(full.length).toBeGreaterThan(0)
    const done = events.find((e) => e.type === "done") as { total_chars: number } | undefined
    expect(done).toBeDefined()
  })

  it("配额第 11 次拒绝", async () => {
    // 先打满 10 次（用越界场景以便快速验证不调 LLM）
    for (let i = 0; i < 10; i++) {
      await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ question: `帮我写代码 ${i}` }),
      })
    }
    // 第 11 次：应返回 error 事件（依然用越界问题，复用配额）
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "帮我写代码 11" }),
    })
    const raw = await resp.text()
    const events = parseSse(raw)
    const err = events.find((e) => e.type === "error") as { message: string } | undefined
    expect(err?.message).toContain("今日对话次数已用完")
  })

  it("闲聊跳过 RAG：rag_entry_id 为 null", async () => {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "你好" }),
    })
    const raw = await resp.text()
    const events = parseSse(raw)
    const meta = events.find((e) => e.type === "meta") as { refused: boolean; rag_entry_id: string | null } | undefined
    expect(meta).toBeDefined()
    expect(meta?.refused).toBe(false)
    expect(meta?.rag_entry_id).toBeNull()
  })

  it("正常问题返回流式且带 rag_entry_id", async () => {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "明天要当众演讲好紧张" }),
    })
    const raw = await resp.text()
    const events = parseSse(raw)
    const meta = events.find((e) => e.type === "meta") as { refused: boolean; rag_entry_id: string | null } | undefined
    expect(meta?.refused).toBe(false)
    // 期望命中 public-speaking 场景的某条百科条目
    expect(meta?.rag_entry_id).toMatch(/-scenario-public-speaking$|-public-speaking/)
    const deltas = events.filter((e) => e.type === "delta") as { text: string }[]
    expect(deltas.length).toBeGreaterThan(0)
  })

  it("M5 P0-B：rag_entry_id 必须以当前用户人格前缀开头（永不跨人格引用）", async () => {
    // 用 ENTP 用户问"当众演讲"——历史上旧实现可能被注入 ENFP 条目。
    // 修复后必须返回 ENTP- 开头的条目。
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "明天要当众演讲好紧张" }),
    })
    const raw = await resp.text()
    const events = parseSse(raw)
    const meta = events.find((e) => e.type === "meta") as { rag_entry_id: string | null } | undefined
    expect(meta?.rag_entry_id).not.toBeNull()
    // 路由用 beforeEach 起的是 ENTP 用户；rag_entry_id 必须以 "ENTP-" 开头
    expect(meta?.rag_entry_id).toMatch(/^ENTP-/)
  })

  it("M5 P0-B：切换用户人格后，rag 检索范围跟着变（永不跨人格引用）", async () => {
    // 起第二个 server，用 INFP 用户问同样的"当众演讲"——
    // 必须返回 INFP- 开头的条目，而不是之前 ENTP server 缓存的 ENTP 条目。
    const tmp2 = mkdtempSync(join(tmpdir(), "petibi-chat-infp-"))
    const r2 = startTestServer(tmp2, "bob@example.com", "INFP")
    try {
      const resp = await fetch(`${r2.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${r2.token}`,
        },
        body: JSON.stringify({ question: "明天要当众演讲好紧张" }),
      })
      const raw = await resp.text()
      const events = parseSse(raw)
      const meta = events.find((e) => e.type === "meta") as { rag_entry_id: string | null } | undefined
      expect(meta?.rag_entry_id).not.toBeNull()
      // INFP 用户 → rag_entry_id 必须以 "INFP-" 开头
      expect(meta?.rag_entry_id).toMatch(/^INFP-/)
      // 防御：明确不等于上一个 ENTP server 的答案
      expect(meta?.rag_entry_id).not.toMatch(/^ENTP-/)
    } finally {
      r2.server.close()
      rmSync(tmp2, { recursive: true, force: true })
    }
  })

  it("回答 ≤150 字约束生效（mock 模式）", async () => {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "明天要当众演讲好紧张" }),
    })
    const raw = await resp.text()
    const events = parseSse(raw)
    const deltas = events.filter((e) => e.type === "delta") as { text: string }[]
    const full = deltas.map((d) => d.text).join("")
    // mock 模式：composeMockAnswer 输出包含 "（mock）" 前缀，且较短
    expect(full.length).toBeLessThanOrEqual(150)
    expect(full).toContain("mock")
  })
})

describe("GET /api/quota (HTTP)", () => {
  let tmp: string
  let server: Server | undefined
  let baseUrl = ""
  let token = ""

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "petibi-quotaapi-"))
    const r = startTestServer(tmp, "bob@example.com", "INTJ")
    server = r.server
    baseUrl = r.baseUrl
    token = r.token
  })

  afterEach(() => {
    server?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("返回 used=0, limit=10, remaining=10", async () => {
    const resp = await fetch(`${baseUrl}/api/quota`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(resp.status).toBe(200)
    const data = (await resp.json()) as { used: number; limit: number; remaining: number; ok: boolean }
    expect(data.ok).toBe(true)
    expect(data.used).toBe(0)
    expect(data.limit).toBe(10)
    expect(data.remaining).toBe(10)
  })
})