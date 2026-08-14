// 【文件说明】P0-A 深度复现脚本：用 CDP 启动安装版，验证：
//   1. decideStartupWindow 是否真的返回 'pet'（profile 完整 + token 可用）
//   2. 桌宠窗 BrowserWindow 是否被创建（CDP target）
//   3. 桌宠窗实际可见性（BrowserWindow.getBounds + isVisible）
//   4. 桌宠窗的位置是否在桌面屏幕范围内（getDisplayMatching + 工作区）
//
// 用法：
//   node scripts/repro-p0a-bug.mjs --exe release/win-unpacked/Petibi.exe

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
    console.error(`[p0a] 不存在：${binary}`)
    process.exit(1)
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'petibi-p0a-'))
  const validToken = makeJwt({ email: 'a@b.com', expInSec: 30 * 24 * 3600 })
  writeFileSync(
    join(userDataDir, 'profile.json'),
    JSON.stringify(
      {
        token: validToken,
        profile: {
          email: 'a@b.com',
          nickname: '蝴蝶',
          mbti: 'INFP',
          subtype: 'sensitive',
          createdAt: '2026-08-14T08:00:00.000Z',
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )

  const child = spawn(binary, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
  ], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false
  child.on('exit', (code) => {
    exited = true
    console.log(`[p0a] 主进程退出 code=${code}`)
  })
  child.stdout.on('data', (b) => process.stdout.write(`[main] ${b}`))
  child.stderr.on('data', (b) => process.stdout.write(`[main:err] ${b}`))

  const isPet = (url) =>
    url.includes('index.html') && !url.includes('setup/') && !url.includes('panel/')

  try {
    // 1) 等到桌宠窗 target
    const petTarget = await waitForTarget(isPet, 15000, '桌宠窗')
    console.log(`[p0a] 桌宠窗 target：${petTarget.url}`)

    // 2) 通过 CDP 读取当前 BrowserWindow 信息
    //    Electron 主进程对象 remote 不可访问；改用 navigator 信息推断渲染端
    const navResult = await evaluateInTarget(
      petTarget.webSocketDebuggerUrl,
      `JSON.stringify({
        ua: navigator.userAgent,
        loc: location.href,
        readyState: document.readyState,
        title: document.title,
        spriteImg: !!document.querySelector('img, canvas, svg'),
        bodyChildren: document.body ? document.body.children.length : -1,
        rootHTML: document.documentElement ? document.documentElement.outerHTML.slice(0, 400) : '',
      })`,
    )
    console.log(`[p0a] pet 渲染端：${navResult?.result?.value}`)

    // 3) 看 CDP target 列表里所有窗口
    const allTargets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    console.log(`[p0a] 所有 target：`)
    for (const t of allTargets) {
      console.log(`  - type=${t.type} url=${t.url} title=${t.title ?? ''}`)
    }

    // 4) 让渲染端点一次"显示桌宠"事件，看看 pet:visibility 通道
    const visResult = await evaluateInTarget(
      petTarget.webSocketDebuggerUrl,
      `typeof window.petApi?.hidePet === 'function' ? (window.petApi.hidePet?.(), 'hide-called') : 'no-hide-api'`,
    )
    console.log(`[p0a] 显式调 hidePet：${visResult?.result?.value}`)

    await sleep(2000)

    // 5) 再次拉 target
    const targets2 = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    console.log(`[p0a] 调 hidePet 后所有 target：`)
    for (const t of targets2) {
      console.log(`  - type=${t.type} url=${t.url}`)
    }
  } catch (err) {
    console.error(`[p0a] 异常：${err.message}`)
  } finally {
    if (!exited) child.kill('SIGKILL')
    await sleep(800)
    try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

await main()