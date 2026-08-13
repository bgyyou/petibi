// 【文件说明】POST /api/chat 路由实现：契约 §4 主对话链路 + M3 流式守卫与三档工单。
//
// 流程（按顺序执行，按 M3 流式守卫与三档工单改造后）：
//   1. 鉴权中间件 requireAuth 注入 req.user（JWT 解析后挂载）
//   2. 查 users 行（userId），未写档直接 409
//   3. 准备 SSE 响应头
//   4. 意图过滤（intent-filter.ts）：命中 → 流式返回拒绝模板，扣配额，记日志（refused=1）
//   5. 配额（quota.ts）：未命中过滤才进入；消耗计数
//   6. RAG 检索（rag.ts）：闲聊跳过；否则检索 Top 1
//   7. 档位判定（output-guard.decideReplyTier）：闲聊档 / 标准档 / 深度档
//   8. **立即发 meta 事件**（恢复 0.3s 思考动画；guard_hit=false）
//   9. 拼 prompt（personas 基础层 + 人格层 + 档位指令 + RAG 上下文）
//  10. 流式调 LLM（llm.ts），**边生成边推 delta**，**同时增量检查守卫**
//        - 硬截断（代码块 / 出戏词 / 超档位 1.2 倍）→ 立即掐断，改发 guard 事件 + 该人格拒绝模板
//        - 软截断（到档位上限未达 1.2 倍）→ 推完当前 delta 后追加 "……" 省略号终止（不算 guard_hit）
//  11. 终检 applyOutputGuard(question, accumulated, filter)：兜底 inject_fallback（理论上入口已拒，
//      但作为纵深防御再扫一次 question 是否带 inject 关键词漏到 LLM）
//  12. 落 chat_logs（含 rag_entry_id / refused / guard_hit）
//  13. 发 done 事件（guard_hit=true 表示本次最终被守卫命中）
//
// 响应格式：SSE（text/event-stream），每行 `data: <json>\n\n`。
// 首条事件 meta 在意图/RAG 通过后立即发（不等待 LLM），触发 0.3s 思考动画。

import { Router, type Request, type Response } from "express"
import { AppError, ErrorCodes, type ApiResponse } from "../errors.js"
import type { Db } from "../db.js"
import type { LlmConfig } from "../config.js"
import { userIdFromRequest } from "../middleware.js"
import { checkIntent, isChitchat, loadIntentFilter, refusalCategory } from "../intent-filter.js"
import { formatEntryForPrompt, loadAllEncyclopediaFiles, retrieveTop1 } from "../rag.js"
import { buildSystemPrompt, buildTierInstruction, loadPersonaCard } from "../personas.js"
import { loadRefusals, pickRefusal } from "../refusals.js"
import { streamLlm, isMockMode } from "../llm.js"
import { consumeOrThrowQuota, getTodayUsage, QuotaExceeded } from "../quota.js"
import {
  applyOutputGuard,
  createStreamGuard,
  decideReplyTier,
  hardLimitFor,
  refusalForGuard,
  TIER_MAX_CHARS,
  TIER_MAX_TOKENS,
  type ReplyTier,
} from "../output-guard.js"
import type {
  EncyclopediaFile,
  IntentFilterFile,
  Personality,
  RefusalsFile,
  SseEvent,
  UserRow,
} from "../types.js"

/** 模块级缓存：词库与百科在进程启动期一次加载，路由调用直接复用 */
let intentFilter: IntentFilterFile | null = null
let refusals: RefusalsFile | null = null
let encyclopedia: EncyclopediaFile[] | null = null

function getIntentFilter(): IntentFilterFile {
  if (!intentFilter) intentFilter = loadIntentFilter()
  return intentFilter
}
function getRefusals(): RefusalsFile {
  if (!refusals) refusals = loadRefusals()
  return refusals
}
function getEncyclopedia(): EncyclopediaFile[] {
  if (!encyclopedia) encyclopedia = loadAllEncyclopediaFiles()
  return encyclopedia
}

/** SSE 写入工具：序列化 SseEvent 并 flush */
function sseWrite(res: Response, event: SseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** 推一段 LLM 文本给前端（仅做 JSON 包装，不做切片） */
function sseDelta(res: Response, text: string): void {
  sseWrite(res, { type: "delta", text })
}

/** router 工厂：注入 LLM 配置（key/baseUrl/model/forceMock） + DB + dailyQuota */
export function createChatRouter(options: {
  db: Db
  llm: LlmConfig
  dailyQuota: number
}) {
  const router = Router()
  const { db, llm, dailyQuota } = options

  // 公共：查 user 行 + 检查 profile 完整性
  function loadUserOrFail(userId: number): UserRow {
    const raw = db
      .prepare(`SELECT id, email, nickname, mbti, subtype, created_at FROM users WHERE id = ?`)
      .get(userId)
    const user = (raw ?? undefined) as UserRow | undefined
    if (!user) {
      throw AppError.notFound(ErrorCodes.UserNotFound, "用户不存在")
    }
    return user
  }

  // POST / —— 对话主入口（挂载点 /api/chat，内部路径 /）
  router.post("/", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { question?: string }
      const question = (body.question ?? "").trim()
      if (!question) {
        res.status(400).json({
          ok: false,
          error: { code: ErrorCodes.BadRequest, message: "question is required" },
        } satisfies ApiResponse<never>)
        return
      }

      // 鉴权：JWT 中间件已在 mount 点挂载，req.user 必有；userId 不可解析时抛 401
      const userId = userIdFromRequest(req)
      const user = loadUserOrFail(userId)
      if (!user.mbti || !user.subtype || !user.nickname) {
        // profile 不全 → 强制先写档；前端可捕获此 409 跳初始化
        res.status(409).json({
          ok: false,
          error: { code: ErrorCodes.InvalidProfile, message: "profile not initialized; complete /api/me/profile first" },
        } satisfies ApiResponse<never>)
        return
      }

      // 准备 SSE 响应头
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
      res.setHeader("Cache-Control", "no-cache, no-transform")
      res.setHeader("Connection", "keep-alive")
      // flush headers
      res.flushHeaders?.()

      const mockMode = isMockMode(llm.apiKey, llm.forceMock)
      if (mockMode) {
        // 标注 mock，方便前端/日志识别
        res.write(`: mock mode\n\n`)
      }

      // 1) 意图过滤
      const filter = getIntentFilter()
      const hit = checkIntent(question, filter)
      if (hit) {
        // inject 类别复用 roleplay 模板（refusalCategory 内部映射）
        const refusal = pickRefusal(user.mbti as Personality, refusalCategory(hit.category), getRefusals())
        // 计次（命中越界仍扣配额，契约 §4）
        try {
          consumeOrThrowQuota(db, user.id, dailyQuota)
        } catch (e) {
          if (e instanceof QuotaExceeded) {
            sseWrite(res, { type: "error", message: e.message })
            res.end()
            return
          }
          throw e
        }
        // meta + 流式输出（按字切片模拟流式，让前端能看到打字效果）
        sseWrite(res, { type: "meta", rag_entry_id: null, refused: true, guard_hit: false })
        sseStreamText(res, refusal)
        const insertLog = db.prepare(
          `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit) VALUES (?, ?, ?, NULL, 1, 0)`,
        )
        insertLog.run(user.id, question, refusal)
        sseWrite(res, { type: "done", total_chars: refusal.length, guard_hit: false })
        res.end()
        return
      }

      // 2) 配额检查（计次）
      try {
        consumeOrThrowQuota(db, user.id, dailyQuota)
      } catch (e) {
        if (e instanceof QuotaExceeded) {
          sseWrite(res, { type: "error", message: e.message })
          res.end()
          return
        }
        throw e
      }

      // 3) RAG 检索：闲聊跳过
      const chitchat = isChitchat(question, filter)
      const ragResult = chitchat ? null : retrieveTop1(question, getEncyclopedia())
      const ragEntryId = ragResult?.entry.id ?? null

      // 4) 档位判定（P2-022）：闲聊档 / 标准档 / 深度档
      const tier: ReplyTier = decideReplyTier(question, filter)
      const tierMaxChars = TIER_MAX_CHARS[tier]
      const tierMaxTokens = TIER_MAX_TOKENS[tier]

      // 5) 立即发 meta 事件（恢复 0.3s 思考动画；guard_hit=false）
      // 必须在 LLM 之前发：前端拿 meta 就启动思考动画，不必等首字
      sseWrite(res, { type: "meta", rag_entry_id: ragEntryId, refused: false, guard_hit: false })

      // 6) 拼 prompt：基础层 + 人格层 + 档位指令 + RAG 上下文
      const personaCard = (() => {
        try {
          return loadPersonaCard(user.mbti as Personality)
        } catch {
          return null
        }
      })()
      const systemBase = buildSystemPrompt(
        user.mbti as Personality,
        personaCard ? { [user.mbti as Personality]: personaCard } : undefined,
      )
      const tierInstruction = buildTierInstruction(tier)
      const system = tierInstruction ? `${systemBase}\n\n${tierInstruction}` : systemBase
      const ragCtx = ragResult
        ? "\n\n" + formatEntryForPrompt(ragResult.entry, ragResult.personality)
        : ""
      const userContent = `【用户问题】${question}${ragCtx}`

      // 7) 流式调 LLM + 增量守卫 + 软截断省略号
      //    关键改造：每个 delta 立即推给前端，同时累计到流式守卫做硬截断检查
      const guard = createStreamGuard(tierMaxChars)
      let guardHit = false
      let guardReasonText = ""
      let guardRefusalText = ""
      let pushedChars = 0

      try {
        for await (const chunk of streamLlm(
          { system, user: userContent, maxTokens: tierMaxTokens },
          {
            apiKey: llm.apiKey,
            baseUrl: llm.baseUrl,
            model: llm.model,
            forceMock: llm.forceMock,
          },
        )) {
          if (chunk.done) break
          if (!chunk.delta) continue
          const r = guard.feed(chunk.delta)
          if (r.hardStop) {
            // 硬截断：丢弃剩余 LLM 输出，改发 guard 事件 + 拒绝模板
            guardHit = true
            guardReasonText = r.hardReason ?? "unknown"
            guardRefusalText = pickRefusal(user.mbti as Personality, refusalForGuard(), getRefusals())
            sseWrite(res, {
              type: "guard",
              reason: guardReasonText,
              text: guardRefusalText,
            })
            break
          }
          if (guard.isEllipsisSent()) {
            // 已发过省略号：后续 delta 仅用于持续检测守卫，不再推前端
            continue
          }
          // 正常推 delta
          sseDelta(res, chunk.delta)
          pushedChars += chunk.delta.length
          // 软截断：本次推完后追加 "……" 省略号（一次性）
          if (guard.isSoftLimitReached()) {
            sseDelta(res, "……")
            guard.markEllipsisSent()
            pushedChars += "……".length
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "LLM 调用失败"
        sseWrite(res, { type: "error", message: msg })
        res.end()
        return
      }

      // 8) 终检：流式阶段只查 LLM delta；终检再跑一次 applyOutputGuard 兜底
      //    （理论上入口已拒 inject 不会漏到 LLM，但作为纵深防御再确认一次）
      //    too_long 阈值按档位硬限（tier × 1.2）传入，与流式守卫阈值保持一致；
      //    这样软截断区累积的"略超档位上限"文本不会被终检误判为 too_long。
      //    注意：只在 LLM 实际产生了输出时做终检；硬截断时 guardRefusalText 已知不再查
      let finalAnswer: string
      if (guardHit) {
        finalAnswer = guardRefusalText
      } else {
        const accumulated = guard.accumulated()
        const finalCheck = applyOutputGuard(question, accumulated, filter, {
          maxLength: hardLimitFor(tier),
        })
        if (finalCheck.hit) {
          guardHit = true
          guardReasonText = finalCheck.reason ?? "unknown"
          guardRefusalText = pickRefusal(user.mbti as Personality, refusalForGuard(), getRefusals())
          sseWrite(res, {
            type: "guard",
            reason: guardReasonText,
            text: guardRefusalText,
          })
          finalAnswer = guardRefusalText
        } else {
          // 正常路径：以流式守卫累积的文本为准（含可能的 "……" 省略号）
          finalAnswer = accumulated
        }
      }

      // 9) 落 chat_logs
      const insertLog = db.prepare(
        `INSERT INTO chat_logs(user_id, question, answer, rag_entry_id, refused, guard_hit) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      insertLog.run(user.id, question, finalAnswer, ragEntryId, 0, guardHit ? 1 : 0)
      if (guardHit) {
        console.warn(
          `[chat.guard] user=${user.id} reason=${guardReasonText} evidence=${guard.hardStopEvidence() ?? ""} tier=${tier} q=${question.slice(0, 40)}`,
        )
      }

      // 10) done 事件：guard_hit=true 表示本次最终被守卫命中
      sseWrite(res, { type: "done", total_chars: finalAnswer.length, guard_hit: guardHit })
      res.end()
    } catch (err) {
      // 若已经发送了 SSE 头，不能再写普通 JSON；只能 flush headers 后再吞掉
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          // ignore
        }
        return
      }
      const msg = err instanceof Error ? err.message : "未知错误"
      res.status(500).json({
        ok: false,
        error: { code: ErrorCodes.Internal, message: msg },
      } satisfies ApiResponse<never>)
    }
  })

  // GET /quota —— 配额查询（保留 /api/chat/quota 作为兼容入口；主路由是 /api/quota）
  router.get("/quota", (req: Request, res: Response) => {
    try {
      const userId = userIdFromRequest(req)
      const used = getTodayUsage(db, userId)
      res.json({
        ok: true,
        date: new Date().toISOString().slice(0, 10),
        used,
        limit: dailyQuota,
        remaining: Math.max(0, dailyQuota - used),
      })
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.status).json({
          ok: false,
          error: { code: err.code, message: err.message },
        } satisfies ApiResponse<never>)
        return
      }
      const msg = err instanceof Error ? err.message : "未知错误"
      res.status(500).json({
        ok: false,
        error: { code: ErrorCodes.Internal, message: msg },
      } satisfies ApiResponse<never>)
    }
  })

  return router
}

/** 按 3 字/片段把回复切碎后流式推送给前端，模拟打字效果
 * （意图过滤命中的拒绝模板短文仍用此函数，给前端打字感）
 */
function sseStreamText(res: Response, text: string): void {
  let i = 0
  while (i < text.length) {
    const slice = text.slice(i, i + 3)
    sseWrite(res, { type: "delta", text: slice })
    i += 3
  }
}
