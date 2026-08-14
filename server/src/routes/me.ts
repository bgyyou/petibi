// 【文件说明】当前用户相关路由：读 + 写档 + 宠物昵称 + 测评反馈（M3 工单 / M4 反馈路由补齐）。
// 路由：
//   GET  /                 当前登录用户信息（含宠物昵称 + 下次可改时间）
//   POST /profile          初始化写档（昵称 + MBTI + 细分标签）
//   POST /pet-nickname     修改宠物昵称（72h 冷却；首次不限）
//   POST /feedback         结果页「很符合 / 测的不准」反馈落库 test_feedback（PRD §3.3 题库迭代数据源）
// 鉴权：四个接口都走 requireAuth 中间件（在 app.ts 里挂载），本路由只关心业务逻辑。

import { Router } from "express"
import type { Router as RouterType, Request, Response, NextFunction } from "express"
import { AppError, ErrorCodes, type ApiResponse } from "../errors.js"
import type { Db } from "../db.js"
import { PET_NICKNAME_COOLDOWN_SEC } from "../db.js"
import { userIdFromRequest } from "../middleware.js"
import { loadPersonaCard } from "../personas.js"
import type {
  FeedbackInput,
  FeedbackResponse,
  MeResponse,
  Personality,
  PetNicknameInput,
  PetNicknameResponse,
  ProfileInput,
  Subtype,
  UserRow,
} from "../types.js"

/** 16 型 MBTI 白名单：与计分引擎保持一致；写档时强校验，防止前端手填乱码 */
const MBTI_TYPES = new Set<string>([
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
])

/** subtype 取值：与计分引擎 FIRST_POLE 表一致 */
const SUBTYPES = new Set<Subtype>(["stable", "sensitive"])

/** 宠物昵称长度上限：1-8 字（与 owner 决策一致），包含中文与英文字符均按字符数计算 */
const PET_NICKNAME_MAX_LEN = 8

/** 反馈自由评论长度上限：与社区留言口径一致（≤200 字） */
const FEEDBACK_COMMENT_MAX_LEN = 200

/** 路由依赖 */
export interface MeRouterDeps {
  db: Db
  /** 人格速查卡目录（绝对路径）。内嵌打包场景由主进程注入 resources/data/personas；
   *  不传则走 personas.ts 内部解析（env PETIBI_PERSONAS_DIR → import.meta.url 推算）。 */
  personasDir?: string
}

/** 当前用户查找：找不到时抛 404 而不是 undefined，让上层不必再判空 */
function findUserOrThrow(db: Db, userId: number): UserRow {
  const raw = db
    .prepare(
      `SELECT id, email, nickname, mbti, subtype, created_at,
              pet_nickname, pet_nickname_changed_at
       FROM users WHERE id = ?`,
    )
    .get(userId)
  const user = (raw ?? undefined) as UserRow | undefined
  if (!user) {
    throw AppError.notFound(ErrorCodes.UserNotFound, "用户不存在")
  }
  // 老库未触发 ALTER 时（迁移遗漏/手动改库）兜底，避免下游 TS 把 undefined 当 null
  if (user.pet_nickname === undefined) user.pet_nickname = null
  if (user.pet_nickname_changed_at === undefined) user.pet_nickname_changed_at = 0
  return user
}

/**
 * 计算宠物昵称下次可改时间戳（Unix 秒）：
 *   - changed_at = 0（从未改过）→ now（首次设置不受冷却限制）
 *   - 否则 → changed_at + 72h
 * 冷却中 = now < next_change_at；前端可直接拿 next_change_at - now 算倒计时。
 */
function computeNextChangeAt(changedAt: number, nowSec: number): number {
  if (changedAt <= 0) return nowSec
  return changedAt + PET_NICKNAME_COOLDOWN_SEC
}

/** 校验写档参数 */
function validateProfile(input: Partial<ProfileInput> | undefined): ProfileInput {
  const nickname = input?.nickname
  const mbti = input?.mbti
  const subtype = input?.subtype

  if (typeof nickname !== "string" || nickname.trim().length === 0) {
    throw AppError.badRequest(ErrorCodes.InvalidProfile, "昵称不能为空")
  }
  if (nickname.length > 32) {
    throw AppError.badRequest(ErrorCodes.InvalidProfile, "昵称长度不能超过 32 字符")
  }
  if (typeof mbti !== "string" || !MBTI_TYPES.has(mbti)) {
    throw AppError.badRequest(ErrorCodes.InvalidProfile, "MBTI 必须是 16 型之一")
  }
  if (typeof subtype !== "string" || !SUBTYPES.has(subtype as Subtype)) {
    throw AppError.badRequest(ErrorCodes.InvalidProfile, "subtype 必须是 stable 或 sensitive")
  }

  return { nickname: nickname.trim(), mbti: mbti as Personality, subtype: subtype as Subtype }
}

/**
 * 校验宠物昵称：
 *   - 必填、字符串；
 *   - 去首尾空格与全部空白字符后必须 1-8 字；
 *   - 空白过滤后空字符串视为非法（前端 "   " / "\t" 都拒绝）。
 * 不校验是否与动物本名相同：用户允许"还原"到与本名一致以便后续再改。
 */
function validatePetNickname(input: Partial<PetNicknameInput> | undefined): string {
  if (typeof input?.nickname !== "string") {
    throw AppError.badRequest(ErrorCodes.InvalidPetNickname, "宠物昵称必须是字符串")
  }
  // 去除所有 Unicode 空白（含 \t \n 全角空格等）
  const stripped = input.nickname.replace(/\s+/g, "")
  if (stripped.length === 0) {
    throw AppError.badRequest(ErrorCodes.InvalidPetNickname, "宠物昵称不能为空")
  }
  if (stripped.length > PET_NICKNAME_MAX_LEN) {
    throw AppError.badRequest(
      ErrorCodes.InvalidPetNickname,
      `宠物昵称不能超过 ${PET_NICKNAME_MAX_LEN} 字`,
    )
  }
  return stripped
}

/**
 * 校验测评反馈参数（PRD §3.3）：
 *   - accepted 必须是布尔（true=很符合 / false=测的不准）；
 *   - mbti 必须是 16 型之一（前端传的是结果页正在展示的人格）；
 *   - subtype 必须是 stable / sensitive；
 *   - comment 可选，字符串且 ≤200 字（去首尾空格；空串按未填处理）。
 */
function validateFeedback(input: Partial<FeedbackInput> | undefined): FeedbackInput {
  const { mbti, subtype, accepted, comment } = input ?? {}

  if (typeof accepted !== "boolean") {
    throw AppError.badRequest(ErrorCodes.InvalidFeedback, "accepted 必须是布尔值")
  }
  if (typeof mbti !== "string" || !MBTI_TYPES.has(mbti.toUpperCase())) {
    throw AppError.badRequest(ErrorCodes.InvalidFeedback, "mbti 必须是 16 型之一")
  }
  if (typeof subtype !== "string" || !SUBTYPES.has(subtype as Subtype)) {
    throw AppError.badRequest(ErrorCodes.InvalidFeedback, "subtype 必须是 stable 或 sensitive")
  }
  const result: FeedbackInput = {
    mbti: mbti.toUpperCase() as Personality,
    subtype: subtype as Subtype,
    accepted,
  }
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== "string") {
      throw AppError.badRequest(ErrorCodes.InvalidFeedback, "comment 必须是字符串")
    }
    const trimmed = comment.trim()
    if (trimmed.length > FEEDBACK_COMMENT_MAX_LEN) {
      throw AppError.badRequest(
        ErrorCodes.InvalidFeedback,
        `comment 不能超过 ${FEEDBACK_COMMENT_MAX_LEN} 字`,
      )
    }
    if (trimmed.length > 0) result.comment = trimmed
  }
  return result
}

/**
 * 取人格速查卡：mbti 已设时返回 pet_name/animal，否则两者都为 null。
 * 失败兜底（人格资产缺失时）用"伙伴/未知"，避免 500 阻塞主链路；与 buildSystemPrompt 同策略。
 *
 * personasDir：内嵌打包场景由主进程注入（打包后 data/ 在 process.resourcesPath 下）；
 * 不传时 loadPersonaCard 内部按 env / import.meta.url 解析。owner 实测「我的」页显示
 * "未知/伙伴" 就是因为打包后这里 catch 到了路径错误走了兜底。
 */
function readPersonaMeta(
  mbti: Personality | null,
  personasDir?: string,
): { pet_name: string | null; animal: string | null } {
  if (!mbti) return { pet_name: null, animal: null }
  try {
    const card = loadPersonaCard(mbti, personasDir)
    return { pet_name: card.pet_name, animal: card.animal }
  } catch (err) {
    console.warn(`[server] 人格速查卡加载失败（mbti=${mbti}，dir=${personasDir ?? "auto"}）：`, err)
    return { pet_name: "伙伴", animal: "未知" }
  }
}

/** 把 UserRow 转成对外 DTO（含 hasProfile + 宠物昵称 + 下次可改时间 + 动物本名） */
function toMeResponse(user: UserRow, nowSec: number, personasDir?: string): MeResponse {
  const persona = readPersonaMeta(user.mbti, personasDir)
  return {
    ok: true,
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    mbti: user.mbti,
    subtype: user.subtype,
    hasProfile: !!user.mbti && !!user.nickname && !!user.subtype,
    pet_nickname: user.pet_nickname,
    pet_nickname_changed_at: user.pet_nickname_changed_at,
    next_change_at: computeNextChangeAt(user.pet_nickname_changed_at, nowSec),
    pet_name: persona.pet_name,
    animal: persona.animal,
  }
}

/** 把 UserRow 转成宠物昵称接口的窄响应 */
function toPetNicknameResponse(user: UserRow, nowSec: number): PetNicknameResponse {
  return {
    ok: true,
    pet_nickname: user.pet_nickname,
    pet_nickname_changed_at: user.pet_nickname_changed_at,
    next_change_at: computeNextChangeAt(user.pet_nickname_changed_at, nowSec),
  }
}

/** 构造 /me 系列路由 */
export function createMeRouter(deps: MeRouterDeps): RouterType {
  const router = Router()
  const { db, personasDir } = deps

  // GET / —— 当前用户信息（含宠物昵称 + 下次可改时间）
  router.get("/", (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      const user = findUserOrThrow(db, userId)
      const dto = toMeResponse(user, Math.floor(Date.now() / 1000), personasDir)
      res.json(dto satisfies ApiResponse<MeResponse>)
    } catch (err) {
      next(err)
    }
  })

  // POST /profile —— 初始化写档 / 重测更新（UPSERT）
  // M4 P2-025 + Bug 1 修复：写档端点改为 UPSERT 语义——
  //   - 首次写档：写入 nickname/mbti/subtype（沿用 M2/M3 行为）；
  //   - 已写档后再调（如重测人格走 ResultPage → saveProfile）：视为更新 mbti/subtype，
  //     nickname 与已有值一致时保留，不一致也允许覆盖（用户主动改昵称走 nickname 单独接口）。
  //   - 不再做 409 拦截；保持单一 POST 端点语义最简。
  // 防并发误用的基本校验保留：
  //   - 必须鉴权（requireAuth 在 app.ts 挂载）；
  //   - body 字段必须有合法 nickname / mbti / subtype（validateProfile）；
  //   - 用户必须存在（findUserOrThrow 已抛 404）。
  router.post("/profile", (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      // 必须用户存在；不存在直接 404（不暴露任何档案信息）
      findUserOrThrow(db, userId)
      const profile = validateProfile(req.body as Partial<ProfileInput> | undefined)

      db.prepare(
        "UPDATE users SET nickname = ?, mbti = ?, subtype = ? WHERE id = ?",
      ).run(profile.nickname, profile.mbti, profile.subtype, userId)

      const updated = findUserOrThrow(db, userId)
      const dto = toMeResponse(updated, Math.floor(Date.now() / 1000), personasDir)
      res.json(dto satisfies ApiResponse<MeResponse>)
    } catch (err) {
      next(err)
    }
  })

  // POST /pet-nickname —— 修改宠物昵称（72h 冷却；首次设置不受限）
  //
  // 行为契约：
  //   1. 校验昵称 1-8 字、过滤空白；
  //   2. 读取 users.pet_nickname_changed_at：
  //      - 0 或 null（从未改过）：直接写入，changed_at = now，返回 200；
  //      - > 0：若 now - changed_at ≥ 72h → 写入新值与新 changed_at；
  //              否则返回 429 + 剩余秒数（next_change_at - now）一并塞 error.extra。
  //   3. 写入后再次 SELECT 拿到完整行，回给前端完整 PetNicknameResponse。
  router.post("/pet-nickname", (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      const nickname = validatePetNickname(req.body as Partial<PetNicknameInput> | undefined)
      const nowSec = Math.floor(Date.now() / 1000)
      const existing = findUserOrThrow(db, userId)

      if (existing.pet_nickname_changed_at > 0) {
        const next = computeNextChangeAt(existing.pet_nickname_changed_at, nowSec)
        if (nowSec < next) {
          const remainSec = next - nowSec
          throw AppError.cooldown(
            ErrorCodes.PetNicknameCooldown,
            `宠物昵称冷却中，剩余 ${remainSec} 秒可修改`,
            { remainSec, nextChangeAt: next },
          )
        }
      }

      db.prepare(
        "UPDATE users SET pet_nickname = ?, pet_nickname_changed_at = ? WHERE id = ?",
      ).run(nickname, nowSec, userId)

      const updated = findUserOrThrow(db, userId)
      const dto = toPetNicknameResponse(updated, nowSec)
      res.json(dto satisfies ApiResponse<PetNicknameResponse>)
    } catch (err) {
      next(err)
    }
  })

  // POST /feedback —— 结果页「很符合 / 测的不准」反馈（PRD §3.3 题库迭代核心数据）
  //
  // 行为契约：
  //   1. 鉴权（app.ts 挂 requireAuth）；用户必须存在（否则 404，避免写出孤儿外键行）；
  //   2. body：{ mbti, subtype, accepted: boolean, comment? }，校验见 validateFeedback；
  //   3. 落库 test_feedback（accepted 存 0/1），同一用户可重复反馈，全部留痕；
  //   4. 返回 { ok, recorded_at }，前端只用它确认"反馈已记录"。
  //
  // 明确不做的事（P0-006 红线）：本接口只写库，**绝不**触发任何窗口/流程状态变更；
  // 用户点完反馈仍停留在结果页，由用户自己点「完成」才进入桌宠窗。
  router.post("/feedback", (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      findUserOrThrow(db, userId)
      const feedback = validateFeedback(req.body as Partial<FeedbackInput> | undefined)

      const info = db
        .prepare(
          `INSERT INTO test_feedback (user_id, mbti, subtype, accepted, comment)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          feedback.mbti,
          feedback.subtype,
          feedback.accepted ? 1 : 0,
          feedback.comment ?? null,
        )

      const row = db
        .prepare(`SELECT created_at FROM test_feedback WHERE id = ?`)
        .get(Number(info.lastInsertRowid)) as { created_at: string } | undefined

      const dto: FeedbackResponse = {
        ok: true,
        recorded_at: row?.created_at ?? new Date().toISOString(),
      }
      res.json(dto satisfies ApiResponse<FeedbackResponse>)
    } catch (err) {
      next(err)
    }
  })

  return router
}