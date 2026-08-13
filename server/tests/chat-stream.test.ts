// 【文件说明】M3 流式守卫与三档工单集成测试：
//   1) meta 事件在第一个 delta 之前到达（恢复 0.3s 思考动画）
//   2) 增量守卫中途掐断三种命中（code_block / break_character / too_long）
//   3) 三档字数上限各自生效：闲聊 ≤80 / 标准 ≤150 / 深度 ≤400（超过档位上限追加 "……"）
//   4) 深度档 system prompt 拼接了档位指令（含"复述"段）
//
// 用 vi.mock 注入受控 streamLlm：可控 chunks + 捕获传给 LLM 的 system/user。
// 跑法：cd server && npx vitest run tests/chat-stream.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import { createApp } from "../src/app.js"
import { openDb, ensureSchema } from "../src/db.js"
import { createMailer } from "../src/mailer.js"
import { loadConfig } from "../src/config.js"
import { signToken } from "../src/utils/jwt.js"
import {
  TIER_MAX_CHARS,
  TIER_MAX_TOKENS,
  applyOutputGuard,
  createStreamGuard,
  decideReplyTier,
  hardLimitFor,
} from "../src/output-guard.js"
import { buildTierInstruction } from "../src/personas.js"
import { loadIntentFilter } from "../src/intent-filter.js"

// --- 受控 LLM 状态：mockChunks 提供按 delta 推送的字符串数组；lastSystem/lastUser 捕获 prompt ---
const mocks = vi.hoisted(() => ({
  mockChunks: { current: null as string[] | null },
  lastSystem: { current: "" },
  lastUser: { current: "" },
  lastMaxTokens: { current: 0 as number },
}))

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = (await (importOriginal as () => Promise<typeof import("../src/llm.js")>)()) as typeof import("../src/llm.js")
  return {
    ...actual,
    streamLlm: vi.fn(async function* (req, options) {
      mocks.lastSystem.current = req.system
      mocks.lastUser.current = req.user
      mocks.lastMaxTokens.current = req.maxTokens ?? 0
      if (mocks.mockChunks.current) {
        for (const c of mocks.mockChunks.current) {
          yield { delta: c, done: false }
        }
        yield { delta: "", done: true }
        return
      }
      // 未注入 chunks：走真实 mock（按问题长度 + 关键词返回固定文案）
      yield* actual.streamLlm(req, { ...(options ?? {}), forceMock: true })
    }),
  }
})

// --- SSE 解析工具：返回 [{...}, ...] 事件列表（兼容单文件多 data: 行） ---
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
      // 忽略非 JSON 行
    }
  }
  return events
}

/** 把一段文本按 ~3 字/片段切成 LLM 风格 delta 数组（模拟真实 LLM 推送节奏） */
function chunked(text: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** 起一个临时 Express server，注入受控 LLM；返回 baseUrl + token + 清理函数 */
async function startTestServer(email: string, mbti: string, dailyQuota = 1000): Promise<{
  baseUrl: string; token: string; close: () => void
}> {
  const config = loadConfig({ env: "test", dbPath: ":memory:", dailyQuota })
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const insertInfo = db
    .prepare(`INSERT INTO users(email, nickname, mbti, subtype) VALUES (?, ?, ?, ?)`)
    .run(email, "Stream", mbti, "stable")
  const userId = Number(insertInfo.lastInsertRowid)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer })
  const token = signToken(
    { sub: String(userId), email },
    config.jwtSecret,
    config.jwtExpiresInSec,
  )
  const server = app.listen(0)
  const addr = server.address() as { port: number }
  const baseUrl = `http://127.0.0.1:${addr.port}`
  return {
    baseUrl,
    token,
    close: () => {
      server.close()
      try { db.close() } catch { /* ignore */ }
    },
  }
}

async function postChat(
  baseUrl: string, token: string, question: string,
): Promise<{ events: Array<Record<string, unknown>>; raw: string }> {
  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question }),
  })
  expect(resp.status).toBe(200)
  const raw = await resp.text()
  return { events: parseSse(raw), raw }
}

describe("chat 流式 + meta 立即发（M3 流式守卫与三档工单）", () => {
  let srv: Awaited<ReturnType<typeof startTestServer>>

  beforeAll(async () => {
    srv = await startTestServer("stream@example.com", "ENTP")
  })
  afterAll(() => srv.close())

  beforeEach(() => {
    mocks.mockChunks.current = null
    mocks.lastSystem.current = ""
    mocks.lastUser.current = ""
    mocks.lastMaxTokens.current = 0
  })
  afterEach(() => {
    mocks.mockChunks.current = null
  })

  it("meta 事件在第一个 delta 之前到达", async () => {
    mocks.mockChunks.current = chunked("（mock）深呼吸三次再开口。")
    const { events } = await postChat(srv.baseUrl, srv.token, "明天演讲好紧张")
    // 第一个事件必须是 meta（前置检查通过后立即发，不等 LLM）
    expect(events[0]?.type).toBe("meta")
    const meta = events[0] as { rag_entry_id: string | null; refused: boolean; guard_hit: boolean }
    expect(meta.refused).toBe(false)
    expect(meta.guard_hit).toBe(false)
    expect(meta.rag_entry_id).toMatch(/-scenario-public-speaking$|-public-speaking/)
    // 后续事件：delta + done，meta 一定在最前
    const restTypes = events.slice(1).map((e) => e.type)
    expect(restTypes[0]).toBe("delta")
    expect(restTypes[restTypes.length - 1]).toBe("done")
  })

  it("增量守卫：code_block 命中后立即发 guard 事件", async () => {
    // 包含 ```python 的长文本，按 3 字切片模拟 LLM 推送
    mocks.mockChunks.current = chunked("看个例子就懂了：\n```python\ndef foo():\n  return 1\n```")
    const { events } = await postChat(srv.baseUrl, srv.token, "今天上班累吗")
    const meta = events.find((e) => e.type === "meta") as
      | { guard_hit: boolean } | undefined
    const guard = events.find((e) => e.type === "guard") as
      | { reason: string; text: string } | undefined
    const done = events.find((e) => e.type === "done") as
      | { guard_hit: boolean; total_chars: number } | undefined
    expect(meta).toBeDefined()
    // meta 立即发，guard_hit 仍为 false
    expect(meta!.guard_hit).toBe(false)
    // 守卫命中必须有 guard 事件
    expect(guard).toBeDefined()
    expect(guard!.reason).toBe("code_block")
    expect(guard!.text.length).toBeGreaterThan(0)
    // done 事件反映最终 guard_hit=true
    expect(done?.guard_hit).toBe(true)
    // 前端拿到的 delta 集合不应包含 LLM 原文（被截断）
    const deltaText = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")
    expect(deltaText.includes("```")).toBe(false)
  })

  it("增量守卫：break_character 命中后立即发 guard 事件", async () => {
    mocks.mockChunks.current = chunked("作为AI我没有情感，但能陪你聊")
    const { events } = await postChat(srv.baseUrl, srv.token, "今天上班累吗")
    const guard = events.find((e) => e.type === "guard") as
      | { reason: string; text: string } | undefined
    const done = events.find((e) => e.type === "done") as
      | { guard_hit: boolean } | undefined
    expect(guard).toBeDefined()
    expect(guard!.reason).toBe("break_character")
    expect(guard!.text).toBeTruthy()
    expect(done?.guard_hit).toBe(true)
  })

  it("增量守卫：too_long 命中（超档位 1.2 倍）后发 guard 事件", async () => {
    // 标准档上限 150；hardLimit = 180；喂入 200 字符
    const long = "啊".repeat(200)
    mocks.mockChunks.current = chunked(long)
    const { events } = await postChat(srv.baseUrl, srv.token, "今天上班累吗")
    const guard = events.find((e) => e.type === "guard") as
      | { reason: string; text: string } | undefined
    const done = events.find((e) => e.type === "done") as
      | { guard_hit: boolean } | undefined
    expect(guard).toBeDefined()
    expect(guard!.reason).toBe("too_long")
    expect(done?.guard_hit).toBe(true)
  })

  it("闲聊档 ≤80 字上限：超上限未达 1.2 倍时追加省略号", async () => {
    // 闲聊问题：rag_skip_patterns 命中 → 闲聊档 → tierLimit=80, hardLimit=96
    // 喂入 85 字符：超 80 但 < 96，应软截断追加 "……"
    mocks.mockChunks.current = chunked("嗯".repeat(85))
    const { events } = await postChat(srv.baseUrl, srv.token, "你好")
    const guard = events.find((e) => e.type === "guard")
    expect(guard).toBeUndefined() // 未达硬截断阈值
    const deltas = events.filter((e) => e.type === "delta") as { text: string }[]
    const fullText = deltas.map((d) => d.text).join("")
    // 末尾必须含 "……" 省略号
    expect(fullText.endsWith("……")).toBe(true)
    // 上限 80，软截断后总长不超过 80 + "……"(2 字符) + 切片余数
    expect(fullText.length).toBeLessThanOrEqual(85 + 2)
  })

  it("标准档 ≤150 字上限：超上限未达 1.2 倍时追加省略号", async () => {
    // 标准档问题：正常问题 → tierLimit=150, hardLimit=180
    // 喂入 160 字符：超 150 但 < 180
    mocks.mockChunks.current = chunked("嗯".repeat(160))
    const { events } = await postChat(srv.baseUrl, srv.token, "明天要当众演讲好紧张")
    const guard = events.find((e) => e.type === "guard")
    expect(guard).toBeUndefined()
    const deltas = events.filter((e) => e.type === "delta") as { text: string }[]
    const fullText = deltas.map((d) => d.text).join("")
    expect(fullText.endsWith("……")).toBe(true)
    expect(fullText.length).toBeLessThanOrEqual(160 + 2)
  })

  it("深度档 ≤400 字上限：超上限未达 1.2 倍时追加省略号", async () => {
    // 深度档问题：≥150 字输入 → tierLimit=400, hardLimit=480
    const deepQ = "我最近工作压力特别大，公司接二连三砍掉我参与的项目，回家父母又催我相亲，同学群里都在晒房晒车，我跟另一半的关系也因为我没时间陪而开始僵。我每天早上醒来都觉得很沉，不知道先处理哪一头，每件事都像在拉扯我，麻烦你帮我理一下思路和方向，看看哪个先放一放、哪个必须先动起来、哪个可以再扛一下，我现在整个人都快撑不住了。"
    expect(deepQ.length).toBeGreaterThanOrEqual(150)
    // 喂入 420 字符：超 400 但 < 480
    mocks.mockChunks.current = chunked("嗯".repeat(420))
    const { events } = await postChat(srv.baseUrl, srv.token, deepQ)
    const guard = events.find((e) => e.type === "guard")
    expect(guard).toBeUndefined()
    const deltas = events.filter((e) => e.type === "delta") as { text: string }[]
    const fullText = deltas.map((d) => d.text).join("")
    expect(fullText.endsWith("……")).toBe(true)
    expect(fullText.length).toBeLessThanOrEqual(420 + 2)
  })

  it("深度档 system prompt 拼接档位指令（含'复述'段）", async () => {
    mocks.mockChunks.current = chunked("好的我听到你")
    const deepQ = "我最近工作压力特别大，公司接二连三砍掉我参与的项目，回家父母又催我相亲，同学群里都在晒房晒车，我跟另一半的关系也因为我没时间陪而开始僵。我每天早上醒来都觉得很沉，不知道先处理哪一头，每件事都像在拉扯我，麻烦你帮我理一下思路和方向，看看哪个先放一放、哪个必须先动起来、哪个可以再扛一下，我现在整个人都快撑不住了。"
    await postChat(srv.baseUrl, srv.token, deepQ)
    // 验证传给 LLM 的 system 含"档位：deep"标识 + "复述"段（深度档三段式第 1 段）
    expect(mocks.lastSystem.current).toContain("档位：deep")
    expect(mocks.lastSystem.current).toContain("复述")
    // maxTokens 也按深度档调整
    expect(mocks.lastMaxTokens.current).toBe(TIER_MAX_TOKENS.deep)
  })

  it("标准档 system prompt 含'档位：standard' + maxTokens=300", async () => {
    mocks.mockChunks.current = chunked("深呼吸")
    await postChat(srv.baseUrl, srv.token, "明天要当众演讲好紧张")
    expect(mocks.lastSystem.current).toContain("档位：standard")
    expect(mocks.lastMaxTokens.current).toBe(TIER_MAX_TOKENS.standard)
  })

  it("闲聊档 system prompt 含'档位：chitchat' + maxTokens=160", async () => {
    mocks.mockChunks.current = chunked("嗨")
    await postChat(srv.baseUrl, srv.token, "你好")
    expect(mocks.lastSystem.current).toContain("档位：chitchat")
    expect(mocks.lastMaxTokens.current).toBe(TIER_MAX_TOKENS.chitchat)
  })
})

// ============================================================================
// 单元：流式守卫 createStreamGuard 单测（不依赖 server，更聚焦）
// ============================================================================
describe("createStreamGuard (单元)", () => {
  it("未触发时 hardStop=false + softLimitReached=false", () => {
    const g = createStreamGuard(150)
    const r = g.feed("你好")
    expect(r.hardStop).toBe(false)
    expect(r.softLimitReached).toBe(false)
    expect(g.length()).toBe(2)
    expect(g.tierLimit()).toBe(150)
    expect(g.hardLimit()).toBe(180) // Math.ceil(150 × 1.2)
  })

  it("累积到档位上限时 softLimitReached 变 true（未硬截断）", () => {
    const g = createStreamGuard(80)
    g.feed("嗯".repeat(50))
    expect(g.isSoftLimitReached()).toBe(false)
    g.feed("嗯".repeat(30))
    expect(g.isSoftLimitReached()).toBe(true)
    expect(g.isHardStopped()).toBe(false)
  })

  it("超过 1.2 倍档位硬截断 → too_long", () => {
    const g = createStreamGuard(80) // hardLimit = 96
    const r = g.feed("啊".repeat(97))
    expect(r.hardStop).toBe(true)
    expect(r.hardReason).toBe("too_long")
    expect(g.hardStopReason()).toBe("too_long")
  })

  it("代码块出现立即硬截断", () => {
    const g = createStreamGuard(150)
    const r = g.feed("看个例子\n```python\nfoo\n")
    expect(r.hardStop).toBe(true)
    expect(r.hardReason).toBe("code_block")
  })

  it("出戏词出现立即硬截断", () => {
    const g = createStreamGuard(150)
    const r = g.feed("作为AI我没有情感")
    expect(r.hardStop).toBe(true)
    expect(r.hardReason).toBe("break_character")
  })

  it("硬截断后再喂入 delta 仍返回 hardStop=true（不再变化）", () => {
    const g = createStreamGuard(80)
    g.feed("```")
    const r = g.feed("更多的内容")
    expect(r.hardStop).toBe(true)
    expect(g.hardStopReason()).toBe("code_block")
  })

  it("markEllipsisSent 幂等", () => {
    const g = createStreamGuard(80)
    g.feed("嗯".repeat(80))
    expect(g.isEllipsisSent()).toBe(false)
    g.markEllipsisSent()
    g.markEllipsisSent()
    expect(g.isEllipsisSent()).toBe(true)
  })
})

// ============================================================================
// 单元：档位判定 decideReplyTier + buildTierInstruction
// ============================================================================
describe("decideReplyTier + buildTierInstruction (单元)", () => {
  it("命中 rag_skip_patterns → chitchat", () => {
    const filter = loadIntentFilter()
    expect(decideReplyTier("你好", filter)).toBe("chitchat")
    expect(decideReplyTier("早上好", filter)).toBe("chitchat")
  })

  it("输入 ≥150 字 → deep", () => {
    const filter = loadIntentFilter()
    const long = "我".repeat(150)
    expect(decideReplyTier(long, filter)).toBe("deep")
  })

  it("输入 < 150 字且非闲聊 → standard", () => {
    const filter = loadIntentFilter()
    expect(decideReplyTier("明天要当众演讲好紧张", filter)).toBe("standard")
    expect(decideReplyTier("项目要延期了怎么办", filter)).toBe("standard")
  })

  it("buildTierInstruction 三个档位都有显眼的'档位：'标识", () => {
    expect(buildTierInstruction("chitchat")).toMatch(/档位：chitchat/)
    expect(buildTierInstruction("standard")).toMatch(/档位：standard/)
    expect(buildTierInstruction("deep")).toMatch(/档位：deep/)
  })

  it("buildTierInstruction deep 必含'复述'/'分析'/'建议'", () => {
    const d = buildTierInstruction("deep")
    expect(d).toContain("复述")
    expect(d).toContain("人格视角分析")
    expect(d).toContain("具体建议")
  })

  it("TIER_MAX_CHARS 三档制数值正确", () => {
    expect(TIER_MAX_CHARS.chitchat).toBe(80)
    expect(TIER_MAX_CHARS.standard).toBe(150)
    expect(TIER_MAX_CHARS.deep).toBe(400)
  })

  it("hardLimitFor = Math.ceil(limit × 1.2)", () => {
    expect(hardLimitFor("chitchat")).toBe(96) // ceil(80 × 1.2)
    expect(hardLimitFor("standard")).toBe(180) // ceil(150 × 1.2)
    expect(hardLimitFor("deep")).toBe(480) // ceil(400 × 1.2)
  })
})
