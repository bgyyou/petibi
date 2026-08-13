// 【文件说明】验证码生成工具（合并自 M2 工单 utils/code.ts；契约 §4：6 位数字、10 分钟过期）
// 用 crypto.randomInt 取无偏随机整数，避免 Math.random 的偏置问题。
// 不接短信/邮件网关——发邮件由 Mailer 负责，本工具只负责生成。

import { randomInt } from "node:crypto"

/**
 * 生成 6 位数字验证码（范围 000000..999999，前导 0 保留）。
 * 用 crypto.randomInt 保证每位等概率，避免 Math.random 的低位偏置。
 */
export function generateCode(length = 6): string {
  const max = 10 ** length
  const n = randomInt(0, max)
  return n.toString().padStart(length, "0")
}

/**
 * 校验验证码格式：必须是 length 位数字字符串。
 * 路由层在查表前先过这一关，避免无效字符串走 DB 路径。
 */
export function isValidCodeFormat(code: unknown, length = 6): code is string {
  if (typeof code !== "string") return false
  const re = new RegExp(`^\\d{${length}}$`)
  return re.test(code)
}