// 【文件说明】社区广场 + 内容审核管道路由（M4 工单）
//
// 路由清单：
//   POST /api/posters            上传海报（鉴权；图片存 server/data/posters/，先入 pending → 审核 → approved 上墙）
//   GET  /api/posters            广场列表（公开；只返 approved，按时间倒序，分页）
//   POST /api/posters/:id/like   幂等点赞/取消（鉴权）
//   POST /api/posters/:id/comments 留言 ≤200 字（鉴权；pending → 审核 → approved 才展示）
//   GET  /api/posters/:id/comments 留言列表（公开；只返 approved）
//   POST /api/me/share-count     分享计数 +1，返回累计数（鉴权；V2 装扮解锁用）
//
// 关键不变量（红线 R7）：
//   - status != 'approved' 的内容**任何列表接口都不可见**（SQL 直接 WHERE status='approved'，不依赖业务代码）
//   - 任何 pending 写入都会同步写一条 moderation_logs 记录（即使 pass 也要留痕，方便后续审计）
//   - 上传图片的 base64 合法性校验失败直接 400，不进审核管道

import { Router, type Request, type Response, type NextFunction, type Router as RouterType, type RequestHandler } from "express"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { AppError, ErrorCodes, type ApiResponse } from "../errors.js"
import type { Db } from "../db.js"
import type { ServerConfig } from "../config.js"
import { userIdFromRequest } from "../middleware.js"
import type { Personality } from "../types.js"
import { type ModerationProvider } from "../moderation.js"

/** 评论字数上限：PRD §3.7 留言 ≤200 字 */
const COMMENT_MAX_LEN = 200

/** 图片 base64 数据前缀白名单：data:image/<sub>;base64,xxx */
const IMAGE_DATA_PREFIX = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i

/** 路由依赖 */
export interface PostersRouterDeps {
  db: Db
  config: ServerConfig
  moderation: ModerationProvider
  /** 鉴权中间件：POST 类端点按需挂载（GET 类端点公开） */
  auth: RequestHandler
  /** 海报图片根目录（绝对路径）。CLI 场景下走 import.meta.url 推算 server/data/posters；
   *  内嵌场景由主进程注入 userData/posters。优先 postersDirOverride。 */
  postersDir?: string
}

/** posters 表行类型（对外 DTO 字段命名沿用下划线与 DB 列对齐） */
interface PosterRow {
  id: number
  user_id: number
  image_path: string
  persona_type: string
  question_excerpt: string
  answer_excerpt: string
  status: "pending" | "approved" | "rejected"
  likes: number
  created_at: string
}

/** comments 表行 */
interface CommentRow {
  id: number
  poster_id: number
  user_id: number
  content: string
  status: "pending" | "approved" | "rejected"
  created_at: string
}

/** 上传海报请求体 */
interface CreatePosterInput {
  image_base64: string
  persona_type: Personality
  question_excerpt: string
  answer_excerpt: string
}

/** 留言请求体 */
interface CreateCommentInput {
  content: string
}

/** 工具：从 base64 data URL 解码出 mime + 二进制，写到 postersDir/<uid>/<ts>.<ext>
 *  返回写盘后的相对路径（始终是 data/posters/<uid>/<filename>，便于静态路由统一读取）。
 *
 *  M4 内嵌兼容：postersDir 由主进程在 startServer 时注入绝对路径；
 *  CLI 场景下若未传，则依赖调用方在路由外部解析（createApp 注入）。
 */
function savePosterImage(
  imageBase64: string,
  userId: number,
  postersRoot: string,
): { relativePath: string; bytes: number } {
  const m = IMAGE_DATA_PREFIX.exec(imageBase64)
  if (!m) {
    throw AppError.badRequest(ErrorCodes.InvalidPoster, "图片格式必须是 data:image/<png|jpg|webp|gif>;base64,... ")
  }
  // m[1] 是 png/jpg/jpeg/webp/gif；统一落盘为原始扩展名
  const ext = m[1] === "jpeg" ? "jpg" : m[1].toLowerCase()
  const buf = Buffer.from(m[2], "base64")
  if (buf.length === 0) {
    throw AppError.badRequest(ErrorCodes.InvalidPoster, "图片 base64 解码为空")
  }
  // 简易大小上限：2MB。更大图片建议前端走对象存储；本项目 MVP 不接 OSS。
  if (buf.length > 2 * 1024 * 1024) {
    throw AppError.badRequest(ErrorCodes.InvalidPoster, "图片不能超过 2MB")
  }
  const userDir = join(postersRoot, String(userId))
  mkdirSync(userDir, { recursive: true })
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const fullPath = join(userDir, filename)
  writeFileSync(fullPath, buf)
  // 相对路径（存 DB；路由读取图片时由静态中间件挂载 /data/posters 即可）
  const relativePath = `data/posters/${userId}/${filename}`
  return { relativePath, bytes: buf.length }
}

/** 写 moderation_logs 记录：每次审核动作（无论 pass/reject）都要落日志，红线 R7 审计用 */
function writeModerationLog(
  db: Db,
  contentType: "poster" | "comment",
  contentId: number,
  userId: number,
  result: { provider: string; decision: "pass" | "reject"; reason: string },
): void {
  db.prepare(
    `INSERT INTO moderation_logs (content_type, content_id, user_id, provider, decision, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(contentType, contentId, userId, result.provider, result.decision, result.reason)
}

/** 公共校验：persona_type 必须是 16 型之一 */
function isValidPersonality(s: unknown): s is Personality {
  if (typeof s !== "string") return false
  return [
    "INTJ", "INTP", "ENTJ", "ENTP",
    "INFJ", "INFP", "ENFJ", "ENFP",
    "ISTJ", "ISFJ", "ESTJ", "ESFJ",
    "ISTP", "ISFP", "ESTP", "ESFP",
  ].includes(s)
}

/**
 * 构造社区广场路由。
 */
export function createPostersRouter(deps: PostersRouterDeps): RouterType {
  const router = Router()
  const { db, config, moderation, auth } = deps

  // 海报图片根目录：postersDir（绝对路径）由 createApp 注入；不传则抛错（避免静默写到错位置）
  if (!deps.postersDir) {
    throw new Error("createPostersRouter: postersDir 未注入（startServer 必须传 postersDir 选项）")
  }
  const postersRoot = deps.postersDir

  // ------------------------------------------------------------------
  // POST / —— 上传海报
  // ------------------------------------------------------------------
  router.post("/", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      const body = (req.body ?? {}) as Partial<CreatePosterInput>

      // 1. 参数校验
      if (typeof body.image_base64 !== "string" || body.image_base64.length === 0) {
        throw AppError.badRequest(ErrorCodes.InvalidPoster, "image_base64 必填")
      }
      if (!isValidPersonality(body.persona_type)) {
        throw AppError.badRequest(ErrorCodes.InvalidPoster, "persona_type 必须是 16 型 MBTI 之一")
      }
      if (typeof body.question_excerpt !== "string" || body.question_excerpt.length === 0) {
        throw AppError.badRequest(ErrorCodes.InvalidPoster, "question_excerpt 必填")
      }
      if (body.question_excerpt.length > 200) {
        throw AppError.badRequest(ErrorCodes.InvalidPoster, "question_excerpt 不能超过 200 字")
      }
      if (typeof body.answer_excerpt !== "string" || body.answer_excerpt.length === 0) {
        throw AppError.badRequest(ErrorCodes.InvalidPoster, "answer_excerpt 必填")
      }
      if (body.answer_excerpt.length > 500) {
        throw AppError.badRequest(ErrorCodes.InvalidPoster, "answer_excerpt 不能超过 500 字")
      }

      // 2. 图片存盘（base64 解码 + 落盘 + 写路径）
      const { relativePath } = savePosterImage(body.image_base64, userId, postersRoot)

      // 3. 入 pending 行（先不审，先占位让审核管道决定 status）
      const insert = db.prepare(
        `INSERT INTO posters (user_id, image_path, persona_type, question_excerpt, answer_excerpt, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      const info = insert.run(
        userId,
        relativePath,
        body.persona_type,
        body.question_excerpt,
        body.answer_excerpt,
      )
      const posterId = Number(info.lastInsertRowid)

      // 4. 走审核管道：question + answer 串起来一起审（任一命中即 reject）
      const combinedText = `${body.question_excerpt}\n${body.answer_excerpt}`
      const textResult = await moderation.moderateText(combinedText)
      const imageResult = await moderation.moderateImage(body.image_base64)

      const finalDecision: "pending" | "approved" | "rejected" =
        textResult.decision === "reject" || imageResult.decision === "reject"
          ? "rejected"
          : "approved"

      const finalReason =
        textResult.decision === "reject"
          ? `text: ${textResult.reason}`
          : imageResult.decision === "reject"
            ? `image: ${imageResult.reason}`
            : "both pass"

      // 5. 写 moderation_logs（先记日志再 UPDATE 状态——即便 UPDATE 失败也能溯源）
      writeModerationLog(db, "poster", posterId, userId, {
        provider: moderation.name,
        decision: finalDecision === "approved" ? "pass" : "reject",
        reason: finalReason,
      })

      // 6. UPDATE posters.status
      db.prepare("UPDATE posters SET status = ? WHERE id = ?").run(finalDecision, posterId)

      // 7. 响应：status + poster_id；rejected 时附 reason（便于前端给用户反馈）
      const resp: { ok: true; poster_id: number; status: "approved" | "rejected" | "pending"; reason?: string } = {
        ok: true,
        poster_id: posterId,
        status: finalDecision,
      }
      if (finalDecision !== "approved") resp.reason = finalReason
      res.json(resp satisfies ApiResponse<typeof resp>)
    } catch (err) {
      next(err)
    }
  })

  // ------------------------------------------------------------------
  // GET / —— 广场列表（公开；只返 approved）
  // ------------------------------------------------------------------
  router.get("/", (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Math.max(Number(req.query["limit"]) || 20, 1), 100)
      const offset = Math.max(Number(req.query["offset"]) || 0, 0)
      const rows = db
        .prepare(
          `SELECT id, user_id, image_path, persona_type, question_excerpt, answer_excerpt,
                  status, likes, created_at
             FROM posters
            WHERE status = 'approved'
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as unknown as PosterRow[]
      const resp = {
        ok: true as const,
        items: rows.map((r) => ({
          id: r.id,
          user_id: r.user_id,
          image_path: r.image_path,
          persona_type: r.persona_type,
          question_excerpt: r.question_excerpt,
          answer_excerpt: r.answer_excerpt,
          likes: r.likes,
          created_at: r.created_at,
        })),
        limit,
        offset,
      }
      res.json(resp)
    } catch (err) {
      next(err)
    }
  })

  // ------------------------------------------------------------------
  // POST /:id/like —— 幂等点赞/取消（鉴权）
  // 行为：
  //   - 若未点赞过：插入 likes 行，posters.likes + 1，返回 { liked: true, likes: N }
  //   - 若已点赞过：删除 likes 行，posters.likes - 1，返回 { liked: false, likes: N }
  //   - 海报不存在：404；海报非 approved：404（不在广场上就不可点赞）
  // ------------------------------------------------------------------
  router.post("/:id/like", auth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      const posterId = Number(req.params["id"])
      if (!Number.isFinite(posterId) || posterId <= 0) {
        throw AppError.badRequest(ErrorCodes.BadRequest, "poster id 非法")
      }
      const poster = db
        .prepare(`SELECT id, status, likes FROM posters WHERE id = ?`)
        .get(posterId) as { id: number; status: string; likes: number } | undefined
      if (!poster || poster.status !== "approved") {
        throw AppError.notFound(ErrorCodes.NotFound, "海报不存在或未审核通过")
      }
      const existing = db
        .prepare(`SELECT user_id FROM likes WHERE user_id = ? AND poster_id = ?`)
        .get(userId, posterId) as { user_id: number } | undefined

      let likedNow: boolean
      db.exec("BEGIN")
      try {
        if (existing) {
          db.prepare(`DELETE FROM likes WHERE user_id = ? AND poster_id = ?`).run(userId, posterId)
          db.prepare(`UPDATE posters SET likes = likes - 1 WHERE id = ? AND likes > 0`).run(posterId)
          likedNow = false
        } else {
          db.prepare(`INSERT INTO likes (user_id, poster_id) VALUES (?, ?)`).run(userId, posterId)
          db.prepare(`UPDATE posters SET likes = likes + 1 WHERE id = ?`).run(posterId)
          likedNow = true
        }
        db.exec("COMMIT")
      } catch (e) {
        db.exec("ROLLBACK")
        throw e
      }
      const updated = db.prepare(`SELECT likes FROM posters WHERE id = ?`).get(posterId) as { likes: number }
      res.json({ ok: true as const, liked: likedNow, likes: updated.likes })
    } catch (err) {
      next(err)
    }
  })

  // ------------------------------------------------------------------
  // POST /:id/comments —— 留言 ≤200 字（鉴权；pending → 审核 → approved）
  // ------------------------------------------------------------------
  router.post("/:id/comments", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      const posterId = Number(req.params["id"])
      if (!Number.isFinite(posterId) || posterId <= 0) {
        throw AppError.badRequest(ErrorCodes.BadRequest, "poster id 非法")
      }
      const body = (req.body ?? {}) as Partial<CreateCommentInput>
      if (typeof body.content !== "string") {
        throw AppError.badRequest(ErrorCodes.BadRequest, "content 必填")
      }
      const trimmed = body.content.trim()
      if (trimmed.length === 0) {
        throw AppError.badRequest(ErrorCodes.BadRequest, "content 不能为空")
      }
      if (trimmed.length > COMMENT_MAX_LEN) {
        throw new AppError(
          400,
          ErrorCodes.CommentTooLong,
          `留言不能超过 ${COMMENT_MAX_LEN} 字`,
          { maxLen: COMMENT_MAX_LEN, actualLen: trimmed.length },
        )
      }
      // 海报必须 approved 才允许留言（pending 上的留言会暴露未通过内容）
      const poster = db
        .prepare(`SELECT id, status FROM posters WHERE id = ?`)
        .get(posterId) as { id: number; status: string } | undefined
      if (!poster || poster.status !== "approved") {
        throw AppError.notFound(ErrorCodes.NotFound, "海报不存在或未审核通过")
      }
      // 入 pending
      const info = db
        .prepare(`INSERT INTO comments (poster_id, user_id, content, status) VALUES (?, ?, ?, 'pending')`)
        .run(posterId, userId, trimmed)
      const commentId = Number(info.lastInsertRowid)
      // 审核
      const result = await moderation.moderateText(trimmed)
      const finalDecision: "approved" | "rejected" = result.decision === "reject" ? "rejected" : "approved"
      writeModerationLog(db, "comment", commentId, userId, {
        provider: moderation.name,
        decision: finalDecision === "approved" ? "pass" : "reject",
        reason: result.reason,
      })
      db.prepare(`UPDATE comments SET status = ? WHERE id = ?`).run(finalDecision, commentId)

      const resp: { ok: true; comment_id: number; status: "approved" | "rejected"; reason?: string } = {
        ok: true,
        comment_id: commentId,
        status: finalDecision,
      }
      if (finalDecision !== "approved") resp.reason = result.reason
      res.json(resp satisfies ApiResponse<typeof resp>)
    } catch (err) {
      next(err)
    }
  })

  // ------------------------------------------------------------------
  // GET /:id/comments —— 留言列表（公开；只返 approved）
  // ------------------------------------------------------------------
  router.get("/:id/comments", (req: Request, res: Response, next: NextFunction) => {
    try {
      const posterId = Number(req.params["id"])
      if (!Number.isFinite(posterId) || posterId <= 0) {
        throw AppError.badRequest(ErrorCodes.BadRequest, "poster id 非法")
      }
      const poster = db
        .prepare(`SELECT id FROM posters WHERE id = ? AND status = 'approved'`)
        .get(posterId) as { id: number } | undefined
      if (!poster) {
        throw AppError.notFound(ErrorCodes.NotFound, "海报不存在或未审核通过")
      }
      const rows = db
        .prepare(
          `SELECT id, user_id, content, status, created_at
             FROM comments
            WHERE poster_id = ? AND status = 'approved'
            ORDER BY created_at ASC, id ASC`,
        )
        .all(posterId) as unknown as CommentRow[]
      res.json({
        ok: true as const,
        items: rows.map((r) => ({
          id: r.id,
          user_id: r.user_id,
          content: r.content,
          created_at: r.created_at,
        })),
      })
    } catch (err) {
      next(err)
    }
  })

  // ------------------------------------------------------------------
  // 路由工厂返回（注意：share-count 路由挂在 /api/me 下，不在本文件）
  // ------------------------------------------------------------------
  return router
}

/**
 * /api/me/share-count 路由（鉴权）：分享计数 +1，返回累计数。
 * 设计：
 *   - 用 UPSERT 思路在 share_counts 表累计（不存在则 INSERT，存在则 UPDATE count = count + 1）
 *   - 返回 { count: N }，V2 装扮解锁依赖此字段
 */
export function createMeShareCountRouter(deps: { db: Db }): RouterType {
  const router = Router()
  const { db } = deps
  router.post("/share-count", (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      // 单条 SQL 实现 UPSERT：INSERT ... ON CONFLICT DO UPDATE
      db.prepare(
        `INSERT INTO share_counts (user_id, count) VALUES (?, 1)
         ON CONFLICT(user_id) DO UPDATE SET count = count + 1`,
      ).run(userId)
      const row = db
        .prepare(`SELECT count FROM share_counts WHERE user_id = ?`)
        .get(userId) as { count: number }
      res.json({ ok: true as const, count: row.count })
    } catch (err) {
      next(err)
    }
  })
  return router
}

// 静默 ESLint 未用警告
// (config 字段保留在 PostersRouterDeps 中以便未来扩展；当前 POST / 上传海报逻辑不需要 config)
