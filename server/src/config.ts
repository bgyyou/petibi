// 【文件说明】后端运行配置：从环境变量读取所有可调项，提供本地开发默认值（合并自 M2 + M3 工单）
// 设计要点：
//   - 所有密钥 / 连接串都走 env，不进仓库（.env.example 占位）
//   - 提供默认值让 `npm run server:dev` 无需任何环境变量即可启动
//   - 单元测试可通过传入 overrides 覆盖关键项（如 JWT_SECRET、DB_PATH），保证用例确定性
//
// 字段命名沿用 PETIBI_* 前缀，与仓库根 .env.example 保持一致；
// M3 RAG 链路新增 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL / FORCE_MOCK 同样读取。

/** LLM 调用相关配置（M3 对话链路契约 §5） */
export interface LlmConfig {
  /** DeepSeek API key；缺失或为空时自动走 mock 流式 */
  apiKey?: string
  /** 兼容 OpenAI 接口的 base url，默认 https://api.deepseek.com */
  baseUrl?: string
  /** 模型名，默认 deepseek-chat */
  model?: string
  /** 强制 mock（CI / 联调用），不为 1 时不启用 */
  forceMock: boolean
}

/**
 * 服务端配置对象。生产部署时务必通过 env 覆盖 PETIBI_JWT_SECRET 与 PETIBI_DB_PATH。
 */
export interface ServerConfig {
  /** HTTP 监听端口，默认 8787（避开常见 3000/8080） */
  port: number
  /** 监听 host，默认 127.0.0.1（M2 阶段本地服务，不对外暴露） */
  host: string
  /** SQLite 数据库文件路径，默认 server/data/chat.db；":memory:" 仅用于测试 */
  dbPath: string
  /** JWT 签发 / 校验密钥（HS256）。生产必须设置；dev 模式用固定字符串兜底 */
  jwtSecret: string
  /** JWT 过期秒数，默认 30 天 */
  jwtExpiresInSec: number
  /** 邮箱验证码有效期（秒），默认 600 = 10 分钟（契约 §4 规定） */
  codeExpiresInSec: number
  /** 每日对话配额，默认 10（PRD §3.4 / REVIEW R4 红线） */
  dailyQuota: number
  /** LLM 调用配置（M3 工单新增） */
  llm: LlmConfig
  /** 当前运行环境：dev / prod / test */
  env: "dev" | "prod" | "test"
}

/**
 * 把字符串解析成正整数；非法则回退到 fallback。
 * 用于 env 注入，避免 NaN 钻进下游逻辑。
 */
function intFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 构造配置：从 process.env 读取，允许外部传入 overrides（测试场景）。
 *   - port / dbPath / jwtSecret 等都允许被覆盖
 *   - env = "test" 时自动用临时 db，避免污染真实数据
 */
export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = (overrides.env ??
    (process.env["PETIBI_ENV"] as ServerConfig["env"] | undefined) ??
    "dev") as ServerConfig["env"]

  // dev 与 test 都允许用默认值启动；prod 必须显式给 JWT_SECRET
  const defaultDbPath =
    env === "test" ? ":memory:" : "data/chat.db"

  const llm: LlmConfig = {
    apiKey: process.env["DEEPSEEK_API_KEY"] || undefined,
    baseUrl: process.env["DEEPSEEK_BASE_URL"] || undefined,
    model: process.env["DEEPSEEK_MODEL"] || undefined,
    forceMock: process.env["FORCE_MOCK"] === "1",
  }

  const config: ServerConfig = {
    port: intFromEnv(process.env["PETIBI_PORT"], 8787),
    host: process.env["PETIBI_HOST"] ?? "127.0.0.1",
    dbPath: process.env["PETIBI_DB_PATH"] ?? defaultDbPath,
    // dev/test 用固定 secret 保证可重入；prod 启动时若 secret 是兜底值则报警
    jwtSecret: process.env["PETIBI_JWT_SECRET"] ?? "petibi-dev-secret-change-me",
    jwtExpiresInSec: intFromEnv(process.env["PETIBI_JWT_EXPIRES"], 60 * 60 * 24 * 30),
    codeExpiresInSec: intFromEnv(process.env["PETIBI_CODE_EXPIRES"], 600),
    dailyQuota: intFromEnv(process.env["PETIBI_DAILY_QUOTA"], 10),
    llm,
    env,
  }

  // 浅覆盖：测试场景下可精准指定某几个字段，其他保持从 env 推断
  return {
    ...config,
    ...overrides,
    env: overrides.env ?? config.env,
    // llm 是对象，单独合并以防 overrides.llm 缺字段
    llm: { ...config.llm, ...(overrides.llm ?? {}) },
  }
}

/**
 * 默认配置实例：方便外部直接 import；测试场景请自行调用 loadConfig({...})。
 */
export const defaultConfig: ServerConfig = loadConfig()