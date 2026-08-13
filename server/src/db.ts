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

  // 索引：chat_logs(user_id, created_at) 加速按用户时间序查询
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_logs_user_time ON chat_logs(user_id, created_at);`)
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