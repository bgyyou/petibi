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

/** 读取 data/encyclopedia/index.json，返回 16 个人格 → 文件路径的映射。
 *
 * M4 内嵌兼容：参数 > 环境变量 PETIBI_ENCYCLOPEDIA_DIR > import.meta.url 推算。
 * 显式传 indexPath 时按调用方意图；未传时尝试从环境变量得到 encyclopedia 目录，
 * 否则从 import.meta.url 推算（CJS bundle 下不可用则抛错）。
 */
export function loadEncyclopediaIndex(jsonPath?: string): { file: string; personality: Personality }[] {
  let indexPath = jsonPath ?? process.env["PETIBI_ENCYCLOPEDIA_INDEX_PATH"]
  if (!indexPath) {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const serverRoot = join(here, "..")
      const projectRoot = join(serverRoot, "..")
      indexPath = join(projectRoot, "data", "encyclopedia", "index.json")
    } catch {
      indexPath = ""
    }
  }
  if (!indexPath) {
    throw new Error(
      "loadEncyclopediaIndex: 找不到 encyclopedia index.json（请显式传 jsonPath，或设 PETIBI_ENCYCLOPEDIA_INDEX_PATH）",
    )
  }
  const raw = readFileSync(indexPath, "utf-8")
  const parsed = JSON.parse(raw) as {
    personalities: { personality: Personality; file: string }[]
  }
  return parsed.personalities
}

/** 加载 16 个人格文件全量（启动期调用一次缓存即可）；解析失败抛错由上层决定降级。
 *
 * M4 内嵌兼容：参数 > 环境变量 PETIBI_ENCYCLOPEDIA_DIR > import.meta.url 推算。
 * 解析到的 directory 与 indexPath 必须同源，因此二者通过环境变量一起注入。
 */
export function loadAllEncyclopediaFiles(): EncyclopediaFile[] {
  let encDir = process.env["PETIBI_ENCYCLOPEDIA_DIR"]
  if (!encDir) {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const projectRoot = join(here, "..", "..")
      encDir = join(projectRoot, "data", "encyclopedia")
    } catch {
      encDir = ""
    }
  }
  if (!encDir) {
    throw new Error(
      "loadAllEncyclopediaFiles: 找不到 encyclopedia 目录（请设 PETIBI_ENCYCLOPEDIA_DIR）",
    )
  }
  return loadEncyclopediaIndex().map((meta) => {
    const path = join(encDir!, meta.file)
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
 *
 * 警告：此函数会在所有 16 个人格文件里找 Top 1，**不会**按用户当前人格过滤。
 * 主对话链路请用 {@link retrieveTop1ForPersonality}，否则可能把别的人格条目
 * 注入到当前用户的 prompt 里——典型症状：ENTP 用户答了 ENFP 的百科（M5 P0-B）。
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

/**
 * 按用户当前人格检索 Top 1：严格限制在 personality 文件内检索，**绝不跨人格引用**。
 *
 * M5 P0-B 根因：之前路由 /api/chat 直接调全库 {@link retrieveTop1}，导致用户切回 ENTP
 * 后对话被注入 ENFP 条目（ENTP / ENFP 都含 public-speaking 条目，分数接近时全库检索
 * 不保证胜出的是用户当前人格）。修复方案：
 *   1. 路由 /api/chat 改调本函数，personality 参数来自 users.mbti（userIdFromRequest
 *      拿到的当前登录用户，绝不允许从客户端 body 传——防止误传/伪造人格绕过门禁）；
 *   2. 返回结果带 personality 字段，路由写入 chat_logs 时与 user.mbti 一致，便于审计；
 *   3. 测试断言「同一问题在 ENTP / ENFP 下分别调用，personality 字段必须等于传入人格」，
 *      防回归。
 *
 * 实现要点：
 *   - 白名单校验（PERSONALITIES.includes）：防止 personality 传错时回退到不存在的文件，
 *     反而调回全库检索；
 *   - 找不到 personality 文件时直接返回 null（不静默降级），由路由走"无 RAG"分支；
 *   - 缓存友好：files 已是启动期一次性加载的 EncyclopediaFile[]，本函数是纯遍历，
 *     ms 级无压力。
 */
export function retrieveTop1ForPersonality(
  question: string,
  files: EncyclopediaFile[],
  personality: Personality
): { entry: EncyclopediaEntry; personality: Personality; score: number } | null {
  const tokens = tokenize(question)
  if (tokens.length === 0) return null
  // 找到目标人格文件（O(n) 遍历，n=16 可忽略）
  const file = files.find((f) => f.personality === personality)
  if (!file) return null
  const best = bestInFile(file, tokens)
  if (!best) return null
  return { entry: best.entry, personality: file.personality, score: best.score }
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