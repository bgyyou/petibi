// 【文件说明】API 客户端类型定义（对应 docs/tech/M3-对话链路契约.md §4）。
// 字段命名严格遵循契约，便于 server 实现时按图对接。
//
// 现状：M2 只用到 auth 相关 + profile + feedback；M3 新增 chat（SSE 事件）/quota /profile。

// 通用：当前用户信息（GET /api/me）
export interface User {
  id: string
  email: string
  nickname: string | null
  mbti: string | null
  subtype: 'stable' | 'sensitive' | null
  /** 桌宠宠物昵称（用户自定义）；null/未设置时由前端展示动物本名 */
  pet_nickname: string | null
  /** 最近一次宠物昵称修改时间（Unix 秒，0 = 从未改过） */
  pet_nickname_changed_at: number
  /** 下次允许修改宠物昵称的时间戳（Unix 秒）；now 时表示现在可改（首次或冷却已过） */
  next_change_at: number
  /** 动物本名（data/personas/<mbti>.json 的 pet_name）；mbti 未设时为 null */
  pet_name: string | null
  /** 动物种类（"猫头鹰" 等）；mbti 未设时为 null */
  animal: string | null
}

// 通用：API 错误响应（按契约约定：400 / 401 / 4xx/5xx 都用此结构）
export interface ApiError {
  code: string
  message: string
  /** 额外上下文：冷却剩余秒数等（M3 宠物昵称路由携带 remainSec/nextChangeAt） */
  extra?: Record<string, unknown>
}

// ----- 登录流程（POST /api/auth/email/code、POST /api/auth/email/verify）-----

/** 发送邮箱验证码响应：dev 模式会把 code 直接返回在响应里 */
export interface SendCodeResponse {
  // 仅 dev / mock 返回；生产环境为 null
  dev_code?: string | null
  expires_in: number
}

/** 校验邮箱 + 验证码响应：成功后返回 token（前端写入本地）+ 用户信息 */
export interface VerifyCodeResponse {
  token: string
  user: User
}

/** 提交反馈（结果符合你吗）响应：服务端记录即可，前端只关心成功 */
export interface FeedbackResponse {
  recorded_at: string
}

// ----- 初始化档案（POST /api/me/profile）-----

/** 初始化档案请求体 */
export interface SaveProfileRequest {
  nickname: string
  mbti: string
  subtype: 'stable' | 'sensitive'
}

/** 初始化档案响应：回传最新 user */
export type SaveProfileResponse = User

// ----- 宠物昵称（POST /api/me/pet-nickname）-----

/** 修改宠物昵称请求体 */
export interface SetPetNicknameRequest {
  nickname: string
}

/** 修改宠物昵称响应：回传最新宠物昵称状态 + 下次可改时间 */
export interface SetPetNicknameResponse {
  pet_nickname: string | null
  pet_nickname_changed_at: number
  next_change_at: number
}

// ----- 反馈（POST /api/me/feedback）-----

/** 反馈请求：是否与本次人格结果一致 + 自由评论（可选） */
export interface FeedbackRequest {
  match: boolean
  comment?: string
}

export type FeedbackApiResponse = FeedbackResponse

// ----- 对话（POST /api/chat SSE 流式）-----

/** POST /api/chat 入参 */
export interface ChatRequestBody {
  question: string
}

/** SSE 事件类型，与 server/src/types.ts 的 SseEvent 对齐
 *
 * 字段兼容性说明（M3 流式守卫与三档工单）：
 *   - meta 事件新增可选 guard_hit 字段（server 在意图/RAG 通过后立即发，
 *     此时 LLM 还没机会输出，guard_hit 一律 false；前端可不消费）。
 *   - done 事件新增可选 guard_hit 字段（标识本次最终是否被守卫命中）。
 *   - 新增 guard 事件（mid-stream 截断标识）：LLM 流式过程中触发增量守卫
 *     （代码块/出戏词/超档位 1.2 倍）时由 server 立即发出，text 是该人格的
 *     拒绝模板；前端用其替换剩余输出并关闭 streaming。
 *
 * 字段在 mock 模式下不出现（mockComposeAnswer 不会触发守卫）；real 模式
 * 字段必有。前端 chat-reducer 统一按"事件类型是否存在"判定，缺字段时安全降级。
 */
export type ChatSseEvent =
  | { type: 'meta'; rag_entry_id: string | null; refused: boolean; guard_hit?: boolean }
  | { type: 'delta'; text: string }
  | { type: 'guard'; reason: string; text: string }
  | { type: 'done'; total_chars: number; guard_hit?: boolean }
  | { type: 'error'; message: string }

/** 单条对话消息（面板 UI 用） */
export interface ChatMessage {
  /** 本地 uuid，便于 React key */
  id: string
  /** 角色：用户 / 助手 / 系统提示 */
  role: 'user' | 'assistant' | 'system'
  /** 文本内容（流式累加最终值） */
  text: string
  /** 流式生成中标记：true 时显示打字光标 */
  streaming?: boolean
  /** 命中拒绝模板时为 true（人格化越界拒绝也走这一路） */
  refused?: boolean
  /** RAG 检索到的条目 id（命中时显示"参考了 XX 条目"小角标） */
  rag_entry_id?: string | null
  /** 错误消息（role=system 时携带） */
  error?: string
}

// ----- 配额（GET /api/quota）-----

/** 今日剩余对话次数 */
export interface QuotaInfo {
  /** 日期 YYYY-MM-DD */
  date: string
  /** 已使用次数 */
  used: number
  /** 上限 */
  limit: number
  /** 剩余次数（limit - used，下限 0） */
  remaining: number
}