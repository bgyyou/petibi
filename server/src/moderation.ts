// 【文件说明】内容审核管道接口（M4 社区广场 + 红线 R7）
//
// 背景：PRD §3.7 社区广场所有 UGC（海报文案 + 留言）必须经审核才能上墙展示。
// 设计要点：
//   - 抽象 ModerationProvider：moderateText / moderateImage → pass / reject
//   - 默认实现 LocalModeration：基于 data/sensitive-words.json 的敏感词匹配
//     + 图片 MVP 期一律放行（仅做 base64 合法性校验，**真机审留接口位**）
//   - 云厂商实现（AliyunGreen / TencentIMS）走 PETIBI_MODERATION_PROVIDER 切换，
//     **密钥不进仓库**，从 env 读取
//   - 关键不变量：**status != approved 的内容任何列表接口都不可见**（在 routes/posters.ts
//     的查询里强制 status='approved'，不依赖业务代码"记得过滤"）

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 审核单条结果 */
export interface ModerationResult {
  /** pass 通过 / reject 拒绝 */
  decision: "pass" | "reject"
  /** 命中类目（pass 时可能为空） */
  category?: string
  /** 命中关键词（pass 时可能为空；仅 local 实现能精确给出，云厂商一般给类目） */
  matchedKeyword?: string
  /** 拒绝原因（人类可读；reject 时必填，pass 时可填 "ok"） */
  reason: string
  /** 实际执行的 provider 标识（"local" / "aliyun" / "tencent"），用于审计日志 */
  provider: string
}

/**
 * 审核 Provider 抽象接口。
 * 实现必须返回 ModerationResult；任何异常应该走 reject 而非向上抛，
 * 让上游路由统一把它映射成 4xx 而非 500，避免审核服务挂掉阻塞整个写入。
 */
export interface ModerationProvider {
  /** provider 标识，用于写 moderation_logs.provider 字段 */
  readonly name: string
  /** 审核纯文本内容 */
  moderateText(text: string): Promise<ModerationResult>
  /** 审核图片（data URL 或 base64 串；MVP 期 LocalModeration 一律 pass，仅做格式校验） */
  moderateImage(imageBase64: string): Promise<ModerationResult>
}

/** 敏感词库文件结构（与 data/sensitive-words.json 对齐） */
interface SensitiveCategory {
  name: string
  description: string
  keywords: string[]
}
interface SensitiveWordsFile {
  categories: SensitiveCategory[]
}

/** 解析敏感词库 JSON；可注入自定义路径便于单测。
 *
 * M4 内嵌兼容：
 *   - dev / tsx 跑 CLI 时：import.meta.url 指向 src/moderation.ts，能用相对路径解析到 data/；
 *   - CJS bundle（esbuild 产物）：import.meta.url 为空字符串，dirname 解析失败。
 *     内嵌场景必须显式传 jsonPath（由主进程在 startServer 时注入）。
 *   - 优先级：显式参数 > PETIBI_SENSITIVE_WORDS_PATH 环境变量 > import.meta.url 相对路径。
 *   - 全部失败时返回空敏感词库（审核始终 pass），并打 warning；embed prod 不应该走到这条分支，
 *     主进程必须传路径。
 */
export function loadSensitiveWords(jsonPath?: string): SensitiveWordsFile {
  let finalPath = jsonPath ?? process.env["PETIBI_SENSITIVE_WORDS_PATH"]
  if (!finalPath) {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const serverRoot = join(here, "..")
      const projectRoot = join(serverRoot, "..")
      finalPath = join(projectRoot, "data", "sensitive-words.json")
    } catch {
      finalPath = ""
    }
  }
  if (!finalPath) {
    console.warn("[moderation] 找不到敏感词库路径（jsonPath 未传 + import.meta.url 不可用 + 环境变量未设），将跳过敏感词审核")
    return { categories: [] }
  }
  try {
    const raw = readFileSync(finalPath, "utf-8")
    return JSON.parse(raw) as SensitiveWordsFile
  } catch (err) {
    console.warn(`[moderation] 读取敏感词库失败：${finalPath}（${err instanceof Error ? err.message : String(err)}）`)
    return { categories: [] }
  }
}

/**
 * 本地审核实现：基于敏感词库的子串匹配。
 * 策略：
 *   1. 大小写不敏感（统一 toLowerCase 比较），兼容英文大小写绕开；
 *   2. 命中即返回 reject + category + matchedKeyword + reason；
 *   3. 留白 + 标点过滤后做匹配，兼容"加 微 信"这种加空格的简单绕过；
 *   4. **不**做语义级审核——那是云厂商的活，LocalModeration 只是 MVP 占位。
 * 5. 图片审核：MVP 期一律 pass，但会校验 base64 格式合法性。
 */
export class LocalModeration implements ModerationProvider {
  public readonly name = "local"
  private readonly words: SensitiveWordsFile

  constructor(jsonPath?: string) {
    this.words = loadSensitiveWords(jsonPath)
  }

  /**
   * 工具：把字符串里的空白（含全角空格 / 中文逗号等）去掉，方便对抗"加 微 信"绕过
   * 同时保留原始字符串用于回显 matched_keyword
   */
  private static normalize(text: string): string {
    return text
      .replace(/[\s\u3000]+/g, "") // 空格/全角空格/连续空白
      .replace(/[,，.。!！?？;；:：、]/g, "") // 常见标点
      .toLowerCase()
  }

  async moderateText(text: string): Promise<ModerationResult> {
    if (typeof text !== "string" || text.length === 0) {
      // 空文本不放行（避免空留言灌水），按 reject 处理
      return {
        decision: "reject",
        category: "empty",
        reason: "内容为空",
        provider: this.name,
      }
    }
    const normalized = LocalModeration.normalize(text)
    for (const cat of this.words.categories) {
      for (const kw of cat.keywords) {
        if (kw.length === 0) continue
        const kwNorm = LocalModeration.normalize(kw)
        if (normalized.includes(kwNorm)) {
          return {
            decision: "reject",
            category: cat.name,
            matchedKeyword: kw,
            reason: `命中本地敏感词库（类目=${cat.name}）`,
            provider: this.name,
          }
        }
      }
    }
    return {
      decision: "pass",
      category: "ok",
      reason: "本地词库未命中",
      provider: this.name,
    }
  }

  async moderateImage(_imageBase64: string): Promise<ModerationResult> {
    // MVP 期：图片一律按 pass 处理（base64 合法性校验在路由层做）。
    // 真机审留位：未来切 AliyunGreen / TencentIMS 时改这一个方法即可。
    return {
      decision: "pass",
      category: "ok",
      reason: "图片 MVP 期本地放行（依赖人工后审标记 + 云厂商预留）",
      provider: this.name,
    }
  }
}

/**
 * Provider 工厂：从 env PETIBI_MODERATION_PROVIDER 选择实现。
 * 当前只实现 "local"；后续接 "aliyun" / "tencent" 时按 env 读取密钥即可。
 * **密钥永远不进仓库**：env 缺失时降级回 local，避免误配导致 500。
 */
export function createModerationProvider(): ModerationProvider {
  const choice = (process.env["PETIBI_MODERATION_PROVIDER"] ?? "local").toLowerCase()
  switch (choice) {
    case "local":
    default:
      return new LocalModeration()
    // case "aliyun": return new AliyunGreenModeration({...})  // 后续接入
    // case "tencent": return new TencentIMSModeration({...})  // 后续接入
  }
}
