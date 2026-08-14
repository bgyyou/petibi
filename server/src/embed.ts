// 【文件说明】服务器内嵌入口（M4 工单：把 server 嵌入 Electron 主进程）
//
// 设计目标：
//   - 不破坏现有 server/src/index.ts 的 CLI 入口（tsx / pm2 部署照常可用）；
//   - 暴露 startServer() 给主进程在 app.whenReady 内同步启动 HTTP 服务；
//   - 端口冲突自动顺延（8787→8788-8790→随机端口），并把最终端口回告主进程；
//   - 数据库文件、静态资源目录全部支持外部注入，便于 Electron prod 落到 userData；
//   - 优雅关停：close() 停 HTTP 接收新连接，再关 DB。
//
// 用法（主进程）：
//   const { startServer } = require('./server.cjs')
//   const handle = await startServer({ host: '127.0.0.1', port: 8787,
//                                       dbPath: '<userData>/chat.db',
//                                       publicDir: '<resources>/server/public',
//                                       postersDir: '<userData>/posters' })
//   console.log('listening on', handle.port)
//   ...
//   await handle.close()  // 应用退出时

import type { Server } from "node:http"
import { loadConfig, type ServerConfig } from "./config.js"
import { openDb, ensureSchema, type Db } from "./db.js"
import { createMailer } from "./mailer.js"
import { createApp } from "./app.js"

/** startServer 覆盖项：未传字段则从 env / 默认值推断 */
export interface StartServerOptions {
  host?: string
  port?: number
  dbPath?: string
  /** 静态资源（privacy.html / terms.html）所在目录；不传则走 import.meta.url 推算 */
  publicDir?: string
  /** 海报图片存放目录（/data/posters 静态托管）；不传则走 import.meta.url 推算 */
  postersDir?: string
  /** 人格速查卡目录（data/personas）；打包内嵌场景必须传绝对路径，
   *  否则 CJS bundle 里 import.meta.url 为空导致速查卡读不到（动物名退化成"未知"）。 */
  personasDir?: string
  /** 显式 JWT secret；不传则从 env 走 */
  jwtSecret?: string
  /** 端口冲突顺延尝试的端口列表（含 port+1 ... port+N）；默认 port+1..port+4 */
  fallbackPorts?: number[]
  /** 强制 mock LLM（CI / 离线演示） */
  forceMock?: boolean
  /** 注入自定义 mailer；不传则走 config.env 工厂 */
  mailer?: import("./mailer.js").Mailer
  /** 注入自定义 moderation provider；不传则走 factory */
  moderation?: import("./moderation.js").ModerationProvider
}

/** startServer 返回句柄：实际监听端口 + 优雅关闭函数 */
export interface RunningServer {
  port: number
  host: string
  dbPath: string
  publicDir: string
  postersDir: string
  config: ServerConfig
  /** 优雅关停：停 HTTP 接收新连接 → 关 DB */
  close: () => Promise<void>
}

/**
 * 启动服务器。
 * - 端口 8787 默认；冲突则按 fallbackPorts 顺延（默认 port+1..port+4），
 *   全失败则用 OS 随机空闲端口（端口号 0 让系统分配）。
 * - 返回 { port, host, close }，调用方在 app 退出时调 close() 即可。
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  // 第一步：合并 config（先用占位 host/port 让 config 工厂跑通，再用 startServer 调用方覆盖）
  const config = loadConfig({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8787,
    dbPath: options.dbPath,
    jwtSecret: options.jwtSecret,
    env: process.env["PETIBI_EMBED"] === "1" ? "dev" : (process.env["PETIBI_ENV"] as ServerConfig["env"] | undefined) ?? "dev",
    llm: options.forceMock !== undefined
      ? { forceMock: options.forceMock }
      : undefined,
  })

  const host = options.host ?? config.host
  const preferredPort = options.port ?? config.port

  // 第二步：解析 publicDir / postersDir 注入
  // 优先级：options > config 里新增字段 > 后续在 app.ts 内的 import.meta.url 兜底
  // 这里直接把两个路径塞进 AppDeps，app.ts 优先用 override。
  // 路径解析交给调用方（embed 场景下由 main.ts 决定 userData / resources 路径）。

  // 第三步：建 DB + Mailer + App
  // personasDir 同步塞进 env：chat 路由内部直接调 loadPersonaCard（没有 deps 通道），
  // 靠 PETIBI_PERSONAS_DIR 兜住，保证 prompt 人格层在打包版里也能读到速查卡。
  if (options.personasDir) {
    process.env["PETIBI_PERSONAS_DIR"] = options.personasDir
  }
  const db: Db = openDb(config.dbPath)
  ensureSchema(db)
  const mailer = options.mailer ?? createMailer(config)
  const app = createApp({
    db,
    config,
    mailer,
    moderation: options.moderation,
    publicDirOverride: options.publicDir,
    postersDirOverride: options.postersDir,
    personasDirOverride: options.personasDir,
  })

  // 第四步：监听端口（带冲突顺延）
  const fallbackPorts = options.fallbackPorts ?? buildFallbackPorts(preferredPort, 4)
  const tried: number[] = []
  let server: Server | null = null
  let chosenPort = 0

  const listenOn = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const s = app.listen(port, host, () => resolve(s))
      s.once("error", (err: NodeJS.ErrnoException) => {
        // EADDRINUSE: 端口占用；其他错误直接 reject
        if (err.code === "EADDRINUSE") {
          reject({ code: "EADDRINUSE", port })
        } else {
          reject(err)
        }
      })
    })

  // 1) 优先 preferredPort
  try {
    server = await listenOn(preferredPort)
    chosenPort = preferredPort
  } catch (err) {
    if (!isAddrInUse(err)) throw err
    tried.push(preferredPort)
    // 2) 顺延 fallbackPorts
    for (const p of fallbackPorts) {
      try {
        server = await listenOn(p)
        chosenPort = p
        break
      } catch (e) {
        if (!isAddrInUse(e)) throw e
        tried.push(p)
      }
    }
    // 3) 都失败：让系统分配空闲端口（port=0）
    if (!server) {
      server = await listenOn(0)
      const addr = server.address()
      chosenPort = typeof addr === "object" && addr ? addr.port : 0
      console.warn(
        `[server:embed] 端口 ${preferredPort} 与顺延 ${fallbackPorts.join(",")} 全部占用，改用系统分配端口 ${chosenPort}`,
      )
    }
  }

  if (!server) {
    // 不可达（上面已经处理所有失败路径）；TS 收敛
    throw new Error("[server:embed] 启动失败：未监听到任何端口")
  }

  if (tried.length > 0) {
    console.log(
      `[server:embed] 端口 ${tried.join(",")} 被占用，最终监听 ${host}:${chosenPort}`,
    )
  } else {
    console.log(
      `Petibi server (embedded) listening on http://${host}:${chosenPort} (env=${config.env})`,
    )
  }
  if (config.env === "dev" || process.env["PETIBI_EMBED"] === "1") {
    console.log(
      `[server:embed] dev 模式：验证码会直接返回在 /api/auth/email/code 响应里 + 打日志；db=${config.dbPath}`,
    )
  }
  console.log(
    `[server:embed] mock mode = ${!config.llm.apiKey || config.llm.forceMock}`,
  )

  // 第五步：返回句柄
  const running: RunningServer = {
    port: chosenPort,
    host,
    dbPath: config.dbPath,
    publicDir: options.publicDir ?? "",
    postersDir: options.postersDir ?? "",
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server!.close(() => {
          try {
            db.close()
          } catch (e) {
            console.error("[server:embed] 关闭 db 失败：", e)
          }
          resolve()
        })
        // 兜底：3 秒后强 resolve（避免 close 回调不触发时挂起主进程退出）
        setTimeout(() => resolve(), 3000).unref()
      }),
  }
  return running
}

/** EADDRINUSE 类型守卫：避免散落的 (err as any).code */
function isAddrInUse(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "EADDRINUSE")
}

/** 构造顺延端口列表：默认 [port+1, port+2, port+3, port+4]，去重且 ≤ 65535 */
function buildFallbackPorts(preferred: number, count: number): number[] {
  const out: number[] = []
  for (let i = 1; i <= count; i++) {
    const p = preferred + i
    if (p > 0 && p < 65536) out.push(p)
  }
  return out
}