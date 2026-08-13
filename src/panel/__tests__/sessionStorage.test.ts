// 【文件说明】sessionStorage 工具模块单测：覆盖 generateSessionId / loadSessionId /
//   saveSessionId / clearSession / ensureSessionId / __resetAllSessions 全部分支。
//
// 跑在 vitest node 环境下：localStorage 不存在 → 必须在 import 模块前注入一个简易 Map 替身，
// 否则 loadSessionId 会按"localStorage 不可用"分支直接返 null（也合法但分支覆盖不全）。
//
// 校验（工单 A 自验第 1 项 + 工单 B 衔接要求）：
//  1) generateSessionId 至少含 userId 前缀，长度合理，两次调用结果不同；
//  2) saveSessionId 后 loadSessionId 能取回；
//  3) 不同 userId 互不串扰（key 命名空间隔离）；
//  4) clearSession 后再 loadSessionId 返 null；
//  5) ensureSessionId：localStorage 空 → 生成新 + 落盘；已有 → 复用旧值不刷新；
//  6) localStorage 不可用时 ensureSessionId 仍能生成新 id（降级分支）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** 简易 localStorage 替身：用 Map 模拟 setItem/getItem/removeItem/key/length
 *  之所以手写而不是引入 jsdom/happy-dom：vitest config 是 node 环境，避免引入重依赖。
 */
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key)! : null
    },
    key(i: number): string | null {
      return Array.from(map.keys())[i] ?? null
    },
    removeItem(key: string): void {
      map.delete(key)
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value))
    },
  }
}

describe('sessionStorage', () => {
  beforeEach(() => {
    // 给全局 localStorage 注入内存替身，让被测模块走真实分支
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = makeMemoryStorage()
  })

  afterEach(() => {
    // 清空避免跨用例串扰
    ;(globalThis as unknown as { localStorage?: Storage }).localStorage = undefined
  })

  it('generateSessionId 含 userId 前缀且两次结果不同', async () => {
    const { generateSessionId } = await import('../sessionStorage')
    const a = generateSessionId('user-1')
    const b = generateSessionId('user-1')
    expect(a.startsWith('user-1-')).toBe(true)
    expect(b.startsWith('user-1-')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('saveSessionId → loadSessionId 闭环', async () => {
    const { saveSessionId, loadSessionId } = await import('../sessionStorage')
    saveSessionId('u1', 'u1-abc-123')
    expect(loadSessionId('u1')).toBe('u1-abc-123')
  })

  it('不同 userId 互不串扰（命名空间隔离）', async () => {
    const { saveSessionId, loadSessionId, clearSession } = await import('../sessionStorage')
    saveSessionId('u-a', 'sid-a')
    saveSessionId('u-b', 'sid-b')
    expect(loadSessionId('u-a')).toBe('sid-a')
    expect(loadSessionId('u-b')).toBe('sid-b')
    // 清掉 a 不影响 b
    clearSession('u-a')
    expect(loadSessionId('u-a')).toBeNull()
    expect(loadSessionId('u-b')).toBe('sid-b')
  })

  it('clearSession 清空后再 load 返 null', async () => {
    const { saveSessionId, loadSessionId, clearSession } = await import('../sessionStorage')
    saveSessionId('u-clear', 'tmp')
    expect(loadSessionId('u-clear')).toBe('tmp')
    clearSession('u-clear')
    expect(loadSessionId('u-clear')).toBeNull()
  })

  it('ensureSessionId：空 localStorage → 生成新并落盘', async () => {
    const { ensureSessionId, loadSessionId, __resetAllSessions } = await import('../sessionStorage')
    __resetAllSessions()
    const id = ensureSessionId('u-fresh')
    expect(id.startsWith('u-fresh-')).toBe(true)
    // 落盘后第二次调用应当复用同一个 id（不再生成新）
    expect(ensureSessionId('u-fresh')).toBe(id)
    // 通过 loadSessionId 验证确实写到 localStorage
    expect(loadSessionId('u-fresh')).toBe(id)
  })

  it('ensureSessionId：已有 id → 复用，不刷新', async () => {
    const { ensureSessionId, saveSessionId } = await import('../sessionStorage')
    saveSessionId('u-existing', 'existing-id')
    expect(ensureSessionId('u-existing')).toBe('existing-id')
  })

  it('localStorage 不可用时 ensureSessionId 仍能生成 id', async () => {
    // 模拟没有 localStorage 的环境
    ;(globalThis as unknown as { localStorage?: Storage }).localStorage = undefined
    const { ensureSessionId } = await import('../sessionStorage')
    const id = ensureSessionId('u-fallback')
    expect(id.startsWith('u-fallback-')).toBe(true)
  })

  it('空 userId 不抛异常，generateSessionId/loadSessionId 安全降级', async () => {
    const { generateSessionId, loadSessionId, saveSessionId, clearSession } = await import(
      '../sessionStorage'
    )
    expect(() => generateSessionId('')).not.toThrow()
    expect(loadSessionId('')).toBeNull()
    // saveSessionId/clearSession 对空 userId 静默失败
    expect(() => saveSessionId('', 'x')).not.toThrow()
    expect(() => clearSession('')).not.toThrow()
  })
})