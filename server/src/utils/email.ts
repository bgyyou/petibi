// 【文件说明】邮箱格式校验工具（合并自 M2 工单 utils/email.ts）
// 仅做"是否长得像合法邮箱"的格式校验，不做 MX 解析 / 黑白名单。
// 这层校验的目的：拦掉明显的拼写错误与脚本注入式脏数据。

/**
 * 邮箱格式正则：
 *   - 本地部分：字母/数字/._%+- 组成，至少 1 个字符
 *   - 域名：字母/数字/.- 分段，至少 2 段
 *   - 总长 ≤ 254（RFC 5321 邮件地址长度上限）
 * 故意偏严：减少误通过，宁可让用户改一下，也不要把脏数据写进 users 表。
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

/**
 * 校验邮箱是否合法。
 * 命中规则返回 true；否则 false（路由层据此抛 InvalidEmail）。
 */
export function isValidEmail(email: unknown): email is string {
  if (typeof email !== "string") return false
  if (email.length === 0 || email.length > 254) return false
  return EMAIL_RE.test(email)
}