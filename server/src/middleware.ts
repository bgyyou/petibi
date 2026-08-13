// 【文件说明】Express 鉴权中间件：解析 Authorization: Bearer <jwt>，校验后挂载 req.user。
// 失败抛 AppError(401, Unauthorized)；路由不必自己 try/catch。

import type { Request, Response, NextFunction, RequestHandler } from "express"
import { AppError } from "./errors.js"
import type { JwtPayload } from "./types.js"
import { verifyToken } from "./utils/jwt.js"

/**
 * 在 Express Request 上挂载的当前用户信息（鉴权中间件写入）。
 */
declare module "express-serve-static-core" {
  interface Request {
    user?: JwtPayload
  }
}

/**
 * 工厂：从 secret 构造中间件，便于测试场景注入固定 secret。
 */
export function requireAuth(secret: string): RequestHandler {
  return function authMiddleware(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers.authorization
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      return next(AppError.unauthorized("缺少 Bearer token"))
    }
    const token = header.slice("bearer ".length).trim()
    if (!token) {
      return next(AppError.unauthorized("缺少 Bearer token"))
    }
    try {
      req.user = verifyToken(token, secret)
      next()
    } catch (err) {
      if (err instanceof AppError) return next(err)
      // jsonwebtoken 抛出的 TokenExpiredError / JsonWebTokenError 等统一映射为 401
      next(AppError.unauthorized("token 无效或已过期"))
    }
    return undefined
  }
}

/**
 * 工具：把 req.user?.sub 解析成数字 userId；不可解析时抛 401。
 */
export function userIdFromRequest(req: Request): number {
  const userId = Number(req.user?.sub)
  if (!Number.isFinite(userId)) {
    throw AppError.unauthorized("token 缺少有效用户 id")
  }
  return userId
}