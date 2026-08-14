// 【文件说明】统一加载仓库根 .env：CLI 入口（server/src/index.ts）、内嵌入口
// （server/src/embed.ts）与 Electron 主进程（electron/main.ts）都会调一次，
// 把 .env 里的 DEEPSEEK_* / PETIBI_* / FORCE_MOCK 注入 process.env。
//
// 设计取舍：
//   - 选 dotenv 而非手写解析：仓库 node_modules 已经有 dotenv 16.6.1（被 dotenv-expand
//     拉进来），引入零成本；同时 .env.example 里保留 # 注释 / 空行 / 引号都靠它处理。
//   - 强制从仓库根读 .env：不依赖 cwd，便于从任意目录 `tsx server/src/index.ts` 启动也能
//     找到。打包内嵌场景下走 process.resourcesPath 或 __dirname/../.. 推算。
//   - 重复加载幂等：dotenv 默认不覆盖已有 env（除非 override=true），第二次调用安全。
//   - 失败兜底：缺文件/读不动时静默跳过（dev 不一定配了 .env；CI / 测试环境亦可能没有），
//     仅 console.log 一行提示，不让启动流程因此崩。
//
// 边界：API key 仅活在 process.env；本文件不读 / 不打印任何 key；调用方按 env 字段读取。

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type DotenvLike = {
  config: (opts: { path?: string; quiet?: boolean; debug?: boolean }) => {
    parsed?: Record<string, string>
    error?: Error
  }
}

/**
 * 用 createRequire 拿 dotenv，避免 server 之外的位置（electron 主进程、scripts/*）
 * 把 dotenv 当强依赖写进自己的 import 列表。本函数内 require 是惰性的，仅在第一次调用时执行。
 *
 * createRequire 的文件名优先 __filename（CJS bundle 一定有），回退 import.meta.url
 * （tsx / vitest 等 ESM 上下文）。这样：
 *   - CJS bundle：__filename 存在 → createRequire(__filename) 正常；
 *   - ESM/TSX   ：__filename 不存在 → createRequire(import.meta.url) 正常。
 */
function loadDotenvModule(): DotenvLike | null {
  try {
    const baseUrl =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      typeof __filename !== "undefined" ? (__filename as unknown as string) : (import.meta as any).url
    const req = createRequire(baseUrl)
    const projectRoot = join(dirname(fileURLToPath(baseUrl)), "..", "..")
    return req(join(projectRoot, "node_modules", "dotenv")) as DotenvLike
  } catch {
    return null
  }
}

/**
 * 在若干候选路径里找到第一个存在的 .env，按顺序尝试：
 *   1) 调用方显式传入的 path（绝对）
 *   2) 仓库根向上两级的 .env（server/src/ → 仓库根）
 *   3) process.cwd()/.env（开发场景 cd 到仓库根跑 npm run server:dev 时命中）
 *   4) Electron 内嵌场景由 caller 显式传 path（main.ts 推 resourcesPath 或 __dirname）
 * 返回找到的绝对路径；找不到返回 null。
 */
export function resolveEnvPath(override?: string): string | null {
  const candidates: string[] = []
  if (override) candidates.push(override)
  // server/src/env.ts → 仓库根（仅 ESM/tsx 路径下有效；CJS bundle 走 override / cwd）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseUrl = typeof __filename !== "undefined" ? (__filename as unknown as string) : (import.meta as any).url
  if (baseUrl) {
    try {
      candidates.push(join(dirname(fileURLToPath(baseUrl)), "..", "..", ".env"))
    } catch {
      // fileURLToPath 失败（CJS 下 __filename 形态）→ 跳过该候选
    }
  }
  candidates.push(join(process.cwd(), ".env"))
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 把仓库根 .env 加载进 process.env。返回是否实际加载成功。
 *   - 静默缺文件：loadConfig 兜底默认仍在，dev / CI / 测试都不需要 .env。
 *   - 加载成功：在 console 打一行 [env] loaded from <path>，方便确认到底读了哪个文件。
 *   - 不暴露任何 key：路径与键名都不打日志；只打行数统计。
 */
export function loadProjectEnv(override?: string): boolean {
  const envPath = resolveEnvPath(override)
  if (!envPath) return false
  const dotenv = loadDotenvModule()
  if (!dotenv) {
    // dotenv 不在：退化为手写解析（10 行内）。
    const parsed = parseDotenvManually(envPath)
    if (parsed) applyParsedEnv(parsed)
    return parsed !== null
  }
  const result = dotenv.config({ path: envPath, quiet: true })
  if (result.error) {
    // dotenv 自己出错（极少，权限不足时会触发）→ 静默兜底
    const parsed = parseDotenvManually(envPath)
    if (parsed) applyParsedEnv(parsed)
    return parsed !== null
  }
  const keys = Object.keys(result.parsed ?? {})
  console.log(`[env] loaded ${keys.length} keys from ${envPath}`)
  return true
}

/**
 * 手写 .env 解析（dotenv 不可用时的兜底，10 行内）：
 *   - 支持 KEY=VALUE 单行
 *   - 支持 # 注释与空行
 *   - 支持双/单引号包裹（去掉外层引号）
 *   - 注释必须以 # 开头（行内 # 不识别，简化实现）
 * 不支持转义、多行 value——这些场景用 dotenv 即可，不影响 Petibi 现有 .env.example 形态。
 */
function parseDotenvManually(path: string): Record<string, string> | null {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return null
  }
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** 应用解析结果到 process.env（不覆盖已有 env；与 dotenv 默认行为一致） */
function applyParsedEnv(parsed: Record<string, string>): void {
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
  console.log(`[env] loaded ${Object.keys(parsed).length} keys (fallback parser)`)
}