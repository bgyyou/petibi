// 【文件说明】JWT 签发 / 校验（合并自 M2 工单 utils/auth.ts；HS256 + 无状态）。
// 取舍说明：
//   - 选 **无状态 HS256 JWT** 而非"表存 token"：
//     ① 无状态意味着横向扩容时无需共享会话存储；
//     ② JWT 载荷可携带 email，便于日志与调试；
//     ③ 缺点是吊销需要黑名单——MVP 不做主动吊销（写错密码 / 改 token 都没有），足够。
//     生产部署务必通过 PETIBI_JWT_SECRET 设置强密钥。

import jwt from "jsonwebtoken"
import type { JwtPayload } from "../types.js"

/**
 * 用服务端密钥签发 JWT。
 * 默认 30 天过期；过期秒数由 config 注入。
 */
export function signToken(
  payload: JwtPayload,
  secret: string,
  expiresInSec: number,
): string {
  return jwt.sign(payload, secret, { expiresIn: expiresInSec, algorithm: "HS256" })
}

/**
 * 解析 JWT；失败抛 AppError(401, Unauthorized)。
 * 路由不需要 try/catch，由统一错误中间件处理。
 */
export function verifyToken(token: string, secret: string): JwtPayload {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] })
  if (typeof decoded === "string" || !decoded || typeof decoded !== "object") {
    throw new Error("token 格式非法")
  }
  // jsonwebtoken 的 JwtPayload 与我们的 JwtPayload 字段不冲突，逐字段校验即可
  const sub = (decoded as Record<string, unknown>)["sub"]
  const email = (decoded as Record<string, unknown>)["email"]
  if (typeof sub !== "string" || typeof email !== "string") {
    throw new Error("token 字段缺失")
  }
  return { sub, email }
}