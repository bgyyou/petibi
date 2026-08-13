// 【文件说明】社区 Tab（M4 工单 A2：对接 docs/tech/M4-社区后端-交付报告.md）：
//   - 广场：GET /api/posters 瀑布流/网格（默认 2 列），点开进入详情；
//   - 海报详情：留言列表 + 发留言（≤200 字，提示"审核后展示"）；
//   - 点赞：POST /api/posters/:id/like（鉴权；未登录引导登录）；
//   - 未登录态：可浏览（GET 公开），点赞 / 留言时弹"请先登录"提示。
//
// 设计要点：
//  - 复用 src/api/client.ts 的 listPosters / likePoster / listComments / submitComment；
//  - 海报缩略图：server 把图片存到 server/data/posters/<uid>/<ts>.<ext>，
//    由 /data/posters 静态托管；前端用 BASE_URL + image_path 拼接（mock 模式回退为占位）；
//  - 未登录态通过 panelApi.getInit().token 判定；不存在则引导登录；
//  - 详情页用 stack 形式：顶部海报预览 + 留言列表 + 留言输入区。
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiCallError, listPosters, likePoster, listComments, submitComment } from '../../api/client'
import { baseUrl, isMockMode } from '../../api/client'
import type { CommentItem, PosterItem } from '../../api/types'
import { getPersona, FAMILY_COLORS } from '../../setup/persona-meta'

/** 视图：列表或详情 */
type View =
  | { mode: 'list' }
  | { mode: 'detail'; poster: PosterItem }

export function CommunityTab({ token, onRequireLogin }: CommunityTabProps): ReactNode {
  const [view, setView] = useState<View>({ mode: 'list' })
  if (view.mode === 'detail') {
    return (
      <CommunityDetail
        poster={view.poster}
        token={token}
        onBack={() => setView({ mode: 'list' })}
        onRequireLogin={onRequireLogin}
      />
    )
  }
  return <CommunityList token={token} onOpen={(p) => setView({ mode: 'detail', poster: p })} onRequireLogin={onRequireLogin} />
}

/** CommunityTab props：是否登录态由父组件传入，避免本组件读 IPC */
export interface CommunityTabProps {
  /** 当前登录 token；null 即访客态 */
  token: string | null
  /** 未登录时点赞/留言触发：让父组件引导登录（打开 setup 窗） */
  onRequireLogin: () => void
}

// ============================================================================
// 列表页
// ============================================================================

interface ListProps {
  token: string | null
  onOpen: (p: PosterItem) => void
  onRequireLogin: () => void
}

function CommunityList({ token, onOpen, onRequireLogin }: ListProps): ReactNode {
  const [items, setItems] = useState<PosterItem[] | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // 首次 mount 拉列表
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listPosters({ limit: 50, offset: 0 })
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiCallError ? err.message : '加载失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleLike = useCallback(
    async (p: PosterItem): Promise<void> => {
      if (!token) {
        onRequireLogin()
        return
      }
      // 乐观更新：先 +1，失败再回滚
      setItems((prev) =>
        prev
          ? prev.map((x) => (x.id === p.id ? { ...x, likes: x.likes + 1 } : x))
          : prev,
      )
      try {
        const res = await likePoster(token, p.id)
        setItems((prev) =>
          prev
            ? prev.map((x) => (x.id === p.id ? { ...x, likes: res.likes } : x))
            : prev,
        )
      } catch (err) {
        // 失败回滚
        setItems((prev) =>
          prev
            ? prev.map((x) => (x.id === p.id ? { ...x, likes: Math.max(0, x.likes - 1) } : x))
            : prev,
        )
        if (err instanceof ApiCallError && err.code === 'UNAUTHENTICATED') {
          onRequireLogin()
          return
        }
        setError(err instanceof ApiCallError ? err.message : '点赞失败')
      }
    },
    [token, onRequireLogin],
  )

  return (
    <div className="community-shell">
      <div className="community-header">
        <div className="community-header-title">社区广场</div>
        <div className="community-header-sub">
          {token ? '点开海报可留言' : '未登录状态，点赞/留言将引导登录'}
          {isMockMode && <span className="community-mock-hint">mock 模式</span>}
        </div>
      </div>
      {loading && <div className="community-loading">加载海报中…</div>}
      {error && !loading && <div className="community-error">{error}</div>}
      {items && items.length === 0 && (
        <div className="community-empty">广场还很安静，去生成第一张海报吧。</div>
      )}
      {items && items.length > 0 && (
        <div className="community-grid">
          {items.map((p) => (
            <PosterCard key={p.id} poster={p} onOpen={() => onOpen(p)} onLike={() => void handleLike(p)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 海报卡片：缩略图 + 人格 + 摘要 + 点赞数 */
function PosterCard({
  poster,
  onOpen,
  onLike,
}: {
  poster: PosterItem
  onOpen: () => void
  onLike: () => void
}): ReactNode {
  const meta = getPersona(poster.persona_type)
  const family = meta?.family ?? 'analyst'
  const colors = FAMILY_COLORS[family]
  return (
    <article className="poster-card" style={{ borderColor: colors.border }}>
      <button
        type="button"
        className="poster-card-img-btn"
        onClick={onOpen}
        aria-label={`查看海报详情（${meta?.animal ?? poster.persona_type}）`}
      >
        <PosterImage poster={poster} alt={`${meta?.animal ?? poster.persona_type} 海报`} />
      </button>
      <div className="poster-card-meta">
        <span className="poster-card-type" style={{ color: colors.fg, background: colors.bg }}>
          {poster.persona_type} · {meta?.animal ?? ''}
        </span>
        <button
          type="button"
          className="poster-card-like"
          onClick={onLike}
          aria-label={`点赞，当前 ${poster.likes} 次`}
        >
          ♥ {poster.likes}
        </button>
      </div>
      <div className="poster-card-question">{poster.question_excerpt}</div>
      <div className="poster-card-answer">{poster.answer_excerpt}</div>
    </article>
  )
}

/** 海报图片：mock 用占位（族色 + 人格首字）；真接口用 BASE_URL + image_path 拼接 */
function PosterImage({ poster, alt }: { poster: PosterItem; alt: string }): ReactNode {
  const meta = getPersona(poster.persona_type)
  const family = meta?.family ?? 'analyst'
  const colors = FAMILY_COLORS[family]
  // mock:// 前缀 → 用占位；否则用真实图片
  if (poster.image_path.startsWith('mock://')) {
    return (
      <div
        className="poster-card-placeholder"
        style={{ background: colors.bg, color: colors.fg }}
        aria-label={alt}
      >
        <div className="poster-card-placeholder-type">{poster.persona_type}</div>
        <div className="poster-card-placeholder-animal">{meta?.animal ?? ''}</div>
      </div>
    )
  }
  const url = `${baseUrl}${poster.image_path.startsWith('/') ? '' : '/'}${poster.image_path}`
  return <img src={url} alt={alt} className="poster-card-img" loading="lazy" />
}

// ============================================================================
// 详情页：留言列表 + 发留言
// ============================================================================

interface DetailProps {
  poster: PosterItem
  token: string | null
  onBack: () => void
  onRequireLogin: () => void
}

function CommunityDetail({ poster, token, onBack, onRequireLogin }: DetailProps): ReactNode {
  const [comments, setComments] = useState<CommentItem[] | null>(null)
  const [loadingComments, setLoadingComments] = useState<boolean>(true)
  const [commentError, setCommentError] = useState<string | null>(null)
  // 留言输入
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitHint, setSubmitHint] = useState<string | null>(null)
  const meta = getPersona(poster.persona_type)
  const family = meta?.family ?? 'analyst'
  const colors = FAMILY_COLORS[family]
  const trimmed = draft.trim()
  const len = trimmed.length
  const overLimit = len > 200
  const canSubmit = token !== null && !submitting && len > 0 && !overLimit

  // 拉留言
  useEffect(() => {
    let cancelled = false
    setLoadingComments(true)
    listComments(poster.id)
      .then((res) => {
        if (cancelled) return
        setComments(res.items)
        setLoadingComments(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setCommentError(err instanceof ApiCallError ? err.message : '加载留言失败')
        setLoadingComments(false)
      })
    return () => {
      cancelled = true
    }
  }, [poster.id])

  const submit = useCallback(async (): Promise<void> => {
    if (!canSubmit) {
      if (!token) onRequireLogin()
      return
    }
    setSubmitting(true)
    setSubmitHint(null)
    try {
      const res = await submitComment(token as string, poster.id, { content: trimmed })
      if (res.status === 'approved') {
        setSubmitHint('✅ 留言已提交，审核后展示')
        setDraft('')
        // 乐观更新：把刚提交的内容加进列表（server 已通过审核的会同步进列表）
        if (res.status === 'approved') {
          const newComment: CommentItem = {
            id: res.comment_id,
            user_id: 0,
            content: trimmed,
            created_at: new Date().toISOString(),
          }
          setComments((prev) => (prev ? [...prev, newComment] : [newComment]))
        }
      } else if (res.status === 'pending') {
        setSubmitHint('已提交，审核中')
        setDraft('')
      } else {
        setSubmitHint(`⚠️ 留言未通过：${res.reason ?? '请检查内容后重试'}`)
      }
    } catch (err) {
      if (err instanceof ApiCallError) {
        if (err.code === 'UNAUTHENTICATED') {
          onRequireLogin()
        } else if (err.code === 'COMMENT_TOO_LONG') {
          setSubmitHint('留言超过 200 字限制')
        } else {
          setSubmitHint(`⚠️ ${err.message}`)
        }
      } else {
        setSubmitHint('留言失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, token, poster.id, trimmed, onRequireLogin])

  return (
    <div className="community-detail-shell">
      <header className="community-detail-header" style={{ borderColor: colors.border, background: colors.bg }}>
        <button type="button" className="community-back-btn" onClick={onBack} aria-label="返回广场">
          ← 返回
        </button>
        <div className="community-detail-type" style={{ color: colors.fg }}>
          {poster.persona_type} · {meta?.animal ?? ''}
        </div>
      </header>
      <div className="community-detail-body">
        <div className="community-detail-card" style={{ borderColor: colors.border }}>
          <PosterImage poster={poster} alt={`${meta?.animal ?? poster.persona_type} 海报`} />
          <div className="community-detail-q">问：{poster.question_excerpt}</div>
          <div className="community-detail-a">答：{poster.answer_excerpt}</div>
          <div className="community-detail-stat">♥ {poster.likes}</div>
        </div>

        <section className="community-comments-section">
          <h3 className="community-comments-title">留言（{comments?.length ?? 0}）</h3>
          {loadingComments && <div className="community-loading">加载留言…</div>}
          {commentError && !loadingComments && (
            <div className="community-error">{commentError}</div>
          )}
          {comments && comments.length === 0 && !loadingComments && (
            <div className="community-empty">还没有留言，做第一个吧。</div>
          )}
          {comments && comments.length > 0 && (
            <ul className="community-comment-list">
              {comments.map((c) => (
                <li key={c.id} className="community-comment">
                  <div className="community-comment-content">{c.content}</div>
                  <div className="community-comment-time">{formatTime(c.created_at)}</div>
                </li>
              ))}
            </ul>
          )}

          <div className="community-comment-form">
            <textarea
              className="community-comment-input"
              placeholder={token ? '留下你的想法（≤200 字，审核后展示）' : '请先登录后再留言'}
              value={draft}
              maxLength={300}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => {
                if (!token) onRequireLogin()
              }}
              disabled={!token || submitting}
            />
            <div className="community-comment-bar">
              <span className={`community-comment-count ${overLimit ? 'is-over' : ''}`}>{len}/200</span>
              <button
                type="button"
                className="community-comment-submit"
                onClick={() => void submit()}
                disabled={!canSubmit}
              >
                {submitting ? '提交中…' : '发送'}
              </button>
            </div>
            {submitHint && <div className="community-comment-hint">{submitHint}</div>}
          </div>
        </section>
      </div>
    </div>
  )
}

/** 把 ISO 时间格式化成"5 分钟前 / 3 小时前 / 08-12 12:30"等简短展示 */
function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = Date.now()
  const diff = Math.floor((now - d.getTime()) / 1000)
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  // 跨天：返回 MM-DD HH:MM
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${dd} ${hh}:${mm}`
}