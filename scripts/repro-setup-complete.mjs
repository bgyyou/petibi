// 【文件说明】P0-006 主进程级复现/回归脚本：真实跑起 Electron，走 setup:complete 链路，
// 断言"点完成 → setup 窗关闭 → 桌宠窗出现 → 进程不退出"；
// 同时在 setup 窗里跑一遍真实 API 链路（GET /api/me 动物名 + POST /api/me/feedback），
// 一次运行覆盖 owner 实测的三个 bug。
//
// 为什么需要它：P0-006（点「完成，去和我的桌宠玩」整个应用退出）前两轮都在渲染进程
// reducer 层排查，没打中——真实触发点在主进程窗口生命周期里。vitest 跑不了真实 Electron
// 窗口链路，所以这里用 CDP（--remote-debugging-port）远程驱动 setup 窗执行
// window.petApi.completeSetup()，再观察主进程是否退出。
//
// 用法：
//   node scripts/repro-setup-complete.mjs                       # 跑 out/main（electron-vite build 产物）
//   node scripts/repro-setup-complete.mjs --exe release/win-unpacked/Petibi.exe   # 跑安装版产物
//
// 退出码：0 = 通过（应用存活 + 桌宠窗出现）；1 = 复现到 bug（应用退出）或链路异常。
//
// 隔离性：每次跑用独立的 --user-data-dir 临时目录（保证走 initial setup 分支，
// 不污染真实用户档案），跑完删除。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/** 解析命令行 --exe（可选）：不传则用 node_modules 里的 electron 跑仓库根 */
function parseArgs() {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--exe')
  const exe = idx >= 0 ? args[idx + 1] : null
  return { exe: exe ? resolve(projectRoot, exe) : null }
}

/** 取 node_modules/electron 的可执行文件绝对路径 */
function electronBinary() {
  const pathTxt = join(projectRoot, 'node_modules', 'electron', 'path.txt')
  const rel = readFileSync(pathTxt, 'utf-8').trim()
  return join(projectRoot, 'node_modules', 'electron', 'dist', rel)
}

const DEBUG_PORT = 9333

/** 轮询 CDP /json/list，直到出现 url 匹配 predicate 的页面 target（或超时） */
async function waitForTarget(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const hit = targets.find((t) => t.type === 'page' && predicate(String(t.url)))
      if (hit) return hit
    } catch {
      // devtools 端口还没起来，继续轮询
    }
    await sleep(300)
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`)
}

/** 判断某个 target 是否已消失（窗口关闭） */
async function targetGone(predicate) {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    const targets = await res.json()
    return !targets.some((t) => t.type === 'page' && predicate(String(t.url)))
  } catch {
    // 端口不可用 = 进程已退出，按"消失"处理（外层另有 alive 判定）
    return true
  }
}

/** 通过 CDP 在目标页面执行一段 JS（Runtime.evaluate） */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 在 setup 窗渲染进程里跑一遍真实 API 链路（打包版自验用）：
 *   登录 → 写档 ENTP → GET /api/me（动物名应为"狐狸"而非兜底"未知"）
 *        → POST /api/me/feedback（修复前 404）。
 * 走渲染进程而不是脚本直连，是因为端口可能被顺延，baseURL 只有 renderer 通过
 * petApi.getServerBaseUrl() 才拿得到（主进程 additionalArguments 注入）。
 */
const API_CHAIN_EXPRESSION = `(async () => {
  const base = window.petApi.getServerBaseUrl()
  const email = 'repro-' + Date.now() + '@example.com'
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
  await j('POST', '/api/me/profile', { nickname: '阿狐', mbti: 'ENTP', subtype: 'stable' }, token)
  const me = await j('GET', '/api/me', null, token)
  const fb = await j('POST', '/api/me/feedback', { mbti: 'ENTP', subtype: 'stable', accepted: false, comment: '实测反馈' }, token)
  return JSON.stringify({
    baseURL: base,
    animal: me.body && me.body.animal,
    petName: me.body && me.body.pet_name,
    feedbackStatus: fb.status,
    feedbackOk: fb.body && fb.body.ok,
  })
})()`

async function main() {
  const { exe } = parseArgs()
  const userDataDir = mkdtempSync(join(tmpdir(), 'petibi-repro-'))
  const binary = exe ?? electronBinary()
  if (!existsSync(binary)) {
    console.error(`[repro] 可执行文件不存在：${binary}`)
    process.exit(1)
  }
  // 未打包时第一个参数要给应用目录（仓库根）；打包版直接跑 exe
  const argv = exe
    ? [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${DEBUG_PORT}`]
    : ['.', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${DEBUG_PORT}`]

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
    console.log(`[repro] 主进程退出，code=${code}`)
  })
  child.stdout.on('data', (b) => process.stdout.write(`[main] ${b}`))
  child.stderr.on('data', (b) => process.stdout.write(`[main:err] ${b}`))

  const isSetup = (url) => url.includes('setup/index.html')
  // pet 窗加载的是 renderer 根 index.html（非 setup/panel 子目录）
  const isPet = (url) =>
    url.includes('index.html') && !url.includes('setup/') && !url.includes('panel/')

  let failed = false
  try {
    const setupTarget = await waitForTarget(isSetup, 30000, 'setup 窗')
    console.log(`[repro] setup 窗已就绪：${setupTarget.url}`)

    // 先跑 API 链路（feedback 路由 + 动物名），再触发完成键——顺序与用户真实操作一致：
    // 用户是在结果页先点反馈、再点「完成，去和我的桌宠玩」。
    const apiResult = await evaluateInTarget(setupTarget.webSocketDebuggerUrl, API_CHAIN_EXPRESSION)
    const apiValue = apiResult?.result?.value
    if (typeof apiValue === 'string') {
      const parsed = JSON.parse(apiValue)
      console.log(`[repro] API 链路：${apiValue}`)
      if (parsed.animal !== '狐狸' || parsed.petName !== '狐狸') {
        console.error(`[repro] ❌ ENTP 动物名不是"狐狸"（拿到 ${parsed.animal}/${parsed.petName}）——人格速查卡路径没修好`)
        failed = true
      }
      if (parsed.feedbackStatus !== 200 || parsed.feedbackOk !== true) {
        console.error(`[repro] ❌ POST /api/me/feedback 返回 ${parsed.feedbackStatus}——反馈路由不可用`)
        failed = true
      }
    } else {
      console.error(`[repro] ❌ API 链路执行异常：${JSON.stringify(apiResult)}`)
      failed = true
    }

    // 真实走一次 setup:complete（等价于结果页点「完成，去和我的桌宠玩」的最后一步）
    const evalResult = await evaluateInTarget(
      setupTarget.webSocketDebuggerUrl,
      'typeof window.petApi?.completeSetup === "function" ? (window.petApi.completeSetup(), "sent") : "missing"',
    )
    console.log(`[repro] completeSetup 调用结果：${JSON.stringify(evalResult?.result?.value)}`)

    // 给主进程 5 秒完成 窗口切换 / 退出
    await sleep(5000)

    if (exited) {
      console.error('[repro] ❌ 复现 P0-006：调用 setup:complete 后主进程整个退出了 ' +
        `(exit code=${exitCode})`)
      failed = true
    } else {
      const setupClosed = await targetGone(isSetup)
      let petUp = false
      try {
        const petTarget = await waitForTarget(isPet, 8000, '桌宠窗')
        petUp = Boolean(petTarget)
        console.log(`[repro] 桌宠窗已出现：${petTarget.url}`)
      } catch (e) {
        console.error(`[repro] ${e.message}`)
      }
      console.log(`[repro] setup 窗已关闭：${setupClosed}；桌宠窗出现：${petUp}；进程存活：true`)
      if (!setupClosed || !petUp) failed = true
      if (!failed) console.log('[repro] ✅ 通过：setup 窗关闭 + 桌宠窗出现 + 应用未退出')
    }
  } catch (err) {
    console.error(`[repro] 链路异常：${err.message}`)
    failed = true
  } finally {
    if (!exited) {
      child.kill('SIGKILL')
      await sleep(800)
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      // 临时目录残留不影响判定（Windows 下 db 文件句柄可能延迟释放）
    }
  }
  process.exit(failed ? 1 : 0)
}

await main()
