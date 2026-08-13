// 【文件说明】拒绝模板加载与选择：契约 §2 data/refusals.json 格式解析。
//
// 命中越界后，从 templates[personality][category] 中随机选一条返回给流式端。
// 模板尚未到位时使用统一兜底（保证人格化口吻：拒绝 + 引导回聊天）。

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Personality, RefusalsFile } from "./types.js"

/** 加载拒绝模板库；可注入路径便于单测 */
export function loadRefusals(jsonPath?: string): RefusalsFile {
  const here = dirname(fileURLToPath(import.meta.url))
  const serverRoot = join(here, "..")
  const projectRoot = join(serverRoot, "..")
  const finalPath = jsonPath ?? join(projectRoot, "data", "refusals.json")
  const raw = readFileSync(finalPath, "utf-8")
  return JSON.parse(raw) as RefusalsFile
}

/**
 * 选择一条人格化拒绝回复：
 *   - 命中人格 + 命中类别都有模板 → 随机取一条
 *   - 命中类别但本人格缺 → 取该类别第一条（不论人格，保底可演示）
 *   - 模板完全缺失 → 用兜底文案
 */
export function pickRefusal(
  personality: Personality,
  category: string,
  refusals: RefusalsFile
): string {
  const personaMap = refusals.templates[personality]
  if (personaMap) {
    const list = personaMap[category]
    if (list && list.length > 0) {
      const idx = Math.floor(Math.random() * list.length)
      return list[idx]!
    }
  }
  // 跨人格兜底：任意人格该类别首条
  for (const p of Object.keys(refusals.templates) as Personality[]) {
    const list = refusals.templates[p]?.[category]
    if (list && list.length > 0) return list[0]!
  }
  // 模板文件缺失或该类别无任何条目：返回通用兜底（人格化口吻 + 引导回聊天）
  return "这事不在我的世界里——但你愿意说说为什么想做吗？"
}