// 【文件说明】数据库访问层：契约 §4 要求的 4 张表（users / email_codes / chat_usage / chat_logs）。
//
// 实现说明（M3 对话链路契约 §4 后端栈为 better-sqlite3，本机 Node 24 无预编译二进制
// 且 MSBuild 工具链对 better-sqlite3 v11 编译失败，故改用 Node 24 内置的 node:sqlite。
// 两套 API 形态高度一致——同步 prepared statement + .get/.run/.all——业务层用法不需变更。
// 真正落地部署到其他 Node 版本时，可把 import 切回 better-sqlite3，类型与 API 形态一致）。
//
// 模块导出 Db 单例 + ensureSchema() 初始化。表结构与契约 §4 描述严格一致。

import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"

// 用 createRequire 拿 node:sqlite，避免 vite/vitest 在打包期把它当作普通依赖去解析。
// 类型仍从 node:sqlite 取（TS 仅用类型，运行时不参与模块解析）。
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite"

const require = createRequire(import.meta.url)
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

/** 数据库文件默认路径：项目根/server/data/chat.db（与 electron 数据隔离） */
function resolveDefaultDbPath(): string {
  // server/src/db.ts → 上一级 server → 上一级 项目根
  const here = dirname(fileURLToPath(import.meta.url))
  const serverRoot = join(here, "..")
  const projectRoot = join(serverRoot, "..")
  const dataDir = join(projectRoot, "server", "data")
  mkdirSync(dataDir, { recursive: true })
  return join(dataDir, "chat.db")
}

/** Db 接口：封装 node:sqlite 的同步 prepared statement 调用 */
export interface Db {
  prepare(sql: string): StatementSync
  exec(sql: string): void
  close(): void
}

/** 打开（必要时新建）数据库连接 */
export function openDb(dbPath: string = resolveDefaultDbPath()): Db {
  const handle = new DatabaseSync(dbPath)
  // 启用外键约束 + WAL：并发读写更稳；chat_logs 高频写入尤其受益
  handle.exec("PRAGMA journal_mode = WAL;")
  handle.exec("PRAGMA foreign_keys = ON;")
  return handle as unknown as Db
}

/**
 * 业务常量：宠物昵称冷却时间 = 3 天 = 72 小时 = 259200 秒。
 * 改昵称后必须等这么久才能再改；首次设置不受限。
 * 集中放在这里便于 routes/me.ts 复用 + 测试断言。
 */
export const PET_NICKNAME_COOLDOWN_SEC = 72 * 60 * 60

/**
 * 安全加列：仅当列不存在时才 ALTER TABLE ADD COLUMN。
 * node:sqlite 没有 PRAGMA table_info 同步便利查询的封装，
 * 但 db.exec 的 ALTER 在重复执行时会抛 "duplicate column name" 错误，
 * 用 try/catch 吞掉该错误即可保证幂等。
 *
 * 选用 ALTER TABLE 兼容旧库的理由：M3 之前已经有真实用户数据（虽然现在只是 dev
 * 阶段），删库重建会丢掉历史写档记录；该函数保证幂等，多次启动都安全。
 */
function ensureColumn(db: Db, table: string, columnDecl: string, columnName: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDecl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 重复添加同一列时 SQLite 报 "duplicate column name: <col>"，属预期路径
    if (!/duplicate column name/i.test(msg)) {
      throw err
    }
    // 其他错误才向上抛；列已存在则静默
    void columnName
  }
}

/** 初始化表结构：契约 §4 DB 表定义（含 M2 工单要求的 email_codes） */
export function ensureSchema(db: Db): void {
  // users：契约约定的字段；id 自增；email 唯一
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      mbti TEXT,
      subtype TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  // M3 宠物昵称：pet_nickname（TEXT，空/未设置 = 用动物本名）、
  // pet_nickname_changed_at（INTEGER 时间戳秒，0 = 未改过）。ALTER TABLE 幂等加列。
  ensureColumn(db, "users", "pet_nickname TEXT", "pet_nickname")
  ensureColumn(db, "users", "pet_nickname_changed_at INTEGER NOT NULL DEFAULT 0", "pet_nickname_changed_at")

  // email_codes：契约 §4 一次性消费验证码；M2 工单加入
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (email, code)
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);`)

  // chat_usage：按 (user_id, date) 唯一；date 形如 'YYYY-MM-DD'
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_usage (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  // chat_logs：rag_entry_id 供 R3 溯源抽查；refused 字段标识是否走拒绝模板（M3 工单加入）
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      rag_entry_id TEXT,
      refused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  // M3 边界防御：guard_hit 标识是否被输出守卫拦截后改用拒绝模板（refused 仍为 0，
  // 因为意图过滤没命中；guard_hit=1 意味着 LLM 走完了但被守卫丢回）。
  ensureColumn(db, "chat_logs", "guard_hit INTEGER NOT NULL DEFAULT 0", "guard_hit")

  // M4 多轮对话：session_id 标识客户端发起的会话串；NULL = 单轮（无历史）。
  // 历史行（NULL）和旧库兼容；幂等 ALTER 保证重复启动不报错。
  // 索引在下方 idx_chat_logs_user_time 里扩展联合 (user_id, session_id, created_at)。
  ensureColumn(db, "chat_logs", "session_id TEXT", "session_id")

  // 索引：chat_logs(user_id, created_at) 加速按用户时间序查询
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_logs_user_time ON chat_logs(user_id, created_at);`)
  // M4 多轮对话：按 (user_id, session_id, created_at) 拉历史；session_id NULL 不走索引
  // （SQLite 对 NULL 比较的特殊语义），不影响单轮查询。
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chat_logs_user_session_time
       ON chat_logs(user_id, session_id, created_at);`,
  )

  // ====================== M4 社区广场 + 审核管道 表结构 ======================
  // 背景：PRD §3.7 社区广场 + 红线 R7/R8（UGC 必审 / 合规页面）
  // 设计要点：
  //   1. status 字段枚举 'pending' / 'approved' / 'rejected'——审核管道唯一决定 status
  //      的推进，**任何 status != 'approved' 的行都不会出现在广场 / 留言列表里**。
  //   2. posters / comments 都是"先 pending → 审核 → approved 才上墙"的二段提交；
  //      图片只存路径（image_path），实际文件在 server/data/posters/<user_id>/<id>.png。
  //   3. likes 是 (user_id, poster_id) 唯一索引，幂等点赞通过 UNIQUE 冲突检测。
  //   4. share_counts 累计每个用户的总分享数（V2 装扮解锁依赖它）。
  //   5. moderation_logs 记录每一次审核动作（R7 判定要看日志）；
  //      字段冗余存 poster_id/comment_id 与 decision/reason，便于审计。

  db.exec(`
    CREATE TABLE IF NOT EXISTS posters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      image_path TEXT NOT NULL,
      persona_type TEXT NOT NULL,
      question_excerpt TEXT NOT NULL,
      answer_excerpt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      likes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posters_status_created ON posters(status, created_at DESC);`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_posters_user ON posters(user_id);`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poster_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (poster_id) REFERENCES posters(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_poster_status ON comments(poster_id, status, created_at);`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER NOT NULL,
      poster_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, poster_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (poster_id) REFERENCES posters(id) ON DELETE CASCADE
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS share_counts (
      user_id INTEGER PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)

  // R7 审核日志：content_type 区分 poster / comment；content_id 是对应主表 id；
  // decision = 'pass' | 'reject'；reason 来自 ModerationProvider.moderateText 返回。
  // provider 字段冗余记录本次走的是 'local' 还是云厂商实现，便于审计与未来切换。
  db.exec(`
    CREATE TABLE IF NOT EXISTS moderation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL,
      content_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_moderation_logs_content ON moderation_logs(content_type, content_id);`)
}

/** 关闭数据库（用于测试结束清理） */
export function closeDb(db: Db): void {
  db.close()
}

/** 单例：被路由层与配额模块共享，避免重复 open */
let singleton: Db | null = null

/** 注入式设置：测试用，生产代码不调用；运行时再换回默认 openDb */
export function setDb(db: Db): void {
  singleton = db
}

/** 获取（或惰性创建）全局 Db 单例 */
export function getDb(): Db {
  if (!singleton) {
    singleton = openDb()
    ensureSchema(singleton)
  }
  return singleton
}

/** 重置单例（仅测试用） */
export function _resetDbForTests(): void {
  if (singleton) {
    singleton.close()
    singleton = null
  }
}