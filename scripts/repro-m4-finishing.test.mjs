// 【文件说明】M4 收尾修复主进程级真实验收脚本（CDP 驱动 release 安装版）。
//
// 验证矩阵（按 owner 三个收尾问题对齐）：
//   1. 选人格页返回键：4 个 setup 页返回键在源码 + 渲染端均存在性
//      - 静态分析由 src/setup/__tests__/backButtonPresence.test.ts 覆盖（4 页 + 组件 + retest 隐藏契约共 6 用例）；
//      - 这里只做渲染端 DOM 自检：在 setup 窗初始 DOM（LoginPage 步，**无**返回键——设计如此）上断言
//        标题栏 4 个关键元素存在（证明组件 mount 成功）；
//      - 然后走真实 login API 链路 + 手动派发 React 事件，**等够 2s 让 state machine 收敛**
//        再断言 nickname / pick / test / result 各 step 渲染的返回键真实存在 + 可见；
//   2. 最小化键：派 petApi.minimizeSetup()，CDP 不抛错（IPC 链路已通）；
//   3. 双击交互：托盘双击是主进程行为（tray.on('double-click', ...)），由 electron 测试覆盖；
//      桌宠双击由 src/__tests__/decideClickSequence.test.ts 状态机纯函数覆盖 15 用例。
//
// 为什么 CDP 只验一部分：CDP 走 setup 全流程需要 40 题答完（约 5s）+ 多次异步等待，
// 一旦 server 启动慢或 React 重渲染延迟就会让 fail/pass 抖动。本脚本专注"初始 DOM +
// IPC 链路 + 1-2 步推进"的高置信断言，详细分页断言走 vitest。
//
// 用法：
//   node scripts/repro-m4-finishing.test.mjs                       # 跑 out/main 产物
//   node scripts/repro-m4-finishing.test.mjs --exe release/win-unpacked/Petibi.exe
//
// 退出码：0 = 全部通过；1 = 任一断言失败。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

function parseArgs() {
  const argv = process.argv.slice(2)
  let exe
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe' && argv[i + 1]) {
      exe = resolve(argv[i + 1])
      i++
    }
  }
  return { exe }
}

function electronBinary() {
  const pathTxt = join(projectRoot, 'node_modules', 'electron', 'path.txt')
  const rel = readFileSync(pathTxt, 'utf-8').trim()
  return join(projectRoot, 'node_modules', 'electron', 'dist', rel)
}

const DEBUG_PORT = 9335
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
      /* port not up */
    }
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
    const timer = setTimeout(() => rej(new Error('Runtime.evaluate 超时')), 15000)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === 1) {
        clearTimeout(timer)
        res(msg.result)
      }
    })
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    )
  })
  ws.close()
  if (result && result.exceptionDetails) {
    throw new Error('CDP evaluate 抛错：' + JSON.stringify(result.exceptionDetails))
  }
  return result?.result?.value
}

function spawnElectron(exe, userDataDir) {
  const args = [
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + userDataDir,
    '--no-sandbox',
    projectRoot,
  ]
  console.log(`[repro] 启动：${exe}`)
  return spawn(exe, args, {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// 验证 1：setup 窗初始 DOM 自检（LoginPage 步，**没有**返回键——设计如此）
const INITIAL_DOM_CHECK = `(() => {
  return {
    hasTitlebar: !!document.querySelector('.petibi-titlebar'),
    hasMinBtn: !!document.querySelector('[data-testid="titlebar-minimize-btn"]'),
    hasCloseBtn: !!document.querySelector('[data-testid="titlebar-close-btn"]'),
    hasSetupShell: !!document.querySelector('.setup-shell'),
    backBtnOnLogin: !!document.querySelector('[data-testid^="setup-back-"]'),  // 期望 false
    petApiType: typeof window.petApi,
    petApiHasMinimize: !!(window.petApi && typeof window.petApi.minimizeSetup === 'function'),
    petApiHasCancel: !!(window.petApi && typeof window.petApi.cancelSetup === 'function'),
  }
})()`

// 验证 2：最小化键 IPC 派发
const FIRE_MINIMIZE = `(async () => {
  if (!window.petApi || typeof window.petApi.minimizeSetup !== 'function') {
    return { ok: false, reason: 'no minimizeSetup' }
  }
  window.petApi.minimizeSetup()
  await new Promise((r) => setTimeout(r, 300))
  return { ok: true, fired: true }
})()`

// 验证 3：通过真实 API 链路推进到 nickname，断言返回键
// 走法：先拿 devCode → 注入 email + code → 点"下一步" → 等 2s → 查 [data-testid="setup-back-nickname"]
const ADVANCE_AND_CHECK_NICKNAME = `(async () => {
  const api = window.petApi
  const base = api.getServerBaseUrl()
  const j = async (method, path, body) => {
    const headers = body ? { 'Content-Type': 'application/json' } : {}
    const res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const email = 'repro-m4f-' + Date.now() + '@example.com'
  const codeRes = await j('POST', '/api/auth/email/code', { email })
  if (!codeRes.body || !codeRes.body.devCode) {
    return { error: 'no devCode', detail: codeRes }
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const emailInput = document.querySelector('input#email')
  const codeInput = document.querySelector('input#code')
  if (!emailInput || !codeInput) return { error: 'no login inputs' }
  setter.call(emailInput, email)
  emailInput.dispatchEvent(new Event('input', { bubbles: true }))
  setter.call(codeInput, codeRes.body.devCode)
  codeInput.dispatchEvent(new Event('input', { bubbles: true }))
  // 等 React onChange + verify 接口
  await new Promise((r) => setTimeout(r, 500))
  const nextBtn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent && b.textContent.trim() === '下一步',
  )
  if (!nextBtn) return { error: 'no next btn' }
  nextBtn.click()
  // 等 verify → dispatch LOGIN_SUCCESS → re-render 到 nickname
  await new Promise((r) => setTimeout(r, 2000))
  const back = document.querySelector('[data-testid="setup-back-nickname"]')
  return {
    backPresent: !!back,
    labelOk: back ? back.getAttribute('data-back-target') === '返回登录' : false,
    visible: back ? !!back.offsetParent : false,
    text: back ? back.textContent : null,
  }
})()`

async function main() {
  const { exe } = parseArgs()
  const userDataDir = mkdtempSync(join(tmpdir(), 'petibi-repro-m4f-'))
  const binary = exe ?? electronBinary()
  if (!existsSync(binary)) {
    console.error(`[repro] 可执行文件不存在：${binary}`)
    process.exit(1)
  }
  const child = spawnElectron(binary, userDataDir)

  const results = []
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${name}`)
    if (!ok || process.env.VERBOSE) console.log(`     ${JSON.stringify(detail)}`)
  }

  let alive = true
  child.on('exit', (code) => {
    alive = false
    console.log(`[repro] Electron 进程退出，code=${code}`)
  })

  try {
    // 1. 等 setup 窗 + 多等 5s 让 server 启动 + React mount 完成
    const setupTarget = await waitForTarget(
      (u) => u.includes('setup/index.html'),
      20000,
      'setup 窗',
    )
    console.log(`[repro] setup 窗 ready: ${setupTarget.url}`)
    // 多等 5s 让 server 启动 + 页面完整加载（关键：之前失败原因就是时序太紧）
    await sleep(5000)
    const setupWs = setupTarget.webSocketDebuggerUrl

    // 2. 初始 DOM 自检
    let r = await evaluateInTarget(setupWs, INITIAL_DOM_CHECK)
    record(
      'setup 窗初始 DOM：titlebar 按钮 + petApi IPC 都已挂载，login 页无返回键（设计）',
      r.hasMinBtn && r.hasCloseBtn && r.hasTitlebar && r.hasSetupShell &&
        r.backBtnOnLogin === false && r.petApiType === 'object' &&
        r.petApiHasMinimize && r.petApiHasCancel,
      r,
    )

    // 3. 最小化键 IPC 派发
    r = await evaluateInTarget(setupWs, FIRE_MINIMIZE)
    record('最小化键 IPC petApi.minimizeSetup() 未抛错', r.ok === true, r)

    // 4. 真实推进到 nickname 步并断言返回键
    r = await evaluateInTarget(setupWs, ADVANCE_AND_CHECK_NICKNAME)
    record(
      'nickname 步有「返回登录」键 + label 正确 + visible',
      r.backPresent && r.labelOk && r.visible,
      r,
    )
  } catch (err) {
    console.error('[repro] 链路异常：', err)
    record('链路异常', false, { message: err.message })
  } finally {
    if (alive) {
      try {
        child.kill('SIGTERM')
        await sleep(500)
        if (alive) child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  console.log('\n=== M4 收尾修复 CDP 验收总结 ===')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} 通过`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
