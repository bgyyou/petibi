// 【文件说明】多轮对话会话串 id 的本地持久化（M4 工单 A 衔接工单 B §B1）：
//   - 按用户维度（user.id）把当前会话 session_id 存 localStorage，
//     关闭软件再开仍能续上同一会话（server 端会按 session_id 拉历史轮次）；
//   - 提供「loadSessionId(userId) / saveSessionId(userId, id) / clearSession(userId) / generateSessionId()」
//     四个纯函数，便于 vitest 覆盖；
//   - localStorage 缺失 / 异常时安全降级为返回 null，调用方决定是否生成新 id。
//
// 设计要点：
//  - key 形如 `petibi:session:<userId>`；按用户隔离，多账号不串；
//  - session_id 形如 `<userId>-<uuid>`，便于 server 端按用户前缀快速过滤；
//  - 生成失败时退回到 `<userId>-<timestamp>-<random>`，保证非空；
//  - 不与 React 耦合，纯函数 + localStorage 单例，便于单测。

const KEY_PREFIX = 'petibi:session:'

/** 生成新的 session_id（不读 localStorage） */
export function generateSessionId(userId: string): string {
  const random = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
  return `${userId}-${random()}`
}

/** 读取某用户当前 session_id；localStorage 不可用或未存时返回 null */
export function loadSessionId(userId: string): string | null {
  if (!userId) return null
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(KEY_PREFIX + userId)
    if (!raw) return null
    // 简单合法性校验：必须是 string 且非空
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    return trimmed
  } catch {
    return null
  }
}

/** 写入 session_id；localStorage 不可用时静默失败（下次重试） */
export function saveSessionId(userId: string, sessionId: string): void {
  if (!userId || !sessionId) return
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY_PREFIX + userId, sessionId)
  } catch {
    /* 静默：localStorage 配额 / Safari 隐私模式都可能抛 */
  }
}

/** 清空某用户的 session_id；用于"新会话"按钮 */
export function clearSession(userId: string): void {
  if (!userId) return
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(KEY_PREFIX + userId)
  } catch {
    /* 静默 */
  }
}

/**
 * 取一个可用的 session_id：优先复用 localStorage 里的旧值，没有就生成新的并立即落盘。
 * - userId 为空时降级为一次性内存 id（不要调用 saveSessionId，因为 key 不存在）；
 * - 这个函数是 ChatTab 在 user 就绪后调一次拿初始 id 的入口。
 */
export function ensureSessionId(userId: string): string {
  if (!userId) {
    // 极端情况：user 还没就绪就发了消息；用临时 id，不持久化。
    return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
  const existing = loadSessionId(userId)
  if (existing) return existing
  const fresh = generateSessionId(userId)
  saveSessionId(userId, fresh)
  return fresh
}

/** 单测 / 调试用：清空所有 petibi:session:* 键 */
export function __resetAllSessions(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* 静默 */
  }
}