// 【文件说明】延迟基准小工具：起一个 mock 模式 server，连续跑两类场景测耗时
// 用途：自验清单第 2 项"延迟粗测（mock 模式）：首字延迟、过滤器命中延迟（应 <50ms）"。

import express from "express"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema, closeDb } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { signToken } from "../src/utils/jwt.js"

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "petibi-bench-"))
  const config = loadConfig({ env: "test", dbPath: join(tmp, "bench.db") })
  const customDb = openDb(config.dbPath)
  ensureSchema(customDb)
  const insertInfo = customDb
    .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
    .run("bench@example.com", "Bench", "ENTP", "stable")
  const userId = Number(insertInfo.lastInsertRowid)
  const token = signToken(
    { sub: String(userId), email: "bench@example.com" },
    config.jwtSecret,
    config.jwtExpiresInSec,
  )

  const mailer = createMailer(config)
  const app = createApp({ db: customDb, config, mailer })
  const server = app.listen(0)
  const addr = server.address() as { port: number }
  const baseUrl = `http://127.0.0.1:${addr.port}`

  const measure = async (label: string, question: string): Promise<{ label: string; totalMs: number; firstByteMs: number }> => {
    const t0 = performance.now()
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question }),
    })
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let firstByteMs = 0
    let buf = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (firstByteMs === 0) firstByteMs = performance.now() - t0
      buf += decoder.decode(value, { stream: true })
    }
    const totalMs = performance.now() - t0
    return { label, totalMs, firstByteMs }
  }

  console.log("=== latency benchmark (mock mode, 10 warmups + 30 samples each) ===")
  const cases = [
    { label: "过滤器命中（写代码）", question: "帮我写代码" },
    { label: "正常问题（演讲）", question: "明天要当众演讲好紧张" },
    { label: "闲聊（你好）", question: "你好" },
  ]
  for (const c of cases) {
    // warmup
    for (let i = 0; i < 10; i++) await measure(c.label, c.question)
    const samples: { totalMs: number; firstByteMs: number }[] = []
    for (let i = 0; i < 30; i++) samples.push(await measure(c.label, c.question))
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const max = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0)
    const sorted = [...samples].map((s) => s.totalMs).sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!
    console.log(`${c.label}:`)
    console.log(`  avg total = ${avg(samples.map((s) => s.totalMs)).toFixed(1)}ms, max = ${max(samples.map((s) => s.totalMs)).toFixed(1)}ms, p95 = ${p95.toFixed(1)}ms`)
    console.log(`  avg firstByte = ${avg(samples.map((s) => s.firstByteMs)).toFixed(1)}ms, max = ${max(samples.map((s) => s.firstByteMs)).toFixed(1)}ms`)
  }

  server.close()
  closeDb(customDb)
  rmSync(tmp, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})