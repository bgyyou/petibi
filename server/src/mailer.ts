// 【文件说明】邮件发送接口与 dev/prod 实现（合并自 M2 工单 mailer.ts）
// 设计：
//   - Mailer 接口统一抽象发送动作
//   - DevMailer 直接打日志（开发联调用）
//   - ProdMailer 为占位实现，明确标注 TODO，避免被默认当作"已对接邮件服务"
//   - 由 routes/auth.ts 根据 ServerConfig.env 选择实现

import type { ServerConfig } from "./config.js"

/**
 * 邮件发送接口。任意实现都需要把验证码投递给用户。
 */
export interface Mailer {
  /**
   * 发送邮箱验证码。
   * 实现必须返回 Promise；失败 reject 即可，路由会把它转成 500。
   */
  sendVerificationCode(email: string, code: string, expiresInSec: number): Promise<void>
}

/**
 * 开发用 Mailer：直接把验证码打到 stdout / 日志，路由同时在响应里回显 devCode。
 * 不要在生产用——任何人都能拿到别人的验证码。
 */
export class DevMailer implements Mailer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly config: ServerConfig) {}

  async sendVerificationCode(email: string, code: string, expiresInSec: number): Promise<void> {
    // 用结构化日志一行，便于 grep：Petibi [mail] code=123456 to=foo@bar.com
    console.log(
      `Petibi [mail] dev code=${code} to=${email} expiresIn=${expiresInSec}s`,
    )
  }
}

/**
 * 生产用 Mailer 占位：未实现 send 方法，调用直接抛错，避免被静默默认发送。
 * 接入真实邮件服务（SendGrid / 阿里云 DM / SMTP）时在此实现，并把 Mailer 工厂改造成读 env。
 */
export class ProdMailer implements Mailer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly config: ServerConfig) {}

  async sendVerificationCode(_email: string, _code: string, _expiresInSec: number): Promise<void> {
    // 显式抛错：prod 启动后第一次发送会暴露问题，避免静默吞掉
    throw new Error(
      "ProdMailer 未实现：请在 server/src/mailer.ts 中接入真实邮件服务（SMTP / SendGrid / 阿里云 DM）",
    )
  }
}

/**
 * 工厂：根据 config.env 返回对应 Mailer。
 */
export function createMailer(config: ServerConfig): Mailer {
  if (config.env === "prod") {
    return new ProdMailer(config)
  }
  // dev / test 都走 DevMailer（测试时打日志不影响断言）
  return new DevMailer(config)
}