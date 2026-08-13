// 【文件说明】Express 应用工厂：拼装中间件 + 路由 + 错误处理（合并自 M2 工单 app.ts）
// 设计要点：
//   - 工厂函数 createApp(deps) 返回 Express 实例，便于 supertest 直接喂入（不监听端口）
//   - 中间件顺序：cors → json → 路由 → 404 → errorHandler
//   - 错误处理统一把 AppError 与未捕获错误转成标准 JSON 响应
//   - 鉴权通过 requireAuth 中间件按路由粒度挂载，避免耦合
//   - /api/chat 走 SSE，不属于普通 JSON 响应通道，路由内部自行处理错误
//   - M4 工单：新增 /api/posters 社区广场路由 + /privacy /terms 合规页面静态路由

import express, { type Express, type NextFunction, type Request, type Response } from "express"
import cors from "cors"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { Db } from "./db.js"
import type { ServerConfig } from "./config.js"
import type { Mailer } from "./mailer.js"
import { AppError, ErrorCodes, type ApiResponse, type ErrorCode } from "./errors.js"
import { requireAuth } from "./middleware.js"
import { createAuthRouter } from "./routes/auth.js"
import { createMeRouter } from "./routes/me.js"
import { createQuotaRouter } from "./routes/quota.js"
import { createChatRouter } from "./routes/chat.js"
import { createPostersRouter, createMeShareCountRouter } from "./routes/posters.js"
import { createModerationProvider, type ModerationProvider } from "./moderation.js"

/** createApp 依赖注入集合 */
export interface AppDeps {
  db: Db
  config: ServerConfig
  mailer: Mailer
  /** M4 工单：内容审核 Provider；不传则 createModerationProvider() 工厂读 env */
  moderation?: ModerationProvider
}

/**
 * 构造 Express app，不 listen；测试场景直接 supertest(app) 即可。
 */
export function createApp(deps: AppDeps): Express {
  const { db, config, mailer } = deps
  const moderation = deps.moderation ?? createModerationProvider()
  const app = express()

  // 通用中间件：跨域放行（本地 + 桌宠客户端调用方便；生产可收紧 origin）
  app.use(cors())
  // JSON body 解析：限 1MB，对话 question 不该超过几 KB
  app.use(express.json({ limit: "1mb" }))

  // 健康检查：直接 200，便于 dev / 测试联调
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, env: config.env })
  })

  // ----- M4 合规页面（红线 R8）：隐私政策 / 用户协议 -----
  // 直接挂两个 GET 路由，返回 server/public/{privacy,terms}.html。
  // 路径解析：server/src/app.ts → ../public/...
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public")
  app.get("/privacy", (_req, res) => {
    res.sendFile(join(publicDir, "privacy.html"))
  })
  app.get("/terms", (_req, res) => {
    res.sendFile(join(publicDir, "terms.html"))
  })
  // M4 海报图片静态托管（避免 404 让前端拿到 path 没法展示）
  app.use("/data/posters", express.static(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "posters")))

  // 公开路由（不需要 token）
  // 注意 mount 点与 router 内部路径拼接：mount="/api/auth"，内部 "/email/code" → 完整 "/api/auth/email/code"
  app.use("/api/auth", createAuthRouter({ db, config, mailer }))

  // 鉴权路由：先 requireAuth，再分发到业务路由
  // requireAuth 工厂注入 secret，单测可注入固定 secret 保证可重入
  const auth = requireAuth(config.jwtSecret)
  app.use("/api/me", auth, createMeRouter({ db }))
  // M4：分享计数路由（鉴权，挂在 /api/me 下）
  app.use("/api/me", auth, createMeShareCountRouter({ db }))
  app.use("/api/quota", auth, createQuotaRouter({ db, config }))
  app.use(
    "/api/chat",
    auth,
    createChatRouter({ db, llm: config.llm, dailyQuota: config.dailyQuota }),
  )
  // M4：社区广场路由。GET /api/posters（广场列表）与 GET /api/posters/:id/comments（留言列表）公开；
  // 其他端点（POST 上传/点赞/留言）在路由内部按需挂载 auth 中间件。
  app.use("/api/posters", createPostersRouter({ db, config, moderation, auth }))

  // 404 兜底：未被任何路由命中
  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: { code: ErrorCodes.NotFound, message: `路径不存在：${req.method} ${req.path}` },
    } satisfies ApiResponse<never>)
  })

  // 统一错误处理：所有 next(err) 汇聚到这里
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      // extra 字段用于冷却剩余秒数等上下文；不传则保持纯 code+message
      const errorBody: { code: ErrorCode; message: string; extra?: Record<string, unknown> } = {
        code: err.code,
        message: err.message,
      }
      if (err.extra) errorBody.extra = err.extra
      res.status(err.status).json({
        ok: false,
        error: errorBody,
      } satisfies ApiResponse<never>)
      return
    }
    // 未捕获：不要把堆栈泄露出去
    console.error("[server] 未捕获错误：", err)
    res.status(500).json({
      ok: false,
      error: {
        code: ErrorCodes.Internal,
        message: err instanceof Error ? err.message : "服务器内部错误",
      },
    } satisfies ApiResponse<never>)
  })

  return app
}