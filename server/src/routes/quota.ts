// 【文件说明】配额查询 HTTP 路由（合并自 M2 工单 routes/quota.ts；契约 §4）
// 路由：
//   GET / —— 返回今日剩余配额
// 实现：
//   - 不写库；只读 chat_usage + 用 ServerConfig.dailyQuota
//   - 前端对话开始前调用，先确认还有剩余次数再发起请求
//   - M5 工单：新增 disabled 字段（PETIBI_DISABLE_QUOTA=1 时为 true），
//     让前端可选地显示"测试期不计配额"。

import { Router } from "express"
import type { Router as RouterType, Request, Response, NextFunction } from "express"
import type { Db } from "../db.js"
import type { ServerConfig } from "../config.js"
import { userIdFromRequest } from "../middleware.js"
import { getTodayUsage } from "../quota.js"
import { todayDateString } from "../utils/date.js"
import type { ApiResponse } from "../errors.js"
import type { QuotaResponse } from "../types.js"

export interface QuotaRouterDeps {
  db: Db
  config: ServerConfig
}

/** 构造配额查询路由 */
export function createQuotaRouter(deps: QuotaRouterDeps): RouterType {
  const router = Router()
  const { db, config } = deps

  router.get("/", (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFromRequest(req)
      const now = new Date()
      const used = getTodayUsage(db, userId, todayDateString(now))
      const limit = config.dailyQuota
      const remaining = Math.max(0, limit - used)
      const dto: QuotaResponse = {
        ok: true,
        date: todayDateString(now),
        used,
        remaining,
        limit,
        disabled: config.disableQuota,
      }
      res.json(dto satisfies ApiResponse<QuotaResponse>)
    } catch (err) {
      next(err)
    }
  })

  return router
}