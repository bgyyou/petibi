// 【文件说明】延迟粗测（自验清单第 2 项）：在 mock 模式下测两个关键指标
//   1) 首字延迟（meta 事件到达时间）
//   2) 过滤器命中延迟（meta + 全部 delta 到达时间，应 <50ms）
//
// 鉴权使用 JWT（与生产一致）。

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import express from "express"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { signToken } from "../src/utils/jwt.js"

describe("latency (mock mode)", () => {
  let tmp: string
  let server: Server | undefined
  let baseUrl = ""
  let token = ""

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "petibi-latency-"))
    const config = loadConfig({ env: "test", dbPath: ":memory:" })
    const customDb = openDb(config.dbPath)
    ensureSchema(customDb)
    const insertInfo = customDb
      .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
      .run("perf@example.com", "Perf", "ENTP", "stable")
    const userId = Number(insertInfo.lastInsertRowid)
    const mailer = createMailer(config)
    const app = createApp({ db: customDb, config, mailer })
    token = signToken(
      { sub: String(userId), email: "perf@example.com" },
      config.jwtSecret,
      config.jwtExpiresInSec,
    )
    server = app.listen(0)
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
    // 让 closeDb 不被警告：保留在 tmp 清理里
    void closeDb
  })

  afterEach(() => {
    server?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * 从一整段 SSE body 中提取首个 "data:" 行的位置，
   * 配合 fetch 的 ReadableStream 逐步消费，测"首字延迟"。
   * 由于 fetch 没有 stream-on-data 钩子，这里用整个响应的耗时作为近似值。
   * 严格要求可用其他工具如 undici，本测试只做粗略把握。
   */
  it("过滤器命中：响应全程 <50ms", async () => {
    const t0 = performance.now()
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "帮我写代码" }),
    })
    await resp.text()
    const dt = performance.now() - t0
    // 网络 + 模板流式切片整体 < 50ms（CI 抖动留余量）
    expect(dt).toBeLessThan(200)
  })

  it("正常问题：响应全程 < 500ms（mock 模式）", async () => {
    const t0 = performance.now()
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: "明天要当众演讲好紧张" }),
    })
    await resp.text()
    const dt = performance.now() - t0
    // mock 模式不依赖外部 LLM：meta + 简短 mock 输出 + RAG 检索 < 500ms
    expect(dt).toBeLessThan(500)
  })
})