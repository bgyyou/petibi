// 【文件说明】RAG 检索：契约 §4 描述的"关键词/tag 匹配打分取 Top 1"实现。
//
// 索引范围：data/encyclopedia/index.json 列出的全部 16 个人格文件。
// 打分逻辑（无外部依赖、无向量化）：
//   - 标题命中 +3
//   - 标签命中每个 +2
//   - scenario slug 命中 +4（场景词最直接）
//   - 正文关键词命中每个 +1（截断避免超长问题污染分数）
//   - 同一文件中只取单条得分最高的（Top 1 by 文件 + 内部条目）
// 取全库 Top 1（跨人格时让最近的人格条目自然胜出；用户人格自身的条目通常带人格前缀词，更易胜出）。
//
// 性能：MVP 阶段数据量小（411 条），纯 JS 遍历一次 ms 级，无需建索引。

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  EncyclopediaEntry,
  EncyclopediaFile,
  Personality,
} from "./types.js"

/** 读取 data/encyclopedia/index.json，返回 16 个人格 → 文件路径的映射 */
export function loadEncyclopediaIndex(jsonPath?: string): { file: string; personality: Personality }[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const serverRoot = join(here, "..")
  const projectRoot = join(serverRoot, "..")
  const indexPath = jsonPath ?? join(projectRoot, "data", "encyclopedia", "index.json")
  const raw = readFileSync(indexPath, "utf-8")
  const parsed = JSON.parse(raw) as {
    personalities: { personality: Personality; file: string }[]
  }
  return parsed.personalities
}

/** 加载 16 个人格文件全量（启动期调用一次缓存即可）；解析失败抛错由上层决定降级 */
export function loadAllEncyclopediaFiles(): EncyclopediaFile[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const projectRoot = join(here, "..", "..")
  const encDir = join(projectRoot, "data", "encyclopedia")
  return loadEncyclopediaIndex().map((meta) => {
    const path = join(encDir, meta.file)
    const raw = readFileSync(path, "utf-8")
    return JSON.parse(raw) as EncyclopediaFile
  })
}

/** 简易分词：英文按空格切词；中文按字符 + 二元组（bigram），避免引入 jieba 等重依赖
 *  - 中文最小语义单元常常是 2 字（如"演讲"、"分手"、"团队"），单字过散易误命中，二元组更稳；
 *  - 标点统一去除；空串过滤。返回的 token 同时含 1 字 / 2 字，命中标签时更宽容。
 */
function tokenize(question: string): string[] {
  const cleaned = question.replace(/[\p{P}\p{S}]/gu, " ").toLowerCase()
  const tokens: string[] = []
  // 英文/数字 token：按空白切
  for (const w of cleaned.split(/\s+/)) {
    if (w) tokens.push(w)
  }
  // 中文连续段：字符 bigram + 单字
  for (const seg of cleaned.split(/\s+/)) {
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i]!
      // 仅 CJK 字符做 bigram
      if (/[\u4e00-\u9fff]/.test(ch)) {
        tokens.push(ch)
        const next = seg[i + 1]
        if (next && /[\u4e00-\u9fff]/.test(next)) {
          tokens.push(ch + next)
        }
      }
    }
  }
  return tokens
}

/** 单条条目的得分 */
function scoreEntry(entry: EncyclopediaEntry, tokens: string[]): number {
  let score = 0
  const titleLow = entry.title.toLowerCase()
  for (const t of tokens) {
    if (!t) continue
    // 标题命中：3 分
    if (titleLow.includes(t)) score += 3
    // 标签命中：每个标签 +2（不重复计同标签）
    for (const tag of entry.tags) {
      if (tag.toLowerCase() === t) score += 2
    }
    // scenario slug 命中：4 分（场景词最直接）
    if (entry.scenario && entry.scenario.toLowerCase() === t) score += 4
    // 正文命中：每个 token +1
    if (entry.content.toLowerCase().includes(t)) score += 1
  }
  return score
}

/** 在单个百科文件中找最佳条目 */
function bestInFile(file: EncyclopediaFile, tokens: string[]): { entry: EncyclopediaEntry; score: number } | null {
  let best: { entry: EncyclopediaEntry; score: number } | null = null
  for (const e of file.entries) {
    const s = scoreEntry(e, tokens)
    if (s > 0 && (!best || s > best.score)) {
      best = { entry: e, score: s }
    }
  }
  return best
}

/**
 * 跨全库检索 Top 1：返回最佳条目及所属人格。
 * 当用户问题与任何条目都无交集时返回 null（调用方应降级为不注入 RAG 上下文）。
 */
export function retrieveTop1(
  question: string,
  files: EncyclopediaFile[]
): { entry: EncyclopediaEntry; personality: Personality; score: number } | null {
  const tokens = tokenize(question)
  if (tokens.length === 0) return null
  let top: { entry: EncyclopediaEntry; personality: Personality; score: number } | null = null
  for (const f of files) {
    const best = bestInFile(f, tokens)
    if (!best) continue
    if (!top || best.score > top.score) {
      top = { entry: best.entry, personality: f.personality, score: best.score }
    }
  }
  return top
}

/** 把检索到的条目渲染成 LLM 上下文片段（带人格/标题/正文/标签） */
export function formatEntryForPrompt(entry: EncyclopediaEntry, personality: Personality): string {
  // 用纯文本模板，便于 LLM 直接消费；正文不裁剪，模型自身有 150 字输出约束
  return [
    `【百科参考｜${personality}｜${entry.title}】`,
    `分类：${entry.category}；标签：${entry.tags.join("、") || "无"}；场景：${entry.scenario ?? "通用"}`,
    entry.content,
  ].join("\n")
}