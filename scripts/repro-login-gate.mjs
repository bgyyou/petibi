// 【文件说明】M4 P2-025 登录门禁 CDP 安装版验证脚本。
//
// 参考 scripts/repro-setup-complete.mjs 的 CDP（--remote-debugging-port）模式，
// 把"主进程分流 → 开哪个窗口"这条决策在真实 Electron 里跑出来，再用 CDP
// /json/list 枚举窗口 URL，断言 setup / pet / panel 三个 BrowserWindow 的存在性。
//
// 四条路径覆盖（ISSUES P2-025）：
//   1. 无 token / 无 profile         → 应开 setup，无 pet
//   2. 有效 token + 完整 profile     → 应开 pet，无 setup
//   3. 过期 token + 有 profile       → 应开 setup（清 token 在 panel 端走，本脚本仅验证启动分流）
//   4. 访客（guest.json 标记）        → 应开 panel，无 pet，无 setup
//
// 用法：
//   node scripts/repro-login-gate.mjs                 # 跑全部 4 条路径
//   node scripts/repro-login-gate.mjs --exe <path>    # 跑安装版产物
//
// 退出码：0 = 4 条路径全过；1 = 至少一条失败。
//
// 隔离性：每条路径用独立的 --user-data-dir 临时目录，不污染真实用户档案。

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

/** 取 node_modules/electron 的可执行文件绝对路径 */
function electronBinary() {
  const pathTxt = join(projectRoot, 'node_modules', 'electron', 'path.txt')
  const rel = readFileSync(pathTxt, 'utf-8').trim()
  return join(projectRoot, 'node_modules', 'electron', 'dist', rel)
}

const DEBUG_PORT = 9444
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询 CDP /json/list 直到 predicate 命中或超时 */
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

/** 检查当前所有 targets 是否满足某谓词（用于"不应该出现某窗口"的断言） */
async function hasTarget(predicate) {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    const targets = await res.json()
    return targets.some((t) => t.type === 'page' && predicate(String(t.url)))
  } catch {
    return false
  }
}

/** 构造一个 JWT（HS256 + 假签名，仅做 payload.exp 测试用） */
function makeJwt({ email, expInSec }) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({ sub: '1', email, iat: now, exp: now + expInSec }),
  ).toString('base64url')
  return `${header}.${payload}.fake-signature-not-verified-by-test`
}

/**
 * 单条路径的测试。
 * @param scenario 路径标识（用于日志）
 * @param prepare  准备 userData：写入 profile.json / guest.json
 * @param expect   期望出现的窗口 URL 谓词集合（required / forbidden）
 */
async function runScenario({ scenario, prepare, expect, binary }) {
  const userDataDir = mkdtempSync(join(tmpdir(), `petibi-login-gate-${scenario}-`))
  await prepare(userDataDir)

  const argv = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
  ]

  console.log(`\n[repro] === 路径：${scenario} ===`)
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
  const isPanel = (url) => url.includes('panel/index.html')

  let failed = false
  try {
    // 给所有窗口 8s 时间起来
    const foundTargets = { setup: false, pet: false, panel: false }
    for (const [key, pred] of [
      ['setup', isSetup],
      ['pet', isPet],
      ['panel', isPanel],
    ]) {
      try {
        await waitForTarget(pred, 8000, key)
        foundTargets[key] = true
      } catch {
        // 不一定每条都必出现，外层按 expect 判定
      }
    }
    console.log(
      `[repro] 实际出现：setup=${foundTargets.setup} pet=${foundTargets.pet} panel=${foundTargets.panel}`,
    )

    for (const required of expect.required) {
      if (!foundTargets[required]) {
        console.error(`[repro] ❌ 期望出现 ${required} 窗，但没找到`)
        failed = true
      }
    }
    for (const forbidden of expect.forbidden) {
      if (foundTargets[forbidden]) {
        console.error(`[repro] ❌ 不应出现 ${forbidden} 窗，但出现了（违反登录门禁）`)
        failed = true
      }
    }
    if (!failed) {
      console.log(`[repro] ✅ 通过：${scenario}`)
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
  return failed
}

async function main() {
  const { exe } = parseArgs()
  const binary = exe ?? electronBinary()
  if (!existsSync(binary)) {
    console.error(`[repro] 可执行文件不存在：${binary}`)
    process.exit(1)
  }
  console.log(`[repro] 二进制：${binary}`)

  // ===== 路径 1：无 token / 无 profile → 应开 setup，无 pet，无 panel =====
  const path1Failed = await runScenario({
    scenario: 'no-token',
    binary,
    prepare: async () => {
      /* 不写任何文件，profile.json 不存在 */
    },
    expect: {
      required: ['setup'],
      forbidden: ['pet'],
    },
  })

  // ===== 路径 2：有效 token + 完整 profile → 应开 pet，无 setup =====
  const path2Failed = await runScenario({
    scenario: 'valid-token',
    binary,
    prepare: async (userDataDir) => {
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
    },
    expect: {
      required: ['pet'],
      forbidden: ['setup'],
    },
  })

  // ===== 路径 3：过期 token + 有 profile → 应开 setup（pet 不应出现） =====
  const path3Failed = await runScenario({
    scenario: 'expired-token',
    binary,
    prepare: async (userDataDir) => {
      const expiredToken = makeJwt({ email: 'a@b.com', expInSec: -100 })
      writeFileSync(
        join(userDataDir, 'profile.json'),
        JSON.stringify(
          {
            token: expiredToken,
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
    },
    expect: {
      required: ['setup'],
      forbidden: ['pet'],
    },
  })

  // ===== 路径 4：访客（guest.json 标记） → 应开 panel，无 pet，无 setup =====
  const path4Failed = await runScenario({
    scenario: 'guest',
    binary,
    prepare: async (userDataDir) => {
      writeFileSync(
        join(userDataDir, 'guest.json'),
        JSON.stringify({ isGuest: true }, null, 2),
        { mode: 0o600 },
      )
    },
    expect: {
      required: ['panel'],
      forbidden: ['pet', 'setup'],
    },
  })

  const failed = path1Failed || path2Failed || path3Failed || path4Failed
  if (failed) {
    console.error('\n[repro] ❌ 至少一条路径失败')
    process.exit(1)
  }
  console.log('\n[repro] ✅ 全部 4 条路径通过')
}

await main()
