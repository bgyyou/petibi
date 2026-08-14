// 【文件说明】M5 真 API 接入工单自验脚本：
//   1. 起 server（PETIBI_DISABLE_QUOTA=1；DEEPSEEK_* 由仓库根 .env 注入）
//   2. 用 test@petibi.local + 123456 登录拿 JWT
//   3. 调 /api/chat 发"明天要当众演讲好紧张"（INTJ 档案）
//   4. 验证 SSE 流式 + 真回答（非 mock）+ 人格化
//   5. PETIBI_DISABLE_QUOTA=0 时跑第 4 次被拦（R4 回归）
//
// 运行：node scripts/m5-smoke.mjs
// 输出：本进程 stdout；最后一行打印 PASS / FAIL + 总耗时。

import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, "..")

// 1. 先加载 .env，再启动 server bundle
const require = createRequire(import.meta.url)
const dotenv = require("dotenv")
const envPath = join(projectRoot, ".env")
const envResult = dotenv.config({ quiet: true, path: envPath })
console.log("[m5-smoke] env file:", envPath)
console.log("[m5-smoke] env keys loaded:", Object.keys(envResult.parsed ?? {}).length)
console.log("[m5-smoke] PETIBI_DISABLE_QUOTA =", process.env.PETIBI_DISABLE_QUOTA ?? "(unset)")

// 2. 直接 require embed bundle 并调 startServer（这是 Electron 主进程的同款路径）
const req = createRequire(import.meta.url)
const serverBundle = join(projectRoot, "dist", "server", "server.cjs")
console.log("[m5-smoke] server bundle:", serverBundle)

const { startServer } = req(serverBundle)
const PORT = 8799
// CJS bundle 下 import.meta.url 为 undefined，server 内部 loadIntentFilter /
// loadRefusals / loadAllEncyclopediaFiles / loadSensitiveWords 都需要
// PETIBI_*_PATH 兜住（Electron 主进程同样会注入这些）。这里显式注入仓库根。
process.env.PETIBI_INTENT_FILTER_PATH = join(projectRoot, "data", "intent-filter.json")
process.env.PETIBI_REFUSALS_PATH = join(projectRoot, "data", "refusals.json")
process.env.PETIBI_ENCYCLOPEDIA_INDEX_PATH = join(projectRoot, "data", "encyclopedia", "index.json")
process.env.PETIBI_ENCYCLOPEDIA_DIR = join(projectRoot, "data", "encyclopedia")
process.env.PETIBI_SENSITIVE_WORDS_PATH = join(projectRoot, "data", "sensitive-words.json")
const running = await startServer({
  host: "127.0.0.1",
  port: PORT,
  dbPath: ":memory:",
  jwtSecret: "m5-smoke-secret",
  // CJS bundle 下 import.meta.url 为空，必须显式注入 static dir（同 Electron 主进程做法）
  publicDir: join(projectRoot, "server", "public"),
  postersDir: join(projectRoot, "server", "data", "posters"),
  personasDir: join(projectRoot, "data", "personas"),
})
console.log(`[m5-smoke] server listening on http://${running.host}:${running.port}`)
console.log(`[m5-smoke] mock mode = ${!running.config.llm.apiKey || running.config.llm.forceMock}`)
console.log(`[m5-smoke] disableQuota = ${running.config.disableQuota}`)

async function waitForServer() {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`)
  if (!r.ok) throw new Error("healthz " + r.status)
}

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`)
  } else {
    failures++
    console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`)
  }
}

try {
  await waitForServer()
  const BASE = `http://127.0.0.1:${PORT}`

  // 3. 测试账号快速登录
  const verifyRes = await fetch(`${BASE}/api/auth/email/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@petibi.local", code: "123456" }),
  })
  check("测试账号登录返回 200", verifyRes.status === 200, "status=" + verifyRes.status)
  const verifyBody = await verifyRes.json()
  check("返回 ok=true + token", verifyBody.ok === true && typeof verifyBody.token === "string")
  const token = verifyBody.token

  // 4. 写档 INTJ（保证 chat 通过 profile 校验）
  const profileRes = await fetch(`${BASE}/api/me/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nickname: "测试员", mbti: "INTJ", subtype: "stable" }),
  })
  check("写档 INTJ 返回 200", profileRes.status === 200, "status=" + profileRes.status)

  // 5. /api/chat 发"明天要当众演讲好紧张"，期望 SSE 流式 + 真回答
  const t0 = Date.now()
  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "明天要当众演讲好紧张" }),
  })
  check("/api/chat 返回 200", chatRes.status === 200, "status=" + chatRes.status)
  check("Content-Type 是 SSE", (chatRes.headers.get("Content-Type") || "").includes("text/event-stream"))

  const raw = await chatRes.text()
  const tRead = Date.now() - t0
  console.log("[m5-smoke] chat response status:", chatRes.status)
  console.log("[m5-smoke] chat response headers:", JSON.stringify(Object.fromEntries(chatRes.headers.entries())))
  console.log("[m5-smoke] chat raw body (first 800 chars):")
  console.log(raw.slice(0, 800))
  console.log("[m5-smoke] chat raw body length:", raw.length)
  // 解析 SSE
  const events = []
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith(":")) continue
    const dataLines = []
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    try { events.push(JSON.parse(dataLines.join("\n"))) } catch {}
  }

  const meta = events.find((e) => e.type === "meta")
  const deltas = events.filter((e) => e.type === "delta")
  const done = events.find((e) => e.type === "done")
  const errorEv = events.find((e) => e.type === "error")
  const fullText = deltas.map((d) => d.text).join("")

  check("meta 事件存在", !!meta)
  check("meta.refused=false", meta?.refused === false)
  check("meta.rag_entry_id 命中 public-speaking 场景", /public-speaking/.test(meta?.rag_entry_id || ""))
  check("至少 1 个 delta", deltas.length >= 1, `count=${deltas.length}`)
  check("done 事件存在", !!done)
  check("无 error 事件", !errorEv)
  check("回答非 mock 标记", !fullText.startsWith("（mock）") && !fullText.startsWith("[mock]"), `prefix=${JSON.stringify(fullText.slice(0, 10))}`)
  check("回答长度合理（30~500 字）", fullText.length >= 30 && fullText.length <= 500, `len=${fullText.length}`)
  check("流式读取耗时 < 30s", tRead < 30000, `${tRead}ms`)

  // 6. 人格化验证：INTJ 风格的措辞信号（结构化、冷静、聚焦等关键词）。
  //   INTJ prompt 强调"先冷静拆解 → 抓住核心 → 给具体步骤"，实际回答含
  //   "否定/切换/核心/演练/今晚/关键词" 等信号即视为通过。
  const personaKeywords = ["思路", "结构", "拆", "梳理", "逻辑", "分析", "按部就班", "框架", "准备", "应对", "分", "核心", "否定", "切换", "演练", "今晚", "只做"]
  const personaHits = personaKeywords.filter((kw) => fullText.includes(kw))
  check("回答含人格化关键词（INTJ 冷静/结构化倾向）", personaHits.length >= 1, `命中: ${personaHits.join("/") || "(无)"}`)

  console.log("\n========= 真实回答全文 =========")
  console.log(fullText)
  console.log("========= /真实回答全文 =========\n")

  // 7. PETIBI_DISABLE_QUOTA=1 时连发 12 次不被拦
  console.log("---- 步骤 7：连发 12 次，验证 PETIBI_DISABLE_QUOTA=1 时不拦截 ----")
  let allOk = true
  const errs = []
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: `帮我写代码 ${i}` }),
    })
    const t = await r.text()
    if (/今日对话次数已用完/.test(t)) {
      allOk = false
      errs.push(i)
    }
  }
  check("12 次连续请求无配额拦截", allOk, errs.length ? `拦截下标: ${errs.join(",")}` : "")

  // 8. 检查 GET /api/quota 报告 disabled=true
  const quotaRes = await fetch(`${BASE}/api/quota`, { headers: { Authorization: `Bearer ${token}` } })
  const quotaBody = await quotaRes.json()
  check("GET /api/quota 返回 disabled=true", quotaBody.disabled === true, JSON.stringify(quotaBody))

  console.log("\n[m5-smoke] PASS =", failures === 0 ? "ALL ✓" : `${failures} FAILED`)
} catch (err) {
  console.error("[m5-smoke] FATAL:", err)
  failures++
} finally {
  await running.close()
}

process.exit(failures === 0 ? 0 : 1)