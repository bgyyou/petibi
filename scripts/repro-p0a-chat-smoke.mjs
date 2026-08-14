// 【文件说明】M5 P1-D 验证脚本：安装版 chat 真实 API 链路冒烟（mock=false）。
//
// 跑法：
//   cd "C:/Users/19802/Desktop/ClaudeCodeTest/MBTIwilldo"
//   node scripts/repro-p0a-chat-smoke.mjs --exe release/win-unpacked/Petibi.exe
//
// 不依赖真实 DeepSeek 网络（用 fake key，让 server 走真 LLM 链路第一个 if 分支判断 mock=false）
// 验证点：
//   1) 主进程日志显示 DEEPSEEK_API_KEY present (length=N)
//   2) server 启动日志显示 mock mode = false
//   3) /api/auth/email/code 返回 dev code（dev 模式）

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

function parseArgs() {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--exe')
  const exe = idx >= 0 ? args[idx + 1] : null
  return { exe: exe ? resolve(projectRoot, exe) : null }
}

const DEBUG_PORT = 9777
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const hit = targets.find((t) => t.type === 'page' && predicate(String(t.url)))
      if (hit) return hit
    } catch {}
    await sleep(300)
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`)
}

async function evaluateInTarget(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Runtime.evaluate 超时')), 8000)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === 1) {
        clearTimeout(timer)
        res(msg.result)
      }
    })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true } }))
  })
  ws.close()
  return result
}

function makeJwt({ email, expInSec }) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({ sub: '1', email, iat: now, exp: now + expInSec }),
  ).toString('base64url')
  return `${header}.${payload}.fake-sig`
}

async function main() {
  const { exe } = parseArgs()
  const binary = exe ?? join(projectRoot, 'release', 'win-unpacked', 'Petibi.exe')
  if (!existsSync(binary)) {
    console.error(`[smoke] 不存在：${binary}`)
    process.exit(1)
  }

  const userDataDir = mkdtempSync(join(tmpdir(), `petibi-smoke-`))
  const validToken = makeJwt({ email: 'a@b.com', expInSec: 30 * 24 * 3600 })
  writeFileSync(
    join(userDataDir, 'profile.json'),
    JSON.stringify({ token: validToken, profile: { email: 'a@b.com', nickname: '蝴蝶', mbti: 'INFP', subtype: 'sensitive', createdAt: '2026-08-14T08:00:00.000Z' } }, null, 2),
    { mode: 0o600 },
  )

  // 注入 fake key 让 server 走真 LLM 链路（不需要真网络，只是验证 mock=false 决策）
  const fakeKey = 'sk-owner-test-fake-' + 'x'.repeat(15)
  const child = spawn(binary, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: projectRoot,
    env: { ...process.env, DEEPSEEK_API_KEY: fakeKey, FORCE_MOCK: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let mainLog = ''
  child.stdout.on('data', (b) => { mainLog += b.toString(); process.stdout.write(`[main] ${b}`) })
  child.stderr.on('data', (b) => process.stdout.write(`[main:err] ${b}`))
  let exited = false
  child.on('exit', () => { exited = true })

  try {
    const isPet = (url) => url.includes('index.html') && !url.includes('setup/') && !url.includes('panel/')
    const target = await waitForTarget(isPet, 15000, '桌宠窗')

    // 断言 1：DEEPSEEK_API_KEY present
    const keyLine = mainLog.match(/DEEPSEEK_API_KEY (present|未配置)[^\n]*/)
    console.log(`[smoke] key 状态：${keyLine?.[0]}`)
    if (!keyLine?.[0]?.includes('present')) {
      console.error('[smoke] ❌ DEEPSEEK_API_KEY 未读到')
      process.exit(1)
    }

    // 断言 2：mock mode = false
    const mockLine = mainLog.match(/mock mode = (true|false)/)
    console.log(`[smoke] server mock 模式：${mockLine?.[0]}`)
    if (!mockLine?.[0]?.includes('false')) {
      console.error('[smoke] ❌ server mock mode 不是 false（应该走真实 LLM）')
      process.exit(1)
    }

    // 断言 3：通过渲染端 CDP 调 server /api/auth/email/code + verify + chat（不看 LLM 真回答，看链路通）
    const apiChainExpr = `(async () => {
      const base = window.petApi.getServerBaseUrl()
      const email = 'smoke-' + Date.now() + '@example.com'
      const j = async (method, path, body, token) => {
        const headers = {}
        if (body) headers['Content-Type'] = 'application/json'
        if (token) headers['Authorization'] = 'Bearer ' + token
        const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
        return { status: res.status, body: await res.json().catch(() => null) }
      }
      const code = await j('POST', '/api/auth/email/code', { email })
      const verify = await j('POST', '/api/auth/email/verify', { email, code: code.body.devCode })
      const token = verify.body.token
      await j('POST', '/api/me/profile', { nickname: '蝴蝶', mbti: 'INFP', subtype: 'sensitive' }, token)
      // 调一次 chat；不期望真回答（fake key 必然失败），只期望拿到非 mock 标记：流式响应 + SSE events
      const res = await fetch(base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ question: '你好' }),
      })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      // 收集前 500ms 的 SSE 流；只要 : mock mode 注释行不在，就说明不是 mock
      const start = Date.now()
      while (Date.now() - start < 800) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value)
      }
      try { reader.cancel() } catch {}
      const isMock = buf.includes(': mock mode')
      const hasMeta = buf.includes('"type":"meta"')
      return JSON.stringify({ isMock, hasMeta, firstLine: buf.split('\\n')[0] })
    })()`
    const evalResult = await evaluateInTarget(target.webSocketDebuggerUrl, apiChainExpr)
    const apiValue = evalResult?.result?.value
    console.log(`[smoke] chat 链路：${apiValue}`)
    const parsed = JSON.parse(apiValue)
    if (parsed.isMock) {
      console.error('[smoke] ❌ chat 返回了 mock 标记')
      process.exit(1)
    }
    if (!parsed.hasMeta) {
      console.error('[smoke] ❌ chat 没有发出 meta 事件（链路异常）')
      process.exit(1)
    }
    console.log('[smoke] ✅ chat 走真实 API 链路（非 mock），meta 事件已下发')
  } catch (err) {
    console.error(`[smoke] 异常：${err.message}`)
    process.exit(1)
  } finally {
    if (!exited) child.kill('SIGKILL')
    await sleep(800)
    try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

await main()