// 【文件说明】邮箱登录相关路由：发码 / 校验（合并自 M2 工单 routes/auth.ts；契约 §4）
// 路由：
//   POST /email/code    发邮箱验证码（dev 模式直接响应回显）
//   POST /email/verify  校验验证码 + 登录（自动注册）
//
// 实现说明：
//   - dev 模式下验证码同步返回 + 打日志；生产模式只投递给 Mailer，不在响应中暴露
//   - 验证码一次性：消费后立刻 DELETE，避免重放
//   - 校验通过后无感注册新用户（users 表 INSERT）
//   - 返回 JWT（HS256）供 /api/me 等鉴权接口使用

import { Router } from "express"
import type { Router as RouterType, Request, Response, NextFunction } from "express"
import { AppError, ErrorCodes, type ApiResponse } from "../errors.js"
import type { Db } from "../db.js"
import type { Mailer } from "../mailer.js"
import type { ServerConfig } from "../config.js"
import { isValidEmail } from "../utils/email.js"
import { generateCode, isValidCodeFormat } from "../utils/code.js"
import { signToken } from "../utils/jwt.js"
import { todayDateString } from "../utils/date.js"
import type {
  EmailCodeRequest,
  EmailCodeResponse,
  EmailVerifyRequest,
  EmailVerifyResponse,
  UserRow,
} from "../types.js"

/** 路由工厂依赖：由 app.ts 在构造时注入，便于测试覆盖 */
export interface AuthRouterDeps {
  db: Db
  config: ServerConfig
  mailer: Mailer
}

/** 用 email 查 user；找不到返回 undefined（不抛错） */
function findUserByEmail(db: Db, email: string): UserRow | undefined {
  const raw = db
    .prepare(
      `SELECT id, email, nickname, mbti, subtype, created_at,
              pet_nickname, pet_nickname_changed_at
       FROM users WHERE email = ?`,
    )
    .get(email)
  const row = (raw ?? undefined) as UserRow | undefined
  if (row) {
    if (row.pet_nickname === undefined) row.pet_nickname = null
    if (row.pet_nickname_changed_at === undefined) row.pet_nickname_changed_at = 0
  }
  return row
}

/** 注册新用户：返回新行的 id（不做合法性校验，email 由路由前置校验过） */
function insertUser(db: Db, email: string): number {
  const info = db
    .prepare("INSERT INTO users (email) VALUES (?)")
    .run(email)
  return Number(info.lastInsertRowid)
}

/**
 * 构造邮箱登录相关路由。
 */
export function createAuthRouter(deps: AuthRouterDeps): RouterType {
  const router = Router()
  const { db, config, mailer } = deps

  // POST /email/code —— 发验证码
  router.post("/email/code", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<EmailCodeRequest> | undefined
      const email = body?.email
      if (!isValidEmail(email)) {
        throw AppError.badRequest(ErrorCodes.InvalidEmail, "邮箱格式不正确")
      }

      // 生成 6 位数字验证码 + 过期时间（毫秒时间戳）
      const code = generateCode(6)
      const expiresAt = Date.now() + config.codeExpiresInSec * 1000

      // 同一邮箱若已有未过期码，覆盖之；保证 "latest wins"
      // 不用 UPSERT 因为 PK 是 (email, code)；改用先 DELETE 再 INSERT
      db.exec("BEGIN")
      try {
        db.prepare("DELETE FROM email_codes WHERE email = ?").run(email)
        db.prepare(
          "INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, ?)",
        ).run(email, code, expiresAt)
        db.exec("COMMIT")
      } catch (e) {
        db.exec("ROLLBACK")
        throw e
      }

      // 发邮件（dev 模式打日志）
      await mailer.sendVerificationCode(email, code, config.codeExpiresInSec)

      // dev 模式：响应里回显 code，方便联调（生产模式不发）
      const isDev = config.env !== "prod"
      const payload: EmailCodeResponse = {
        ok: true,
        devCode: isDev ? code : undefined,
        expiresInSec: config.codeExpiresInSec,
      }
      res.json(payload satisfies ApiResponse<EmailCodeResponse>)
    } catch (err) {
      next(err)
    }
  })

  // POST /email/verify —— 校验并登录（新用户自动注册）
  router.post("/email/verify", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Partial<EmailVerifyRequest> | undefined
      const { email, code } = {
        email: body?.email,
        code: body?.code,
      }
      if (!isValidEmail(email)) {
        throw AppError.badRequest(ErrorCodes.InvalidEmail, "邮箱格式不正确")
      }
      if (!isValidCodeFormat(code)) {
        throw AppError.badRequest(ErrorCodes.CodeFormatInvalid, "验证码必须是 6 位数字")
      }

      // 取验证码记录；按 (email, code) 查
      const rowRaw = db
        .prepare(
          "SELECT expires_at FROM email_codes WHERE email = ? AND code = ?",
        )
        .get(email, code)
      const row = (rowRaw ?? undefined) as { expires_at: number } | undefined

      if (!row) {
        // 没找到记录：要么输错，要么已消费；统一报"无效"
        throw AppError.badRequest(ErrorCodes.InvalidCode, "验证码错误或已过期")
      }
      if (row.expires_at < Date.now()) {
        // 顺手清掉过期记录
        db.prepare("DELETE FROM email_codes WHERE email = ? AND code = ?").run(email, code)
        throw AppError.badRequest(ErrorCodes.InvalidCode, "验证码已过期")
      }

      // 一次性消费：立即删除（即使后续 token 签发失败，用户也能用同一码重试）
      db.prepare("DELETE FROM email_codes WHERE email = ?").run(email)

      // 登录或注册：邮箱唯一，找不到就注册
      let user = findUserByEmail(db, email)
      if (!user) {
        const id = insertUser(db, email)
        user = findUserByEmail(db, email) ?? {
          id,
          email,
          nickname: null,
          mbti: null,
          subtype: null,
          created_at: todayDateString() + " 00:00:00",
          pet_nickname: null,
          pet_nickname_changed_at: 0,
        } as UserRow
      }

      // 签 JWT
      const token = signToken(
        { sub: String(user.id), email: user.email },
        config.jwtSecret,
        config.jwtExpiresInSec,
      )

      const payload: EmailVerifyResponse = {
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          mbti: user.mbti,
          subtype: user.subtype,
          hasProfile: !!user.mbti && !!user.nickname && !!user.subtype,
          pet_nickname: user.pet_nickname,
          pet_nickname_changed_at: user.pet_nickname_changed_at,
          next_change_at: user.pet_nickname_changed_at > 0
            ? user.pet_nickname_changed_at + 72 * 60 * 60
            : Math.floor(Date.now() / 1000),
          pet_name: null,
          animal: null,
        },
      }
      res.json(payload satisfies ApiResponse<EmailVerifyResponse>)
    } catch (err) {
      next(err)
    }
  })

  return router
}