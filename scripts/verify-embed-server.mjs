// 【文件说明】内嵌 server（prod 路径）集成自验脚本：直接 require 打包产物 dist/server/server.cjs，
// 按主进程的方式 startServer()，跑通两条 owner 实测出问题的链路：
//   1. POST /api/me/feedback —— 反馈落库（之前 server 没这个路由，实测 404）；
//   2. GET  /api/me 的 animal / pet_name —— 打包后读 data/personas 失败会退化成"未知/伙伴"。
//
// 为什么不用 vitest：vitest 跑的是 TS 源码（ESM，import.meta.url 正常），
// 而 owner 遇到的问题只在 esbuild CJS bundle 里才出现（import.meta.url 被替换成空串）。
// 只有 require 真实 bundle 才能验证"打包后路径注入"这条修复。
//
// 用法：
//   node scripts/build-server.mjs                      # 先出 bundle
//   node scripts/verify-embed-server.mjs               # 注入 personasDir（= 修复后主进程行为）
//   node scripts/verify-embed-server.mjs --no-personas-dir   # 不注入（= 修复前行为，用于对照复现）
//
// 退出码：0 = 全部断言通过；1 = 有断言失败。

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

const injectPersonas = !process.argv.includes('--no-personas-dir')
const bundlePath = join(projectRoot, 'dist', 'server', 'server.cjs')
const personasDir = join(projectRoot, 'data', 'personas')

const failures = []
/** 断言：失败只记录不抛出，让脚本跑完所有检查项再统一汇报 */
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}：${JSON.stringify(actual)}${ok ? '' : ` （期望 ${JSON.stringify(expected)}）`}`)
  if (!ok) failures.push(label)
}

/** 带 JSON body 的 fetch 简封装：返回 { status, body } */
async function api(baseURL, method, path, { token, body } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${baseURL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'petibi-embed-verify-'))
  // 干净环境：确保 env 不残留（否则 --no-personas-dir 的对照组会被 env 兜住）
  delete process.env['PETIBI_PERSONAS_DIR']
  process.env['PETIBI_EMBED'] = '1'
  // 与 electron/main.ts startServerInMain 保持一致地注入其余 data/* 路径，
  // 否则 bundle 里的敏感词库 / 意图过滤 / 拒绝模板同样会因 import.meta.url 为空而失效。
  const dataRoot = join(projectRoot, 'data')
  process.env['PETIBI_SENSITIVE_WORDS_PATH'] = join(dataRoot, 'sensitive-words.json')
  process.env['PETIBI_INTENT_FILTER_PATH'] = join(dataRoot, 'intent-filter.json')
  process.env['PETIBI_REFUSALS_PATH'] = join(dataRoot, 'refusals.json')
  process.env['PETIBI_ENCYCLOPEDIA_INDEX_PATH'] = join(dataRoot, 'encyclopedia', 'index.json')
  process.env['PETIBI_ENCYCLOPEDIA_DIR'] = join(dataRoot, 'encyclopedia')

  const { startServer } = require(bundlePath)
  const options = {
    host: '127.0.0.1',
    // 避开 8787（用户可能正跑着 Petibi 实例）；冲突时 startServer 内部会顺延
    port: 8899,
    dbPath: join(userData, 'chat.db'),
    publicDir: join(projectRoot, 'server', 'public'),
    postersDir: join(userData, 'posters'),
    jwtSecret: 'petibi-verify-secret',
    forceMock: true,
  }
  if (injectPersonas) options.personasDir = personasDir

  console.log(`[verify] bundle：${bundlePath}`)
  console.log(`[verify] personasDir 注入：${injectPersonas ? personasDir : '（不注入，模拟修复前）'}`)
  const server = await startServer(options)
  const baseURL = `http://${server.host}:${server.port}`
  console.log(`[verify] server：${baseURL}`)

  try {
    // ---- 登录 + 写档成 ENTP ----
    const email = `verify-${Date.now()}@example.com`
    const codeRes = await api(baseURL, 'POST', '/api/auth/email/code', { body: { email } })
    const devCode = codeRes.body.devCode
    const verifyRes = await api(baseURL, 'POST', '/api/auth/email/verify', {
      body: { email, code: devCode },
    })
    const token = verifyRes.body.token
    await api(baseURL, 'POST', '/api/me/profile', {
      token,
      body: { nickname: '阿狐', mbti: 'ENTP', subtype: 'stable' },
    })

    // ---- 链路 A：GET /api/me 动物名（Bug 3）----
    console.log('\n[verify] 链路 A：GET /api/me 动物名（ENTP 应为 狐狸）')
    const me = await api(baseURL, 'GET', '/api/me', { token })
    check('GET /api/me 状态码', me.status, 200)
    if (injectPersonas) {
      check('animal', me.body.animal, '狐狸')
      check('pet_name', me.body.pet_name, '狐狸')
    } else {
      // 对照组：不注入路径时 bundle 内 import.meta.url 为空 → 兜底文案（即 owner 实测现象）
      check('animal（未注入路径的兜底现象）', me.body.animal, '未知')
      check('pet_name（未注入路径的兜底现象）', me.body.pet_name, '伙伴')
    }

    // ---- 链路 B：POST /api/me/feedback（Bug 1）----
    console.log('\n[verify] 链路 B：POST /api/me/feedback')
    const fbYes = await api(baseURL, 'POST', '/api/me/feedback', {
      token,
      body: { mbti: 'ENTP', subtype: 'stable', accepted: true },
    })
    check('「很符合」状态码（修复前是 404）', fbYes.status, 200)
    check('「很符合」ok 字段', fbYes.body.ok, true)
    check('「很符合」recorded_at 类型', typeof fbYes.body.recorded_at, 'string')

    const fbNo = await api(baseURL, 'POST', '/api/me/feedback', {
      token,
      body: { mbti: 'ENTP', subtype: 'stable', accepted: false, comment: '第 3 题不像我' },
    })
    check('「测的不准」状态码', fbNo.status, 200)

    const fbBad = await api(baseURL, 'POST', '/api/me/feedback', {
      token,
      body: { mbti: 'ENTP', subtype: 'stable' },
    })
    check('缺 accepted → 400', fbBad.status, 400)
    check('缺 accepted 的错误码', fbBad.body.error?.code, 'INVALID_FEEDBACK')

    const fbNoAuth = await api(baseURL, 'POST', '/api/me/feedback', {
      body: { mbti: 'ENTP', subtype: 'stable', accepted: true },
    })
    check('未鉴权 → 401', fbNoAuth.status, 401)

    // 直接查库确认落盘（走 node:sqlite 只读打开同一个文件）
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(join(userData, 'chat.db'))
    const rows = db.prepare('SELECT mbti, subtype, accepted, comment FROM test_feedback ORDER BY id').all()
    db.close()
    check('test_feedback 落库行数', rows.length, 2)
    check('第 1 行 accepted', rows[0]?.accepted, 1)
    check('第 2 行 accepted', rows[1]?.accepted, 0)
    check('第 2 行 comment', rows[1]?.comment, '第 3 题不像我')
  } finally {
    await server.close()
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
      // Windows 下 db 句柄延迟释放导致的残留不影响判定
    }
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`[verify] ❌ ${failures.length} 项断言失败：${failures.join(' / ')}`)
    process.exitCode = 1
    return
  }
  console.log('[verify] ✅ 全部断言通过')
  process.exitCode = 0
}

// 用 exitCode + 自然退出（不用 process.exit）：Windows 上 node:sqlite 句柄尚未完全释放时
// 强制退出会触发 libuv 的 UV_HANDLE_CLOSING 断言，把退出码搞成 127，让 CI 误判失败。
await main()
