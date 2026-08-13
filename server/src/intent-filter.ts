// 【文件说明】意图过滤器：契约 §3 data/intent-filter.json 格式解析 + 关键词命中判定。
//
// 流程（PRD §3.4 边界）：
//   1. 遍历 rules，每条规则的 keywords 任一出现在 question 中即视为命中；
//   2. 命中则返回 { category, matched_keyword }，路由层据此选人格化拒绝模板并直接流式返回，不再调 LLM；
//   3. 未命中且 question 命中 rag_skip_patterns 中的某条闲聊模板，跳过 RAG 检索但仍调 LLM；
//   4. 其余情况正常走 RAG + LLM。
//
// 注入防御（M3 边界防御）：新增 category "inject"，覆盖 prompt injection 话术。
// 命中后路由层用 refusalCategory() 映射到 roleplay 拒绝模板（暂不复用新模板，复用现有
// 16×2 条 roleplay 文案；后续如需差异化口吻可扩展 refusals.json 的 "inject" 类）。

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { IntentFilterFile, IntentFilterHit } from "./types.js"

/** 解析 data/intent-filter.json：可被注入自定义路径，便于单测与未来多环境切换 */
export function loadIntentFilter(jsonPath?: string): IntentFilterFile {
  const here = dirname(fileURLToPath(import.meta.url))
  const serverRoot = join(here, "..")
  const projectRoot = join(serverRoot, "..")
  const finalPath = jsonPath ?? join(projectRoot, "data", "intent-filter.json")
  const raw = readFileSync(finalPath, "utf-8")
  return JSON.parse(raw) as IntentFilterFile
}

/** 单次关键词命中判定：返回首个命中规则的 category 与具体关键词，未命中返回 null */
export function checkIntent(question: string, filter: IntentFilterFile): IntentFilterHit | null {
  // 先把 question 转小写做大小写不敏感匹配；同时原始 case 用于回显
  const lower = question.toLowerCase()
  for (const rule of filter.rules) {
    for (const kw of rule.keywords) {
      // 直接用 includes：意图过滤不要追求严谨的"词边界"，
      // 因为越界关键词（如 "python"、"代码"）本身就是子串特征，宽松匹配覆盖更广
      if (lower.includes(kw.toLowerCase())) {
        return { category: rule.category, matched_keyword: kw }
      }
    }
  }
  return null
}

/** 是否属于闲聊（命中 rag_skip_patterns），闲聊仍可调 LLM 但跳过 RAG 检索 */
export function isChitchat(question: string, filter: IntentFilterFile): boolean {
  const trimmed = question.trim()
  for (const pattern of filter.rag_skip_patterns) {
    if (trimmed === pattern || trimmed.includes(pattern)) {
      return true
    }
  }
  return false
}

/**
 * 意图过滤的 category 命中后，映射到 refusal.json 里实际存在的 category。
 *   - 现有五类（code/homework/generate/web/roleplay）一一对应；
 *   - 新增的 "inject"（注入攻击）暂复用 roleplay 模板（已含"切换身份"语义，
 *     文案上自然能回应"假装你是/忽略之前指令"之类的话术）；
 *   - 未知 category 走兜底（由 pickRefusal 内部兜底文案兜底）。
 */
export function refusalCategory(hitCategory: string): string {
  switch (hitCategory) {
    case "code":
    case "homework":
    case "generate":
    case "web":
    case "roleplay":
      return hitCategory
    case "inject":
      return "roleplay"
    default:
      return hitCategory
  }
}