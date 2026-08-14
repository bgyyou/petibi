// 【文件说明】M5 真 API 接入工单：R4 红线回归（PETIBI_DISABLE_QUOTA 未设 / =0）
//
// 验证：
//   - 不设 PETIBI_DISABLE_QUOTA（或设 =0）时，/api/chat 跑满每日配额后第 N+1 次被拒
//   - 与 M5 disableQuota=true 路径互不干扰
//
// 运行：node scripts/m5-quota-r4.mjs
// 输出：stdout PASS / FAIL；退出码 0=全过 / 1=有失败。

import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, "..")
const req = createRequire(import.meta.url)
const dotenv = req("dotenv")
const envPath = join(projectRoot, ".env")

// 关键：必须先 dotenv.config 把 .env 加载进来，**再** 显式覆盖 disableQuota=0，
// 让 config 看到的 PETIBI_DISABLE_QUOTA 是被覆盖后的值。
// embed bundle 内部又会调 loadProjectEnv()（同样 dotenv.config，不会覆盖已有 env），
// 所以这里 process.env 里的最终值就是 0。
dotenv.config({ quiet: true, path: envPath })
process.env.PETIBI_DISABLE_QUOTA = "0"
process.env.PETIBI_DAILY_QUOTA = "3" // 用 3 跑得快
console.log("[m5-r4] PETIBI_DISABLE_QUOTA =", JSON.stringify(process.env.PETIBI_DISABLE_QUOTA))

const { startServer } = req(join(projectRoot, "dist", "server", "server.cjs"))
// 注入 CJS bundle 需要的 PETIBI_*_PATH（import.meta.url 为空）
process.env.PETIBI_INTENT_FILTER_PATH = join(projectRoot, "data", "intent-filter.json")
process.env.PETIBI_REFUSALS_PATH = join(projectRoot, "data", "refusals.json")
process.env.PETIBI_ENCYCLOPEDIA_INDEX_PATH = join(projectRoot, "data", "encyclopedia", "index.json")
process.env.PETIBI_ENCYCLOPEDIA_DIR = join(projectRoot, "data", "encyclopedia")
process.env.PETIBI_SENSITIVE_WORDS_PATH = join(projectRoot, "data", "sensitive-words.json")

const running = await startServer({
  host: "127.0.0.1", port: 8795, dbPath: ":memory:", jwtSecret: "x",
  publicDir: join(projectRoot, "server", "public"),
  postersDir: join(projectRoot, "server", "data", "posters"),
  personasDir: join(projectRoot, "data", "personas"),
})
console.log("[m5-r4] mock mode:", !running.config.llm.apiKey || running.config.llm.forceMock)
console.log("[m5-r4] disableQuota:", running.config.disableQuota, "dailyQuota:", running.config.dailyQuota)

const BASE = `http://127.0.0.1:8795`
const verify = await fetch(`${BASE}/api/auth/email/verify`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "test@petibi.local", code: "123456" }),
})
const vbody = await verify.json()
const token = vbody.token

// 先写档 INTJ（让 /api/chat 通过 profile 校验，否则会被 409 拒）
await fetch(`${BASE}/api/me/profile`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ nickname: "测试员", mbti: "INTJ", subtype: "stable" }),
})

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`[PASS] ${name}${detail ? " — " + detail : ""}`)
  else { failures++; console.log(`[FAIL] ${name}${detail ? " — " + detail : ""}`) }
}

try {
  // 前 3 次：每次都"今天用了 1/2/3" → 应都成功（无 SSE error）
  for (let i = 1; i <= 3; i++) {
    const r = await fetch(`${BASE}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: `帮我写代码 ${i}` }), // 命中意图过滤，但配额仍扣
    })
    const raw = await r.text()
    const errorEv = raw.includes('"type":"error"') && raw.includes("今日对话次数已用完")
    check(`第 ${i} 次不被配额拦截（dailyQuota=3）`, !errorEv, `status=${r.status} len=${raw.length}`)
  }

  // 第 4 次：应被配额拦截（SSE error 事件含"今日对话次数已用完"）
  const r4 = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: "帮我写代码 4" }),
  })
  const raw4 = await r4.text()
  check("第 4 次被配额拦截（R4 红线回归）", raw4.includes("今日对话次数已用完"), `status=${r4.status} body[:200]=${JSON.stringify(raw4.slice(0, 200))}`)

  // /api/quota 报告 disabled=false
  const quotaRes = await fetch(`${BASE}/api/quota`, { headers: { Authorization: `Bearer ${token}` } })
  const quotaBody = await quotaRes.json()
  check("GET /api/quota 返回 disabled=false", quotaBody.disabled === false, JSON.stringify(quotaBody))

  console.log("\n[m5-r4] PASS =", failures === 0 ? "ALL ✓" : `${failures} FAILED`)
} catch (err) {
  console.error("[m5-r4] FATAL:", err)
  failures++
} finally {
  await running.close()
}

process.exit(failures === 0 ? 0 : 1)