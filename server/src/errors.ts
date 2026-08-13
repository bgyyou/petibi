// 【文件说明】统一错误类型 + 业务错误码常量（合并自 M2 工单 errors.ts）
// 设计要点：
//   - 所有路由抛 AppError，由统一中间件转 {ok:false, error:{code,message}} JSON 返回
//   - 错误码采用常量字符串（避免拼写漂移）；HTTP 状态码由本类承担转换
//   - 未捕获错误降级为 500，不泄露堆栈
//   - SSE 流式端点（/api/chat）保留原有 SseEvent 通道，不强行套用本形状

/**
 * 业务错误码常量：跨路由复用的字符串集合。
 * 与路由返回 JSON 的 `code` 字段一一对应。
 */
export const ErrorCodes = {
  /** 通用参数缺失（如 body 不全） */
  BadRequest: "BAD_REQUEST",
  /** 邮箱格式非法 */
  InvalidEmail: "INVALID_EMAIL",
  /** 验证码错误或已过期 */
  InvalidCode: "INVALID_CODE",
  /** 验证码格式非法（非 6 位数字） */
  CodeFormatInvalid: "CODE_FORMAT_INVALID",
  /** 写档参数非法（mbti 不在 16 型内 / subtype 非两档之一） */
  InvalidProfile: "INVALID_PROFILE",
  /** 鉴权失败：未携带 token / token 无效 / token 过期 */
  Unauthorized: "UNAUTHORIZED",
  /** 当日配额已用完 */
  QuotaExceeded: "QUOTA_EXCEEDED",
  /** 用户不存在（理论上不会出现，仅作为兜底） */
  UserNotFound: "USER_NOT_FOUND",
  /** 请求路径未匹配任何路由（404 兜底） */
  NotFound: "NOT_FOUND",
  /** 接口占位（501）：路由已挂载，业务实现由后续工单接管 */
  NotImplemented: "NOT_IMPLEMENTED",
  /** 服务端未捕获异常 */
  Internal: "INTERNAL",
  /** 宠物昵称非法（空 / 超 8 字 / 含空白） */
  InvalidPetNickname: "INVALID_PET_NICKNAME",
  /** 宠物昵称修改冷却中（距上次修改不足 72 小时） */
  PetNicknameCooldown: "PET_NICKNAME_COOLDOWN",
} as const

/** 错误码字面量类型 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * 业务异常：携带 HTTP 状态码 + 错误码 + 可读消息 + 可选 extra。
 * 路由层 throw new AppError(...) 即可，由统一错误中间件处理。
 *
 * extra 字段用于把额外上下文（如冷却剩余秒数、下次可修改时间戳）一起回给前端，
 * 避免在响应里再单独开通道。HTTP 状态码与业务码（error.code）照旧由 status/code 承担。
 */
export class AppError extends Error {
  public readonly status: number
  public readonly code: ErrorCode
  public readonly extra: Record<string, unknown> | undefined

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code
    this.extra = extra
  }

  /** 400 + 业务码 */
  static badRequest(code: ErrorCode, message: string): AppError {
    return new AppError(400, code, message)
  }

  /** 401 + 未鉴权 */
  static unauthorized(message = "请先登录"): AppError {
    return new AppError(401, ErrorCodes.Unauthorized, message)
  }

  /** 403 业务配额超限 */
  static quotaExceeded(message = "今日对话次数已用完，明天再来"): AppError {
    return new AppError(403, ErrorCodes.QuotaExceeded, message)
  }

  /** 404 */
  static notFound(code: ErrorCode, message: string): AppError {
    return new AppError(404, code, message)
  }

  /** 429 业务冷却未到：error.code 仍走 ErrorCodes.PetNicknameCooldown，extra 携带剩余秒数 */
  static cooldown(
    code: ErrorCode,
    message: string,
    extra: Record<string, unknown>,
  ): AppError {
    return new AppError(429, code, message, extra)
  }
}

/**
 * 统一 JSON 响应形状：成功与失败都用 `{ok: boolean, ...}` 包裹。
 * 非 SSE 路由统一返回此形状；SSE 流式端点保留自定义事件流。
 */
export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: { code: ErrorCode; message: string }
}