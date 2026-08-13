// 【文件说明】百科数据加载：data/encyclopedia/{index,<type>.json} 的渲染进程侧封装。
//
// 设计要点：
//  - 百科数据是 PRD §3.6 的核心数据资产，但放在仓库根 data/ 而非渲染进程 publicDir（resources/）；
//    因此渲染进程不能 fetch，必须经主进程 IPC 读取（preload 已暴露 readEncyclopedia / readEncyclopediaIndex）；
//  - 提供一个 useEncyclopedia(type) 的 React hook（cache 友好），便于 EncyclopediaTab 按人格切换时复用；
//  - 缓存策略：单次会话内同人格只读一次（Map<type, data>），切换人格不重复打 IPC。
//  - dev 模式（vite 测试环境）下 window.petApi 不存在 → 提供一个 __stub 走 fetch 兜底（vitest 单测用）。

import { useEffect, useState } from 'react'

/** 16 人格标识 */
export type MbtiType =
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'

/** 4 族：分析家/外交家/守护者/探险家 */
export type Family = 'analyst' | 'diplomat' | 'sentinel' | 'explorer'

/** 单条百科条目（与 data/encyclopedia/<type>.json 的 entries[] 对齐） */
export interface EncyclopediaEntry {
  id: string
  category: 'trait' | 'cognitive' | 'strength' | 'weakness' | 'career' | 'relationship' | 'faq'
  title: string
  content: string
  tags: string[]
  scenario: string | null
}

/** 百科全文（data/encyclopedia/<type>.json 的形态） */
export interface EncyclopediaDoc {
  personality: MbtiType
  animal: string
  family: Family
  entries: EncyclopediaEntry[]
}

/** 百科索引（data/encyclopedia/index.json）单人格记录 */
export interface EncyclopediaIndexItem {
  personality: MbtiType
  animal: string
  family: Family
  entry_count: number
  file: string
}

/** 百科索引全文 */
export interface EncyclopediaIndex {
  version: string
  scenarios_file: string
  personalities: EncyclopediaIndexItem[]
}

/** 同 session 内同人格的缓存（模块级 singleton） */
const docCache: Map<MbtiType, EncyclopediaDoc> = new Map()
let indexCache: EncyclopediaIndex | null = null

/**
 * 读取 16 人格索引。dev 环境下用 fetch 直接拉 data/encyclopedia/index.json，
 * Electron 环境下走 preload IPC（panelApi.readEncyclopediaIndex）。
 */
export async function loadEncyclopediaIndex(): Promise<EncyclopediaIndex | null> {
  if (indexCache) return indexCache
  const pApi = (window as unknown as { panelApi?: { readEncyclopediaIndex?: () => Promise<unknown | null> } })
    .panelApi
  if (pApi?.readEncyclopediaIndex) {
    const raw = (await pApi.readEncyclopediaIndex()) as EncyclopediaIndex | null
    if (raw) {
      indexCache = raw
      return raw
    }
    return null
  }
  // 兜底：vite 测试环境直接 fetch 仓库根 data/encyclopedia/index.json
  try {
    const res = await fetch('/data/encyclopedia/index.json')
    if (!res.ok) return null
    indexCache = (await res.json()) as EncyclopediaIndex
    return indexCache
  } catch {
    return null
  }
}

/**
 * 读取某一人格的百科全文。优先用缓存；Electron 走 IPC，其他走 fetch。
 */
export async function loadEncyclopedia(type: MbtiType): Promise<EncyclopediaDoc | null> {
  const cached = docCache.get(type)
  if (cached) return cached
  const pApi = (window as unknown as { panelApi?: { readEncyclopedia?: (t: string) => Promise<unknown | null> } })
    .panelApi
  if (pApi?.readEncyclopedia) {
    const raw = (await pApi.readEncyclopedia(type)) as EncyclopediaDoc | null
    if (raw) {
      docCache.set(type, raw)
      return raw
    }
    return null
  }
  try {
    const res = await fetch(`/data/encyclopedia/${type.toLowerCase()}.json`)
    if (!res.ok) return null
    const data = (await res.json()) as EncyclopediaDoc
    docCache.set(type, data)
    return data
  } catch {
    return null
  }
}

/** 分类 → 中文标签（详情页分区标题用） */
export const CATEGORY_LABEL: Record<EncyclopediaEntry['category'], string> = {
  trait: '性格特征',
  cognitive: '认知功能',
  strength: '优势',
  weakness: '劣势',
  career: '职业倾向',
  relationship: '人际关系',
  faq: '常见场景 FAQ',
}

/** 按 category 分组后的有序条目集合：详情页分区渲染用 */
export function groupEntriesByCategory(
  doc: EncyclopediaDoc,
): Array<{ category: EncyclopediaEntry['category']; entries: EncyclopediaEntry[] }> {
  const order: EncyclopediaEntry['category'][] = [
    'trait',
    'cognitive',
    'strength',
    'weakness',
    'career',
    'relationship',
    'faq',
  ]
  const groups: Record<EncyclopediaEntry['category'], EncyclopediaEntry[]> = {
    trait: [],
    cognitive: [],
    strength: [],
    weakness: [],
    career: [],
    relationship: [],
    faq: [],
  }
  for (const e of doc.entries) groups[e.category].push(e)
  return order
    .filter((c) => groups[c].length > 0)
    .map((c) => ({ category: c, entries: groups[c] }))
}

/**
 * React hook：加载某一人格百科，懒加载 + 缓存。
 * - 返回 { doc, loading, error }；
 * - 卸载或 type 变化时取消过期请求（通过 cancelled 标记）；
 * - 渲染端按 persona 元数据查 family 决定主题色（族色从 setup/persona-meta 复用）。
 */
export function useEncyclopedia(type: MbtiType): {
  doc: EncyclopediaDoc | null
  loading: boolean
  error: string | null
} {
  const [doc, setDoc] = useState<EncyclopediaDoc | null>(() => docCache.get(type) ?? null)
  const [loading, setLoading] = useState<boolean>(!docCache.has(type))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDoc(docCache.get(type) ?? null)
    if (docCache.has(type)) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    loadEncyclopedia(type)
      .then((d) => {
        if (cancelled) return
        if (d) setDoc(d)
        else setError('该人格百科暂未上架')
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '加载失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [type])

  return { doc, loading, error }
}

/** 单元测试 / 调试用：清空文档缓存 */
export function __resetEncyclopediaCache(): void {
  docCache.clear()
  indexCache = null
}