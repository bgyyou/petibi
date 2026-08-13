// 【文件说明】百科 Tab（M4 工单 A1）：
//   - 列表页：16 人格卡片（形象图 + 类型 + 动物 + 一句话特质），按族分组；
//   - 详情页：trait/cognitive/strength/weakness/career/relationship 分区 + faq 列表可展开；
//   - 族色（family color）作为该人格页面的主题色（顶部条 + 卡片边框），与 src/setup/styles.css 复用；
//   - 数据从 data/encyclopedia/{index,<type>.json} 经主进程 IPC 加载（src/api/encyclopedia.ts）。
//
// 设计要点：
//  - 主进程 IPC 由 preload 暴露 panelApi.readEncyclopedia / readEncyclopediaIndex；
//  - 列表页用 index.json 一次拉全，详情页按 type 懒加载条目；
//  - 一句话特质取自条目 category='trait' 的第一条（PRD §3.6：trait-01）；
//  - 形象图用 resources/sprites/<type>/idle_0.png（32×32 放大 4 倍 = 128×128）；
//    列表卡片用 64×64 略小；详情页用 96×96。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  CATEGORY_LABEL,
  groupEntriesByCategory,
  loadEncyclopediaIndex,
  useEncyclopedia,
  type EncyclopediaDoc,
  type EncyclopediaEntry,
  type EncyclopediaIndex,
  type EncyclopediaIndexItem,
  type MbtiType,
} from '../../api/encyclopedia'
import { FAMILY_COLORS, PERSONAS, getPersona } from '../../setup/persona-meta'

/** 列表 / 详情切换的内部状态：null=列表页；否则=详情页的人格 */
type View = { mode: 'list' } | { mode: 'detail'; type: MbtiType }

export function EncyclopediaTab(): ReactNode {
  const [view, setView] = useState<View>({ mode: 'list' })
  const [index, setIndex] = useState<EncyclopediaIndex | null>(null)
  const [loadingIndex, setLoadingIndex] = useState<boolean>(true)
  const [indexError, setIndexError] = useState<string | null>(null)

  // 首次 mount 拉一次 index（人格清单），列表页用
  useEffect(() => {
    let cancelled = false
    setLoadingIndex(true)
    loadEncyclopediaIndex()
      .then((data) => {
        if (cancelled) return
        setIndex(data)
        setLoadingIndex(false)
        if (!data) setIndexError('未能加载人格列表')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setIndexError(err instanceof Error ? err.message : '加载失败')
        setLoadingIndex(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (view.mode === 'detail') {
    return <EncyclopediaDetail type={view.type} onBack={() => setView({ mode: 'list' })} />
  }

  return (
    <EncyclopediaList
      index={index}
      loading={loadingIndex}
      error={indexError}
      onSelect={(t) => setView({ mode: 'detail', type: t })}
    />
  )
}

// ============================================================================
// 列表页
// ============================================================================

interface ListProps {
  index: EncyclopediaIndex | null
  loading: boolean
  error: string | null
  onSelect: (type: MbtiType) => void
}

/** 按族分组：4 族 × 4 人格，与 PERSONAS 顺序一致 */
function useFamilies(): Record<'analyst' | 'diplomat' | 'sentinel' | 'explorer', MbtiType[]> {
  return useMemo(() => {
    const out: Record<'analyst' | 'diplomat' | 'sentinel' | 'explorer', MbtiType[]> = {
      analyst: [],
      diplomat: [],
      sentinel: [],
      explorer: [],
    }
    for (const p of PERSONAS) out[p.family].push(p.type)
    return out
  }, [])
}

/** 取某人格的 trait-01 文案当"一句话特质"展示（PRD §3.6） */
function findTrait01(items: EncyclopediaIndexItem[], type: MbtiType): string | null {
  return null // trait-01 来自百科条目正文，不在 index；详情页才有。列表用 persona.tagline 即可
}

function EncyclopediaList({ index, loading, error, onSelect }: ListProps): ReactNode {
  void index
  void findTrait01
  const families = useFamilies()
  if (loading) {
    return <div className="baike-loading">加载百科列表…</div>
  }
  if (error) {
    return <div className="baike-loading">{error}</div>
  }
  const familyOrder: Array<'analyst' | 'diplomat' | 'sentinel' | 'explorer'> = [
    'analyst',
    'diplomat',
    'sentinel',
    'explorer',
  ]
  const familyName: Record<string, string> = {
    analyst: '分析家',
    diplomat: '外交家',
    sentinel: '守护者',
    explorer: '探险家',
  }
  return (
    <div className="baike-shell">
      <div className="baike-intro">
        <div className="baike-intro-title">MBTI 百科全书</div>
        <div className="baike-intro-sub">
          16 人格 × 性格特征 / 认知功能 / 优劣势 / 职业 / 关系 / FAQ 场景。
        </div>
      </div>
      {familyOrder.map((fam) => (
        <section key={fam} className="baike-family-section">
          <div
            className="baike-family-header"
            style={{ color: FAMILY_COLORS[fam].fg }}
          >
            {familyName[fam]}
          </div>
          <div className="baike-grid">
            {families[fam].map((t) => {
              const meta = getPersona(t)
              if (!meta) return null
              const colors = FAMILY_COLORS[meta.family]
              return (
                <button
                  key={t}
                  type="button"
                  className="baike-card"
                  style={{ borderColor: colors.border, background: '#ffffff' }}
                  onClick={() => onSelect(t)}
                  aria-label={`查看 ${meta.animal} ${t} 详情`}
                >
                  <img
                    src={window.petApi.spriteUrl(t, 'idle_0')}
                    width={48}
                    height={48}
                    alt={meta.animal}
                    className="baike-card-portrait"
                    draggable={false}
                  />
                  <div className="baike-card-type" style={{ color: colors.fg }}>
                    {t}
                  </div>
                  <div className="baike-card-animal">{meta.animal}</div>
                  <div className="baike-card-tagline">{meta.tagline}</div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

// ============================================================================
// 详情页
// ============================================================================

interface DetailProps {
  type: MbtiType
  onBack: () => void
}

function EncyclopediaDetail({ type, onBack }: DetailProps): ReactNode {
  const { doc, loading, error } = useEncyclopedia(type)
  const meta = getPersona(type)
  if (!meta) {
    return (
      <div className="baike-loading">
        未找到人格 {type}
        <button type="button" onClick={onBack} className="baike-back-btn">
          返回
        </button>
      </div>
    )
  }
  const colors = FAMILY_COLORS[meta.family]
  return (
    <div
      className="baike-detail-shell"
      style={{
        // 族色作为该人格页面的主题色（PRD §3.6：族色作为该人格页面的主题色）
        // 通过 CSS 变量下传，让子卡片边框 / 高亮跟随
        ['--baike-accent' as string]: colors.fg,
        ['--baike-accent-bg' as string]: colors.bg,
        ['--baike-accent-border' as string]: colors.border,
      }}
    >
      <header
        className="baike-detail-header"
        style={{ background: colors.bg, borderColor: colors.border }}
      >
        <button
          type="button"
          className="baike-back-btn"
          onClick={onBack}
          aria-label="返回列表"
        >
          ← 返回
        </button>
        <div className="baike-detail-hero">
          <img
            src={window.petApi.spriteUrl(type, 'idle_0')}
            width={96}
            height={96}
            alt={meta.animal}
            className="baike-detail-portrait"
            draggable={false}
          />
          <div className="baike-detail-titles">
            <div className="baike-detail-type" style={{ color: colors.fg }}>
              {type}
            </div>
            <div className="baike-detail-animal">{meta.animal}</div>
            <div className="baike-detail-tagline">{meta.tagline}</div>
          </div>
        </div>
      </header>

      <div className="baike-detail-body">
        {loading && <div className="baike-loading">加载百科条目…</div>}
        {error && !loading && <div className="baike-loading">{error}</div>}
        {doc && <DetailEntries doc={doc} />}
      </div>
    </div>
  )
}

/** 分区渲染条目：trait/cognitive/strength/weakness/career/relationship 各为一组；faq 单独可展开 */
function DetailEntries({ doc }: { doc: EncyclopediaDoc }): ReactNode {
  const groups = useMemo(() => groupEntriesByCategory(doc), [doc])
  return (
    <>
      {groups.map(({ category, entries }) => {
        if (category === 'faq') {
          return <FaqGroup key={category} entries={entries} />
        }
        return (
          <section key={category} className="baike-section">
            <h3 className="baike-section-title">{CATEGORY_LABEL[category]}</h3>
            <ul className="baike-entry-list">
              {entries.map((e) => (
                <EntryItem key={e.id} entry={e} />
              ))}
            </ul>
          </section>
        )
      })}
    </>
  )
}

/** 普通条目（trait / cognitive / 等）：标题 + 内容 + 标签 */
function EntryItem({ entry }: { entry: EncyclopediaEntry }): ReactNode {
  return (
    <li className="baike-entry">
      <div className="baike-entry-title">{entry.title}</div>
      <div className="baike-entry-content">{entry.content}</div>
      {entry.tags.length > 0 && (
        <div className="baike-entry-tags">
          {entry.tags.map((t) => (
            <span key={t} className="baike-tag">
              #{t}
            </span>
          ))}
        </div>
      )}
    </li>
  )
}

/** FAQ 列表：每条可展开/收起 */
function FaqGroup({ entries }: { entries: EncyclopediaEntry[] }): ReactNode {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <section className="baike-section">
      <h3 className="baike-section-title">{CATEGORY_LABEL.faq}</h3>
      <ul className="baike-faq-list">
        {entries.map((e) => {
          const isOpen = open.has(e.id)
          return (
            <li key={e.id} className={`baike-faq ${isOpen ? 'is-open' : ''}`}>
              <button
                type="button"
                className="baike-faq-toggle"
                onClick={() => toggle(e.id)}
                aria-expanded={isOpen}
              >
                <span className="baike-faq-q">{e.title}</span>
                <span className="baike-faq-arrow" aria-hidden="true">
                  {isOpen ? '−' : '+'}
                </span>
              </button>
              {isOpen && (
                <div className="baike-faq-body">
                  <div className="baike-faq-content">{e.content}</div>
                  {e.scenario && (
                    <div className="baike-faq-scenario">场景：{e.scenario}</div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}