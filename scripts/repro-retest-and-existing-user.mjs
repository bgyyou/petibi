// 【文件说明】M4 P2-025 Bug 1 + Bug 2 安装版 CDP 验证脚本：
//
//   Bug 1：重测换人格不能撞 server 409「已写档，重复写档不在 MVP 范围内」。
//   Bug 2：老用户登录后必须 pet + panel 双开（不是仅 pet）。
//
// 两条路径都在真实 Electron + 内嵌 server 里跑：
//   路径 A（Bug 1）：先注册 + 写档 ESFP → 走 retest 流程（重测 setup 模式 → ResultPage
//                  → saveProfile 改 INTJ）→ 验证 server /api/me 收到 INTJ（不是 409）。
//   路径 B（Bug 2）：注册 + 写档 INFP → 退出 → 重新走 LoginPage 老用户直通 →
//                  验证 pet + panel 双窗都出现。
//
// 参考 scripts/repro-setup-complete.mjs / repro-login-gate.mjs 的 CDP 模式。
//
// 用法：
//   node scripts/repro-retest-and-existing-user.mjs
//   node scripts/repro-retest-and-existing-user.mjs --exe <path>
//
// 退出码：0 = 两条路径全过；1 = 至少一条失败。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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

function electronBinary() {
  const pathTxt = join(projectRoot, 'node_modules', 'electron', 'path.txt')
  const rel = readFileSync(pathTxt, 'utf-8').trim()
  return join(projectRoot, 'node_modules', 'electron', 'dist', rel)
}

const DEBUG_PORT = 9555
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const hit = targets.find((t) => t.type === 'page' && predicate(String(t.url)))
      if (hit) return hit
    } catch {
      // devtools 端口还没起来
    }
    await sleep(300)
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`)
}

async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    return await res.json()
  } catch {
    return []
  }
}

/** 通过 CDP 在目标页面执行一段 JS */
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

/** spawn electron 并返回 child + alive 状态查询器 */
function spawnElectron(binary, userDataDir) {
  const argv = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
  ]
  console.log(`[repro] 启动：${binary}`)
  console.log(`[repro] userData：${userDataDir}`)
  const child = spawn(binary, argv, {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  let exitCode = null
  child.on('exit', (code) => {
    exited = true
    exitCode = code
  })
  child.stdout.on('data', (b) => process.stdout.write(`[main] ${b}`))
  child.stderr.on('data', (b) => process.stdout.write(`[main:err] ${b}`))
  return {
    child,
    isAlive: () => !exited,
    getExitCode: () => exitCode,
    kill: async () => {
      if (!exited) {
        child.kill('SIGKILL')
        await sleep(800)
      }
    },
  }
}

// ===== 公共：登录 → 拿 token =====
const LOGIN_AND_REGISTER_EXPRESSION = `(async () => {
  const base = window.petApi.getServerBaseUrl()
  const email = 'repro-' + Date.now() + '-' + Math.floor(Math.random()*1000) + '@example.com'
  const j = async (method, path, body, token) => {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers['Authorization'] = 'Bearer ' + token
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    let body2 = null
    try { body2 = await res.json() } catch {}
    return { status: res.status, body: body2 }
  }
  const codeRes = await j('POST', '/api/auth/email/code', { email })
  const verify = await j('POST', '/api/auth/email/verify', { email, code: codeRes.body.devCode })
  return JSON.stringify({ email, token: verify.body.token, user: verify.body.user })
})()`

// ===== Bug 1：重测更新档案 =====
const RETEST_EXPRESSION = `(async () => {
  const base = window.petApi.getServerBaseUrl()
  // 直接复用 LOGIN_AND_REGISTER 拿到的 token via localStorage 不可行（这里只在 setup 窗跑一次）
  // 我们让表达式自己注册一个 ESFP 用户，再调 saveProfile 改 INTJ（模拟重测）
  const j = async (method, path, body, token) => {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers['Authorization'] = 'Bearer ' + token
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    let body2 = null
    try { body2 = await res.json() } catch {}
    return { status: res.status, body: body2 }
  }
  const email = 'retest-' + Date.now() + '-' + Math.floor(Math.random()*1000) + '@example.com'
  const codeRes = await j('POST', '/api/auth/email/code', { email })
  const verify = await j('POST', '/api/auth/email/verify', { email, code: codeRes.body.devCode })
  const token = verify.body.token
  // 首次写档：ESFP
  const first = await j('POST', '/api/me/profile', { nickname: '阿虎', mbti: 'ESFP', subtype: 'stable' }, token)
  // 重测写档：INTJ（修复前会 409）
  const retest = await j('POST', '/api/me/profile', { nickname: '阿虎', mbti: 'INTJ', subtype: 'sensitive' }, token)
  const me = await j('GET', '/api/me', null, token)
  return JSON.stringify({
    email,
    firstStatus: first.status,
    retestStatus: retest.status,
    finalMbti: me.body && me.body.mbti,
    finalSubtype: me.body && me.body.subtype,
    finalAnimal: me.body && me.body.animal,
  })
})()`

// ===== Bug 2：老用户登录 pet + panel 双开 =====
// 模拟流程：
//   1) 注册 + 写档 INFP 用户（用户已存在 + 已有档案）；
//   2) 模拟"退出登录"（仅清本地 token，server 端用户仍在）；
//   3) 再次 verify 同一邮箱 → server 返回的 user.mbti 应非空（因为档案已写）；
//   4) 调用 LoginPage 老用户直通：setProfile + completeSetupForExistingUser；
//   5) 主进程应拉起 pet + panel 双窗。
const EXISTING_USER_LOGIN_EXPRESSION = `(async () => {
  const base = window.petApi.getServerBaseUrl()
  const j = async (method, path, body, token) => {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (token) headers['Authorization'] = 'Bearer ' + token
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    let body2 = null
    try { body2 = await res.json() } catch {}
    return { status: res.status, body: body2 }
  }
  const email = 'exist-' + Date.now() + '-' + Math.floor(Math.random()*1000) + '@example.com'
  // 1) 首次注册 + 写档（让用户成为"老用户"）
  const code1 = await j('POST', '/api/auth/email/code', { email })
  const v1 = await j('POST', '/api/auth/email/verify', { email, code: code1.body.devCode })
  const t1 = v1.body.token
  await j('POST', '/api/me/profile', { nickname: '蝴蝶', mbti: 'INFP', subtype: 'sensitive' }, t1)
  // 2) 模拟退出登录（清本地 token，不动 server）
  await window.petApi.setProfile({ token: null, profile: null })
  // 3) 再次 verify 同一邮箱（这是 LoginPage 老用户直通的入口）
  const code2 = await j('POST', '/api/auth/email/code', { email })
  const v2 = await j('POST', '/api/auth/email/verify', { email, code: code2.body.devCode })
  const userMbti = v2.body.user && v2.body.user.mbti
  if (!userMbti) {
    return JSON.stringify({
      error: 'verify 没返回 user.mbti（用户已写档，应返回 INFP）',
      v2User: v2.body.user,
    })
  }
  // 4) 走 LoginPage 老用户直通：setProfile + completeSetupForExistingUser
  await window.petApi.setProfile({
    token: v2.body.token,
    profile: {
      email: v2.body.user.email,
      nickname: v2.body.user.nickname ?? v2.body.user.email,
      mbti: v2.body.user.mbti,
      subtype: v2.body.user.subtype ?? 'stable',
      createdAt: new Date().toISOString(),
    },
  })
  const apiOk = typeof window.petApi.completeSetupForExistingUser === 'function'
  window.petApi.completeSetupForExistingUser()
  return JSON.stringify({
    email,
    initialMbti: userMbti,
    initialSubtype: v2.body.user.subtype,
    petApiAvailable: apiOk,
    called: true,
  })
})()`

const isSetup = (url) => url.includes('setup/index.html')
const isPet = (url) =>
  url.includes('index.html') && !url.includes('setup/') && !url.includes('panel/')
const isPanel = (url) => url.includes('panel/index.html')

async function waitForWindows({ required, timeout = 12000 }) {
  const found = { setup: false, pet: false, panel: false }
  for (const [key, pred] of [
    ['setup', isSetup],
    ['pet', isPet],
    ['panel', isPanel],
  ]) {
    if (!required.includes(key)) continue
    try {
      await waitForTarget(pred, timeout, key)
      found[key] = true
    } catch {
      // 没等到
    }
  }
  // 同步再扫一次
  const targets = await listTargets()
  for (const t of targets) {
    const url = String(t.url)
    if (isSetup(url)) found.setup = true
    else if (isPet(url)) found.pet = true
    else if (isPanel(url)) found.panel = true
  }
  return found
}

async function main() {
  const { exe } = parseArgs()
  const binary = exe ?? electronBinary()
  if (!existsSync(binary)) {
    console.error(`[repro] 可执行文件不存在：${binary}`)
    process.exit(1)
  }
  console.log(`[repro] 二进制：${binary}`)

  let failed = false

  // ===== 路径 A：Bug 1 — 重测走通 =====
  console.log('\n[repro] === 路径 A：Bug 1 重测换人格 ===')
  {
    const userDataDir = mkdtempSync(join(tmpdir(), 'petibi-bug1-'))
    const handle = spawnElectron(binary, userDataDir)
    try {
      const setupTarget = await waitForTarget(isSetup, 30000, 'setup 窗')
      console.log(`[repro] setup 窗已就绪`)
      const evalRes = await evaluateInTarget(setupTarget.webSocketDebuggerUrl, RETEST_EXPRESSION)
      const value = evalRes?.result?.value
      if (typeof value !== 'string') {
        console.error(`[repro] ❌ RETEST 表达式执行失败：${JSON.stringify(evalRes)}`)
        failed = true
      } else {
        const parsed = JSON.parse(value)
        console.log(`[repro] RETEST 结果：${value}`)
        if (parsed.firstStatus !== 200) {
          console.error(`[repro] ❌ 首次写档失败 status=${parsed.firstStatus}`)
          failed = true
        }
        if (parsed.retestStatus !== 200) {
          console.error(`[repro] ❌ 重测写档仍 409/非 200 status=${parsed.retestStatus}（Bug 1 未修）`)
          failed = true
        }
        if (parsed.finalMbti !== 'INTJ') {
          console.error(`[repro] ❌ 重测后 server /api/me 仍是 ${parsed.finalMbti}（应为 INTJ）`)
          failed = true
        }
        if (parsed.finalSubtype !== 'sensitive') {
          console.error(`[repro] ❌ 重测后 subtype 仍是 ${parsed.finalSubtype}（应为 sensitive）`)
          failed = true
        }
        if (!failed) {
          console.log('[repro] ✅ Bug 1 修复确认：ESFP → 重测 → INTJ + sensitive 写档成功')
        }
      }
    } catch (err) {
      console.error(`[repro] 路径 A 异常：${err.message}`)
      failed = true
    } finally {
      await handle.kill()
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {}
    }
  }

  // ===== 路径 B：Bug 2 — 老用户登录 pet + panel 双开 =====
  console.log('\n[repro] === 路径 B：Bug 2 老用户登录 pet+panel 双开 ===')
  {
    const userDataDir = mkdtempSync(join(tmpdir(), 'petibi-bug2-'))
    const handle = spawnElectron(binary, userDataDir)
    try {
      const setupTarget = await waitForTarget(isSetup, 30000, 'setup 窗')
      console.log(`[repro] setup 窗已就绪`)
      // 给 setup 渲染端一点时间完成 React 挂载 + baseURL 注入（实测 1-2s 即可）
      await sleep(2000)
      const evalRes = await evaluateInTarget(setupTarget.webSocketDebuggerUrl, EXISTING_USER_LOGIN_EXPRESSION)
      const value = evalRes?.result?.value
      if (typeof value !== 'string') {
        console.error(`[repro] ❌ EXISTING_USER 表达式执行失败：${JSON.stringify(evalRes)}`)
        failed = true
      } else {
        const parsed = JSON.parse(value)
        console.log(`[repro] EXISTING_USER 结果：${value}`)
        if (parsed.error) {
          console.error(`[repro] ❌ ${parsed.error}`)
          failed = true
        } else if (!parsed.petApiAvailable) {
          console.error('[repro] ❌ petApi.completeSetupForExistingUser 未暴露（preload 未更新）')
          failed = true
        } else {
          // 给主进程 4 秒时间拉起双窗
          await sleep(4000)
          const found = await waitForWindows({ required: ['pet', 'panel'], timeout: 4000 })
          console.log(`[repro] 老用户登录后窗口：pet=${found.pet} panel=${found.panel} setup=${found.setup}`)
          if (!found.pet) {
            console.error('[repro] ❌ 老用户登录后 pet 窗未出现')
            failed = true
          }
          if (!found.panel) {
            console.error('[repro] ❌ 老用户登录后 panel 窗未出现（Bug 2 未修）')
            failed = true
          }
          if (found.setup) {
            console.error('[repro] ❌ 老用户登录后 setup 窗未关')
            failed = true
          }
          if (found.pet && found.panel && !found.setup) {
            console.log('[repro] ✅ Bug 2 修复确认：老用户登录后 pet + panel 双开，setup 已关')
          }
        }
      }
    } catch (err) {
      console.error(`[repro] 路径 B 异常：${err.message}`)
      failed = true
    } finally {
      await handle.kill()
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {}
    }
  }

  if (failed) {
    console.error('\n[repro] ❌ 至少一条路径失败')
    process.exit(1)
  }
  console.log('\n[repro] ✅ 两条路径全过（Bug 1 + Bug 2 已修）')
}

await main()
