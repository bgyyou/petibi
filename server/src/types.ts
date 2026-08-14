// 【文件说明】对话链路共享类型：契约 §4 的请求/响应/DB 行类型集中定义，避免各模块重复定义导致不一致
//
// 约束：
//  - 16 种人格枚举由 INTP/ENTP/.../ESFP 的固定顺序给出，外部索引人格时按此顺序；
//  - 字段命名保持下划线（与 DB 列名一致）与驼峰（与 JS 习惯一致）两套：DB 行用 snake_case，API 入参/出参用 camelCase。
//  - 合并自 M2（auth / me / profile / quota / email-code）的 DTO 也在本文件提供，避免分散。

import type { ErrorCode } from "./errors.js"

/** MBTI 16 种人格枚举（与 PRD §8.2 动物映射表对应） */
export type Personality =
  | "INTJ" | "INTP" | "ENTJ" | "ENTP"
  | "INFJ" | "INFP" | "ENFJ" | "ENFP"
  | "ISTJ" | "ISFJ" | "ESTJ" | "ESFJ"
  | "ISTP" | "ISFP" | "ESTP" | "ESFP"

/** 16 种人格按字母升序排列（与 data/encyclopedia/index.json 中 personalities 顺序对齐） */
export const PERSONALITIES: readonly Personality[] = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
] as const

/** 用户情绪稳定性细分标签（PRD §3.3 自有中文命名，不用 -A/-T） */
export type Subtype = "stable" | "sensitive"

/** 单条百科条目（与 data/encyclopedia/*.json 中 entries 元素结构对齐） */
export interface EncyclopediaEntry {
  /** 条目全局唯一 ID，例如 ENTP-scenario-public-speaking */
  id: string
  /** 条目分类：trait/cognitive/strength/weakness/career/scenario 等 */
  category: string
  /** 条目标题 */
  title: string
  /** 条目正文（用于 RAG 注入 LLM 上下文） */
  content: string
  /** 条目标签（用于打分匹配） */
  tags: string[]
  /** 关联的场景 slug（如 public-speaking），用于"问演讲"路由到 public-speaking 条目 */
  scenario: string | null
}

/** 单个人格的百科文件结构（与 data/encyclopedia/intj.json 等对齐） */
export interface EncyclopediaFile {
  personality: Personality
  animal: string
  family: "analyst" | "diplomat" | "sentinel" | "explorer"
  entries: EncyclopediaEntry[]
}

/** 意图过滤器词库（data/intent-filter.json） */
export interface IntentFilterRule {
  category: string
  keywords: string[]
  action: "refuse"
}

export interface IntentFilterFile {
  rules: IntentFilterRule[]
  rag_skip_patterns: string[]
}

/** 人格化拒绝模板（data/refusals.json） */
export interface RefusalsFile {
  categories: string[]
  templates: Record<Personality, Record<string, string[]>>
}

/** 人格速查卡（data/personas/<type>.json） */
export interface PersonaCard {
  type: Personality
  pet_name: string
  animal: string
  family: string
  system_prompt: string
  cognitive: string[]
  style_keywords: string[]
}

/** 意图过滤命中结果 */
export interface IntentFilterHit {
  category: string
  matched_keyword: string
}

/** POST /api/chat 入参 */
export interface ChatRequestBody {
  question: string
  /**
   * 可选：客户端发起的会话串 id（UUID 等）。
   * 携带时 server 会从 chat_logs 拉取该会话最近 6 轮历史拼进 prompt；
   * 不携带 / 空串 → 走单轮链路（不拉历史，向后兼容现有调用）。
   * 工单：M4 多轮对话 B §B1。
   */
  session_id?: string
}

/** POST /api/chat SSE 事件类型（data: 后跟 JSON 字符串）
 *
 * 流式 + 增量守卫改造（M3 流式守卫与三档工单）后的事件集：
 *   - meta   ：鉴权/意图/RAG 通过后立即发，触发 0.3s 思考动画；guard_hit 此时为 false
 *              （LLM 还没输出，守卫不可能命中）。最终是否真被守卫截断以 done.guard_hit 为准
 *              （并由其后的 guard 事件携带拒绝模板）。
 *   - delta  ：LLM 增量文本片段；守卫命中或档位自然截断时会带 "……" 省略号终止。
 *   - guard  ：流式过程中守卫命中（代码块/出戏词/超档位 1.2 倍）时立即发，
 *              text 是该人格的拒绝模板（前端用其替换剩余输出）。
 *   - done   ：流结束；guard_hit=true 表示本次最终被守卫命中（哪怕 guard 事件已发过，
 *              也再带一次供 chat_logs 写入与最终确认）；total_chars 是实际推给前端的长度。
 *   - error  ：鉴权/配额/网络等致命错误。
 */
export type SseEvent =
  | { type: "meta"; rag_entry_id: string | null; refused: boolean; guard_hit: boolean }
  | { type: "delta"; text: string }
  | { type: "guard"; reason: string; text: string }
  | { type: "done"; total_chars: number; guard_hit: boolean }
  | { type: "error"; message: string }

/** DB 行：users */
export interface UserRow {
  id: number
  email: string
  nickname: string | null
  mbti: Personality | null
  subtype: Subtype | null
  created_at: string
  /** 桌宠昵称：null/空字符串 = 使用动物本名（intj.json 的 pet_name）；用户可自定义 */
  pet_nickname: string | null
  /** 最近一次宠物昵称修改时间（Unix 秒，0 = 从未改过，首次设置不受冷却限制） */
  pet_nickname_changed_at: number
}

/** DB 行：email_codes（M2 工单加入，契约 §4） */
export interface EmailCodeRow {
  email: string
  code: string
  expires_at: number
}

/** DB 行：chat_usage */
export interface ChatUsageRow {
  user_id: number
  date: string
  count: number
}

/** DB 行：chat_logs */
export interface ChatLogRow {
  id: number
  user_id: number
  question: string
  answer: string
  rag_entry_id: string | null
  refused: number // 0/1
  guard_hit: number // 0/1（M3 边界防御：输出守卫是否拦下改用拒绝模板）
  /** M4 多轮对话：客户端传入的 session_id；NULL = 单轮（无历史） */
  session_id: string | null
  created_at: string
}

/** JWT 载荷：sub 存用户 id（字符串是 JWT 习惯），email 冗余便于日志与调试。 */
export interface JwtPayload {
  sub: string
  email: string
}

/** 写档请求体：昵称 + 四字母 MBTI + 细分标签。 */
export interface ProfileInput {
  nickname: string
  mbti: Personality
  subtype: Subtype
}

/** POST /api/me/pet-nickname 请求体 */
export interface PetNicknameInput {
  nickname: string
}

/**
 * POST /api/me/feedback 请求体（PRD §3.3 题库迭代核心数据）：
 *   - mbti / subtype：本次测评结果（前端结果页当前展示的人格），不从 users 表反查，
 *     因为用户可能反馈完不点「完成」，users 表里还是旧人格；
 *   - accepted：true = 「很符合」，false = 「测的不准」；
 *   - comment：可选自由文本（≤200 字），当前 UI 未采集，留给后续「说说哪里不准」。
 */
export interface FeedbackInput {
  mbti: Personality
  subtype: Subtype
  accepted: boolean
  comment?: string
}

/** POST /api/me/feedback 响应：服务端记录成功即可，前端只关心 recorded_at */
export interface FeedbackResponse {
  ok: true
  /** 落库时间（SQLite datetime('now') 的 UTC 字符串） */
  recorded_at: string
}

/**
 * GET /api/me 与 POST /api/me/pet-nickname 通用响应：
 *  - pet_nickname：当前生效昵称（自定义或 null=未设置 → 显示动物本名）
 *  - pet_nickname_changed_at：上次修改 Unix 秒（0 = 未改过）
 *  - next_change_at：下次可再修改的 Unix 秒；冷却中 = changed_at + 72h，未改过 = 当前时间（即刻）
 */
export interface PetNicknameResponse {
  ok: true
  pet_nickname: string | null
  pet_nickname_changed_at: number
  /** 下次允许修改的时间戳；冷却未到时 = changed_at + 72h，否则 = now（随时可改） */
  next_change_at: number
}

/** /api/auth/email/code 请求体 */
export interface EmailCodeRequest {
  email: string
}

/** /api/auth/email/verify 请求体 */
export interface EmailVerifyRequest {
  email: string
  code: string
}

/** /api/auth/email/code 响应：dev 模式 code 直接回显便于联调；prod 仅返回 ok。 */
export interface EmailCodeResponse {
  ok: true
  /** dev 模式才会出现该字段，生产环境必须为 undefined */
  devCode?: string
  /** 过期秒数，便于前端倒计时 */
  expiresInSec: number
}

/** /api/auth/email/verify 响应：返回 token + 用户摘要。 */
export interface EmailVerifyResponse {
  ok: true
  token: string
  user: {
    id: number
    email: string
    nickname: string | null
    mbti: Personality | null
    subtype: Subtype | null
    hasProfile: boolean
    pet_nickname: string | null
    pet_nickname_changed_at: number
    next_change_at: number
    pet_name: string | null
    animal: string | null
  }
}

/** /api/me 响应：当前登录用户信息（含写档状态）。 */
export interface MeResponse {
  ok: true
  id: number
  email: string
  nickname: string | null
  mbti: Personality | null
  subtype: Subtype | null
  hasProfile: boolean
  /** 桌宠昵称（自定义） */
  pet_nickname: string | null
  /** 最近修改宠物昵称时间（Unix 秒，0 = 从未改过） */
  pet_nickname_changed_at: number
  /** 下次允许修改宠物昵称时间（Unix 秒；<=now 表示现在可改） */
  next_change_at: number
  /** 动物本名（data/personas/<mbti>.json 的 pet_name）；mbti 未设时为 null */
  pet_name: string | null
  /** 动物种类（"猫头鹰" 等）；mbti 未设时为 null */
  animal: string | null
}

/** /api/quota 响应：今日已用 / 剩余 / 上限。 */
export interface QuotaResponse {
  ok: true
  date: string
  used: number
  remaining: number
  limit: number
}

/** 统一响应壳（errors.ts 也有，重复一次避免循环依赖） */
export interface ApiOk<T> {
  ok: true
  data?: T
}
export interface ApiErr {
  ok: false
  error: { code: ErrorCode; message: string; extra?: Record<string, unknown> }
}