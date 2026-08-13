// 【文件说明】LLM 客户端：契约 §5 DeepSeek 兼容 OpenAI 接口 + 无 key 时 mock 流式。
//
// 接口约定（OpenAI Chat Completions stream）：
//   POST {base_url}/chat/completions
//   Headers: Authorization: Bearer {DEEPSEEK_API_KEY}
//   Body: { model, messages: [{role, content}], stream: true, max_tokens, temperature }
//   Response: text/event-stream，每个 chunk 一行 `data: {json}\n\n`，最后 `data: [DONE]\n\n`。
//
// mock 模式：未配置 DEEPSEEK_API_KEY 时逐字输出预设回复（便于前端联调与 CI 测试）。
// 输出 ≤150 字 由 prompt 字面约束 + max_tokens 兜底共同保证。

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LlmRequest {
  system: string
  user: string
  /** 估算的最大输出 token 数；中文 ≤150 字 ≈ 250 token，保守取 300 */
  maxTokens?: number
}

export interface LlmChunk {
  /** 增量文本片段（delta）；空串表示仅是心跳 */
  delta: string
  /** 是否为流末尾 */
  done: boolean
}

/** DeepSeek OpenAI 兼容端点（契约 §5：base_url 走环境变量，key 不进仓库） */
const DEFAULT_BASE_URL = "https://api.deepseek.com"
const DEFAULT_MODEL = "deepseek-chat"

/** 拼接 user 上下文：RAG 上下文以 user 角色追加在前，便于模型重点参考 */
export function buildMessages(req: LlmRequest): ChatMessage[] {
  return [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ]
}

/** 异步生成器：从 LLM 流读取增量文本 */
export type LlmStream = AsyncGenerator<LlmChunk, void, void>

/**
 * 调用 DeepSeek（OpenAI 兼容）并以异步生成器形式产出增量。
 * 网络/HTTP 错误向上抛，由路由层决定回 500 还是兜底为 mock。
 */
export async function* streamDeepSeek(
  req: LlmRequest,
  options: {
    apiKey: string
    baseUrl?: string
    model?: string
    signal?: AbortSignal
  }
): LlmStream {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const model = options.model ?? DEFAULT_MODEL
  const maxTokens = req.maxTokens ?? 300

  const body = {
    model,
    messages: buildMessages(req),
    stream: true,
    max_tokens: maxTokens,
    temperature: 0.7,
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "")
    throw new Error(`LLM upstream ${resp.status}: ${text.slice(0, 200)}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 协议：每条事件以 \n\n 分隔；我们只关心 data: 开头
      let idx: number
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const lines = event.split("\n")
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const payload = trimmed.slice(5).trim()
          if (payload === "[DONE]") {
            yield { delta: "", done: true }
            return
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[]
            }
            const content = json.choices?.[0]?.delta?.content
            if (content) yield { delta: content, done: false }
          } catch {
            // 非 JSON 行（如心跳 :keep-alive），忽略
          }
        }
      }
    }
    // 收尾：连接断开但未收到 [DONE]，仍视为结束
    yield { delta: "", done: true }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Mock 流式响应：把整段 mock 文本按 ~3 字/片段切片并加小延时，
 * 既模拟真实流式体感（首字延迟可被测试），又不引入额外 token 计数逻辑。
 */
export async function* streamMock(req: LlmRequest): LlmStream {
  const mockText = composeMockAnswer(req.user)
  // 按字符切：每 ~3 字一块；中文按字符、英文按 word 都自然
  const chunks: string[] = []
  for (let i = 0; i < mockText.length; i += 3) {
    chunks.push(mockText.slice(i, i + 3))
  }
  for (const c of chunks) {
    yield { delta: c, done: false }
    // 不真的 sleep，避免给测试带来不稳定的时延；测试需要稳定时长请自行注入
  }
  yield { delta: "", done: true }
}

/** 简易 mock 文案：根据问题长度与是否包含"心情/紧张/害怕"等关键词生成不同开头 */
function composeMockAnswer(question: string): string {
  const q = question.toLowerCase()
  if (q.includes("紧张") || q.includes("演讲")) {
    return "（mock）作为你，我习惯先在心里把讲稿拆成三条线，每条不超过两分钟——Ti 不喜欢失控感，先把结构搭稳，Ne 再去补现场的即兴。呼吸三次，开嗓，再开口。"
  }
  if (q.includes("你好") || q.includes("hi") || q.includes("嗨")) {
    return "（mock）嗨，今天想聊点什么？我听你安排。"
  }
  if (q.length < 6) {
    return "（mock）嗯，再多说两句？"
  }
  return "（mock）作为你这种人格，我通常会先把情绪放一边、找出一条最想达成的目标——然后挑阻力最小的那一步先走。试试看？"
}

/** 顶层入口：根据是否配置 key 自动选择真实 LLM 或 mock */
export async function* streamLlm(
  req: LlmRequest,
  options: { apiKey?: string; baseUrl?: string; model?: string; signal?: AbortSignal; forceMock?: boolean }
): LlmStream {
  if (options.forceMock || !options.apiKey) {
    yield { delta: "[mock] ", done: false }
    yield* streamMock(req)
    return
  }
  yield* streamDeepSeek(req, {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    signal: options.signal,
  })
}

/** 暴露给上层读取当前是否处于 mock 模式（用于日志标注） */
export function isMockMode(apiKey?: string, forceMock?: boolean): boolean {
  return Boolean(forceMock) || !apiKey
}