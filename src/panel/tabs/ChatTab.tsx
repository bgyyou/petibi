// 【文件说明】对话 Tab（M3 桌宠交互层核心 + M4 海报分享入口 + 多轮对话会话串）：
//   与 server POST /api/chat（SSE 流式）对接，每条完成态 assistant 消息旁加「生成海报」按钮。
//
// 行为契约（PRD §2 / §3.4 / §3.5）：
//   1. 加载期：调 getInit() 取 token；调 getQuota(token) 取今日剩余次数；调 getMe(token) 取 user（人格/昵称/动物）
//   2. 发送消息：立刻（≤0.3s）切桌宠思考动画（petState('thinking')），首字延迟到再切回 idle
//   3. 流式接收：每条 delta 累加到对应 assistant 消息，UI 自动滚动到底部
//   4. 完成（done）：保留 streaming=false；触发切回 idle；刷新配额
//   5. 错误（error）：显示在系统消息气泡；停止流；切回 idle
//   6. 配额耗尽：发送按钮禁用，提示「今日次数已用完」
//   7. 海报分享（M4）：assistant 消息「生成海报」按钮 → 弹窗预览 → 保存本地 / 分享到广场
//   8. 多轮对话会话串（M4 工单 A 衔接 B §B1）：首次发消息时生成 session_id 并持久化到 localStorage
//      （key 含 user id）；后续每条消息通过 streamChat 的 options.sessionId 传入；
//      「新会话」按钮：清空对话区 + 生成新 session_id；server 端会按 session_id 拉取该会话最近 6 轮
//      历史拼进 prompt 实现"上下文延续"。
//
// mock 模式：默认开启（VITE_USE_MOCK_API !== 'false'），dev 无 server 也能完整体验流式与越界拒绝。
//   mockStreamChat 接受 sessionId 但不真正拼历史（dev 体验优先）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, ChatSseEvent, QuotaInfo, User } from '../../api/types'
import {
  ApiCallError,
  bumpShareCount,
  getMe,
  getQuota,
  isMockMode,
  streamChat,
  submitPoster,
} from '../../api/client'
import { applyChatEvent, formatBubbleText, isTerminalEvent } from '../chat-reducer'
import {
  clearSession,
  ensureSessionId,
  loadSessionId,
  saveSessionId,
} from '../sessionStorage'
import {
  blobToBase64,
  downloadBlob,
  generatePoster,
  todayDateString,
  truncateExcerpt,
  type PosterInput,
} from '../../share/poster'

// 本地常量
const THINKING_MIN_MS = 250 // 思考动画最短显示，避免一闪而过丢失拟人感
const PLACEHOLDER_SAMPLE = '试试问：「明天要当众演讲好紧张」或「写代码不在我职责范围」'

/**
 * 海报弹窗状态机：4 阶段
 *  - generating：canvas 绘制中（≤3s），显示骨架屏
 *  - preview：生成完成，预览 + 操作（保存 / 分享）
 *  - sharing：调 server 上传中
 *  - shared：分享成功（显示 poster_id）
 *  - failed：失败（生成失败 / 分享失败），保留 blob 仍可保存本地
 */
type PosterModalState =
  | { mode: 'generating'; question: string; answer: string }
  | { mode: 'preview'; question: string; answer: string; blob: Blob; previewUrl: string }
  | { mode: 'sharing'; question: string; answer: string; blob: Blob; previewUrl: string }
  | {
      mode: 'shared'
      question: string
      answer: string
      blob: Blob
      previewUrl: string
      posterId: string
    }
  | {
      mode: 'failed'
      question: string
      answer: string
      blob: Blob
      previewUrl: string
      reason: string
    }

/**
 * 给消息数组生成稳定的本地 id（用 crypto.randomUUID 优先，回退到时间戳+随机数）。
 * 避免在同一台机器上多会话串 id（虽然 panel 单实例不会，但保持稳健）。
 */
function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 简易 markdown-like 转义：把换行替换成 <br/> 由 React 渲染（white-space: pre-wrap 已处理）。
 * 当前刻意不做富文本：mock 文案已含"（mock）"字样，避免越界处理复杂化。
 * 实际格式化逻辑已抽到 src/panel/chat-reducer.ts 的 formatBubbleText。
 */

export function ChatTab(): ReactNode {
  // 状态：消息列表 + 输入框 + 配额 + 流式中标志
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  const [streaming, setStreaming] = useState(false)
  // 错误消息（局部显示）
  const [error, setError] = useState<string | null>(null)
  // 当前用户信息（M4 海报需要：mbti / nickname / animal / pet_name）
  const [user, setUser] = useState<User | null>(null)
  // 多轮对话会话串（M4 工单 A 衔接 B §B1）：首次发消息时按 userId 复用 / 生成，
  // 通过 options.sessionId 传给 streamChat；切换用户时由 useEffect 重新 ensure。
  const [sessionId, setSessionId] = useState<string | null>(null)
  // 海报弹窗状态：null=关闭；state=generating/preview/shared/failed 表示当前阶段
  const [posterModal, setPosterModal] = useState<PosterModalState | null>(null)
  // 用于思考动画：标记上次切 thinking 的时间戳，配合 THINKING_MIN_MS 保证最短显示
  const thinkingSinceRef = useRef<number | null>(null)
  // 当前会话最新 assistant 消息的 id，便于流式事件追加到对应气泡
  const streamingIdRef = useRef<string | null>(null)
  // 滚动容器引用：每次流式新内容追加到底
  const listRef = useRef<HTMLDivElement | null>(null)
  // input 引用：发送后清空 + 拉回焦点
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // 当前用户 token
  const tokenRef = useRef<string | null>(null)
  // 当前用户 id（仅在 user 就绪后赋值；用作 sessionStorage key 命名空间）
  const userIdRef = useRef<string | null>(null)
  // 当前 session_id 的 ref（避免 send 时拿陈旧的 state；state 仅用于 UI 展示）
  const sessionIdRef = useRef<string | null>(null)
  // 把 sessionId state 同步进 ref（确保 send 拿到最新值）
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  /** 加载 token + 配额 + 当前用户（首次 mount；token 缺失时 user 也跳过） */
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const init = await window.panelApi.getInit()
        if (cancelled) return
        tokenRef.current = init.token
        if (!init.token) {
          setError('请先完成初始化（登录 + 定人格）')
          return
        }
        // 并行：配额 + 用户档案（不互相依赖）
        const [q, u] = await Promise.all([
          getQuota(init.token).catch(() => null),
          getMe(init.token).catch(() => null),
        ])
        if (cancelled) return
        if (q) setQuota(q)
        if (u) {
          setUser(u)
          // 记录 userId 用于 sessionStorage 命名空间
          userIdRef.current = u.id
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiCallError ? err.message : '初始化失败，请重试')
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 多轮对话会话串（M4 工单 A 衔接 B §B1）：
   *  - user.id 就绪后，按 user 维度复用 / 生成 session_id 并写入 state；
   *  - 后续 send() 直接读 state 里的 sessionId，传给 streamChat 的 options.sessionId；
   *  - 同一用户重启软件会复用同一个 session_id（localStorage 持久化）；
   *  - 「新会话」按钮：clearSession(userId) + 生成新 id 覆盖 state。
   */
  useEffect(() => {
    if (!user || !user.id) return
    // 先按 userId 读一遍，避免覆盖已有会话（关闭软件再开会回到同一会话）
    const existing = loadSessionId(user.id)
    if (existing) {
      setSessionId(existing)
      return
    }
    const fresh = ensureSessionId(user.id)
    setSessionId(fresh)
  }, [user])

  /** 加载 token + 配额（首次 mount） */
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const init = await window.panelApi.getInit()
        if (cancelled) return
        tokenRef.current = init.token
        if (!init.token) {
          setError('请先完成初始化（登录 + 定人格）')
          return
        }
        const q = await getQuota(init.token)
        if (cancelled) return
        setQuota(q)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiCallError ? err.message : '初始化失败，请重试')
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  /** 刷新配额（每次 chat 完成 / 配额拒绝时调用） */
  const refreshQuota = useCallback(async (): Promise<void> => {
    const token = tokenRef.current
    if (!token) return
    try {
      const q = await getQuota(token)
      setQuota(q)
    } catch {
      /* 静默：配额刷新失败不影响主聊天体验 */
    }
  }, [])

  /** 切桌宠思考动画（约定：window.petState 由桌宠 App 注册；panel 窗与 pet 窗同进程） */
  const setThinking = useCallback((thinking: boolean): void => {
    const fn = (window as unknown as { petState?: (s: string) => void }).petState
    if (typeof fn === 'function') {
      fn(thinking ? 'thinking' : 'idle')
    }
  }, [])

  /** 把思考动画切回 idle，但保证至少 THINKING_MIN_MS 显示时长 */
  const finishThinking = useCallback((): void => {
    const since = thinkingSinceRef.current
    if (since === null) {
      setThinking(false)
      return
    }
    thinkingSinceRef.current = null
    const elapsed = Date.now() - since
    const wait = Math.max(0, THINKING_MIN_MS - elapsed)
    if (wait === 0) {
      setThinking(false)
      return
    }
    setTimeout(() => {
      // 若期间又被切回 thinking（连发），不要强制覆盖
      if (thinkingSinceRef.current === null) setThinking(false)
    }, wait)
  }, [setThinking])

  /** 自动滚到底部：消息数 / 流式文本变化时触发 */
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  /** 发送按钮 / Ctrl+Enter 触发：把消息塞进 list 并发起流式请求 */
  const send = useCallback(async (): Promise<void> => {
    const text = input.trim()
    if (!text || streaming) return
    const token = tokenRef.current
    if (!token) {
      setError('请先完成初始化（登录 + 定人格）')
      return
    }
    if (quota && quota.remaining <= 0) {
      setError('今日对话次数已用完，明天再来吧')
      return
    }
    setError(null)
    setInput('')
    // 1) 立刻切桌宠思考动画（≤0.3s 硬性指标）
    setThinking(true)
    thinkingSinceRef.current = Date.now()
    // 2) 用户消息入列
    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      text,
    }
    // 3) 占位 assistant 消息（流式累加）
    const assistantId = newMessageId()
    streamingIdRef.current = assistantId
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      text: '',
      streaming: true,
    }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setStreaming(true)

    // 4) 计算本次会话 session_id：优先复用 state 里的；state 为空就现场生成并落盘
    const userId = userIdRef.current ?? user?.id ?? null
    const sid = sessionIdRef.current ?? (userId ? ensureSessionId(userId) : null)
    if (sid) {
      // 同步到 state 便于 UI 展示 + 写回 localStorage 防止丢
      sessionIdRef.current = sid
      if (userId) saveSessionId(userId, sid)
      if (!sessionId) setSessionId(sid)
    }

    // 5) 调用 streamChat（M4 工单 A 衔接 B §B1：传 sessionId，server 据此拉历史轮次）
    try {
      for await (const evt of streamChat(token, text, { sessionId: sid ?? undefined })) {
        applyEvent(evt)
      }
    } catch (err) {
      // 网络/解析错误：写入 system 消息
      const msg = err instanceof ApiCallError ? err.message : '对话请求失败'
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamingIdRef.current
            ? { ...m, streaming: false, error: msg }
            : m,
        ),
      )
      setError(msg)
    } finally {
      setStreaming(false)
      streamingIdRef.current = null
      finishThinking()
      void refreshQuota()
      // 拉回焦点，方便连续提问
      inputRef.current?.focus()
    }
  }, [input, streaming, quota, sessionId, user, setThinking, finishThinking, refreshQuota])

  /**
   * 「新会话」按钮：清空当前对话区 + 生成新的 session_id（清掉 localStorage 旧值）。
   * 适用于：用户想换个话题，不想让 server 把新问题接到旧历史里。
   */
  const startNewSession = useCallback((): void => {
    if (streaming) return
    const userId = userIdRef.current ?? user?.id ?? null
    if (userId) {
      clearSession(userId)
      const fresh = ensureSessionId(userId)
      sessionIdRef.current = fresh
      setSessionId(fresh)
    } else {
      // 极端：用户尚未就绪就点新会话；用临时 id 不持久化
      const tmp = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      sessionIdRef.current = tmp
      setSessionId(tmp)
    }
    setMessages([])
    setError(null)
  }, [streaming, user])

  /** 处理单个 SSE 事件 */
  const applyEvent = useCallback((evt: ChatSseEvent): void => {
    const id = streamingIdRef.current
    if (!id) return
    setMessages((prev) => applyChatEvent(prev, evt, id))
    // meta/done/error 事件都意味着后端不再产生新 delta，切回桌宠 idle
    if (isTerminalEvent(evt)) {
      finishThinking()
    }
  }, [finishThinking])

  /**
   * 关闭海报弹窗：revoke ObjectURL 防止内存泄漏。
   * 用户点"关闭"或弹窗外区域都走这里。
   */
  const closePosterModal = useCallback((): void => {
    setPosterModal((prev) => {
      if (prev && 'previewUrl' in prev) {
        URL.revokeObjectURL(prev.previewUrl)
      }
      return null
    })
  }, [])

  /**
   * 根据 assistant 消息 id 找到对应用户问题（取它前面最近一条 user 消息）。
   * 海报要展示"用户问了什么 + 桌宠怎么答"的精选对。
   */
  const findUserQuestionFor = useCallback(
    (assistantId: string, list: ChatMessage[]): string => {
      const idx = list.findIndex((m) => m.id === assistantId)
      if (idx < 0) return ''
      for (let i = idx - 1; i >= 0; i--) {
        const m = list[i]
        if (m && m.role === 'user') return m.text
      }
      return ''
    },
    [],
  )

  /**
   * 「生成海报」按钮点击：调 generatePoster()，UI 切到 generating → preview。
   * 失败时切到 failed（保留 blob 仍可保存本地，不让一次失败毁掉体验）。
   */
  const handleGeneratePoster = useCallback(
    async (assistantId: string): Promise<void> => {
      const list = messages
      const answerMsg = list.find((m) => m.id === assistantId)
      if (!answerMsg || answerMsg.role !== 'assistant') return
      const question = findUserQuestionFor(assistantId, list)
      const answer = answerMsg.text
      if (!user) {
        setError('用户档案未就绪，请稍后再试')
        return
      }
      if (!user.mbti) {
        setError('未确定人格，无法生成海报')
        return
      }
      const personaType = user.mbti
      const animal = user.animal ?? ''
      const nickname = user.nickname ?? user.email ?? '未命名用户'
      setPosterModal({ mode: 'generating', question, answer })
      // 1) 预加载 portrait data URL（主进程 IPC，可能耗时 1-5ms）
      const portraitDataUrl = await window.petApi.getPortraitDataUrl(personaType)
      // 2) 生成海报
      const input: PosterInput = {
        personaType,
        animal,
        nickname,
        question,
        answer,
        date: todayDateString(),
        portraitDataUrl,
      }
      try {
        const blob = await generatePoster(input)
        const previewUrl = URL.createObjectURL(blob)
        setPosterModal({ mode: 'preview', question, answer, blob, previewUrl })
      } catch (err) {
        // 即使生成失败，也允许保存（无法生成时直接给一个空 blob 让用户感知）
        setPosterModal({
          mode: 'failed',
          question,
          answer,
          blob: new Blob([], { type: 'image/png' }),
          previewUrl: '',
          reason: err instanceof Error ? err.message : '海报生成失败',
        })
      }
    },
    [messages, user, findUserQuestionFor],
  )

  /**
   * 「保存本地」按钮：触发浏览器下载，文件名 = Petibi-<人格>-<日期>.png。
   * 不依赖 server，幂等，重复点也安全（每次生成新 Blob）。
   */
  const handleSavePoster = useCallback((): void => {
    if (!posterModal || !('blob' in posterModal)) return
    const blob = posterModal.blob
    if (blob.size === 0) return
    const date = todayDateString()
    const type = user?.mbti ?? 'MBTI'
    downloadBlob(blob, `Petibi-${type}-${date}.png`)
  }, [posterModal, user])

  /**
   * 「分享到广场」按钮：
   *   1. 调 submitPoster 上传 base64 PNG（契约 {image_base64, persona_type, question_excerpt, answer_excerpt}）
   *   2. 调 bumpShareCount 累计分享次数（V2 装扮解锁前置数据）
   *   任一失败 → 切到 failed 态，保留 blob 允许保存本地
   */
  const handleSharePoster = useCallback(async (): Promise<void> => {
    if (!posterModal || !('blob' in posterModal)) return
    const token = tokenRef.current
    if (!token) {
      setError('登录态已失效，请重试')
      return
    }
    if (!user?.mbti) {
      setError('未确定人格，无法分享')
      return
    }
    const blob = posterModal.blob
    const question = posterModal.question
    const answer = posterModal.answer
    setPosterModal({ ...posterModal, mode: 'sharing' })
    try {
      const base64 = await blobToBase64(blob)
      // question/answer 在海报生成时已截断到 80/160 字；excerpt 再保险一次 ≤200 字
      const res = await submitPoster(token, {
        image_base64: base64,
        persona_type: user.mbti,
        question_excerpt: truncateExcerpt(question, 200),
        answer_excerpt: truncateExcerpt(answer, 200),
      })
      // 上墙成功后再 bump 一次（V2 装扮解锁数据），失败不阻塞
      try {
        await bumpShareCount(token)
      } catch {
        /* 计数失败不阻塞主分享流程 */
      }
      setPosterModal({ ...posterModal, mode: 'shared', posterId: res.poster_id })
    } catch (err) {
      const reason = err instanceof ApiCallError ? err.message : err instanceof Error ? err.message : '分享失败'
      setPosterModal({ ...posterModal, mode: 'failed', reason })
    }
  }, [posterModal, user])

  /** 渲染单条消息 */
  const renderMessage = useCallback(
    (m: ChatMessage): ReactNode => {
      if (m.role === 'system') {
        return (
          <div key={m.id} className="chat-msg is-system">
            <div className="chat-bubble">{m.error ?? m.text}</div>
          </div>
        )
      }
      if (m.role === 'user') {
        return (
          <div key={m.id} className="chat-msg is-user">
            <div className="chat-bubble">{m.text}</div>
          </div>
        )
      }
      const classes = ['chat-msg', 'is-assistant']
      if (m.refused) classes.push('refused')
      // 是否展示「生成海报」按钮：仅完成态 + 非流式 + 非错误 + 有人格
      const canShare =
        !m.streaming && !m.error && m.text.length > 0 && user?.mbti != null
      return (
        <div key={m.id} className={classes.join(' ')}>
          <div className="chat-bubble">
            {formatBubbleText(m.text)}
            {m.streaming && <span className="chat-cursor" aria-hidden="true" />}
            {m.rag_entry_id && !m.streaming && (
              <div className="chat-rag-tag">参考了百科条目：{m.rag_entry_id}</div>
            )}
            {m.error && <div className="chat-rag-tag" style={{ color: '#b53a3a' }}>{m.error}</div>}
          </div>
          {canShare && (
            <div className="chat-msg-actions">
              <button
                type="button"
                className="chat-action-btn"
                onClick={() => void handleGeneratePoster(m.id)}
                title="把这轮对话生成可分享的海报"
              >
                <PixelPosterIcon />
                生成海报
              </button>
            </div>
          )}
        </div>
      )
    },
    [user, handleGeneratePoster],
  )

  const canSend = useMemo(() => {
    if (streaming) return false
    if (!input.trim()) return false
    if (quota && quota.remaining <= 0) return false
    return true
  }, [input, streaming, quota])

  const quotaEmpty = quota !== null && quota.remaining <= 0

  return (
    <div className="chat-shell">
      <div className="chat-quota-row">
        <span>
          {quota
            ? `今日剩余 ${quota.remaining} / ${quota.limit} 次`
            : '加载配额中…'}
        </span>
        {sessionId && (
          <span className="chat-session-id" title="当前会话串 id（持久化在本地）">
            会话 {sessionId.slice(-6)}
          </span>
        )}
        <button
          type="button"
          className="chat-new-session-btn"
          onClick={startNewSession}
          disabled={streaming}
          title="清空当前对话，开启新会话（不影响历史对话）"
        >
          <PixelSparkleIcon />
          新会话
        </button>
        <span className={`chat-quota-pill ${quotaEmpty ? 'is-empty' : ''}`}>
          {quota ? `已用 ${quota.used}` : '—'}
        </span>
        {isMockMode && <span className="chat-mock-hint">mock 模式</span>}
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <PixelWaveIcon />
            <div style={{ marginTop: 8 }}>和你的桌宠聊聊吧</div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#8b8680' }}>
              {PLACEHOLDER_SAMPLE}
            </div>
          </div>
        )}
        {messages.map(renderMessage)}
      </div>

      <form
        className="chat-input-bar"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={quotaEmpty ? '今日次数已用完，明天再来吧' : '说点什么…（Enter 发送，Shift + Enter 换行）'}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          disabled={quotaEmpty}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={!canSend}
        >
          {streaming ? '生成中…' : '发送'}
        </button>
      </form>

      {posterModal && (
        <div
          className="poster-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closePosterModal()
          }}
        >
          <div className="poster-modal" role="dialog" aria-label="分享海报">
            <div className="poster-modal-header">
              <span className="poster-modal-title">分享海报</span>
              <button
                type="button"
                className="poster-modal-close"
                onClick={closePosterModal}
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <div className="poster-modal-body">
              {posterModal.mode === 'generating' && (
                <div className="poster-modal-loading">
                  <div className="poster-spinner" aria-hidden="true">
                    {Array.from({ length: 16 }).map((_, i) => (
                      <span key={i} />
                    ))}
                  </div>
                  <div>正在绘制海报…</div>
                </div>
              )}

              {('previewUrl' in posterModal) && posterModal.previewUrl && (
                <img
                  src={posterModal.previewUrl}
                  alt="分享海报预览"
                  className="poster-modal-img"
                />
              )}

              {posterModal.mode === 'sharing' && (
                <div className="poster-modal-hint">上墙中…</div>
              )}

              {posterModal.mode === 'shared' && (
                <div className="poster-modal-success">
                  ✅ 上墙成功，海报 id：<code>{posterModal.posterId}</code>
                </div>
              )}

              {posterModal.mode === 'failed' && (
                <div className="poster-modal-error">
                  ⚠️ {posterModal.reason}（仍可保存到本地）
                </div>
              )}
            </div>

            <div className="poster-modal-footer">
              <button
                type="button"
                className="profile-btn profile-btn-ghost"
                onClick={handleSavePoster}
                disabled={
                  !('blob' in posterModal) ||
                  ('blob' in posterModal && posterModal.blob.size === 0) ||
                  posterModal.mode === 'sharing'
                }
              >
                保存本地（PNG）
              </button>
              <button
                type="button"
                className="profile-btn profile-btn-primary"
                onClick={() => void handleSharePoster()}
                disabled={
                  posterModal.mode === 'sharing' ||
                  posterModal.mode === 'shared' ||
                  !('blob' in posterModal) ||
                  ('blob' in posterModal && posterModal.blob.size === 0)
                }
              >
                {posterModal.mode === 'sharing'
                  ? '上墙中…'
                  : posterModal.mode === 'shared'
                    ? '已上墙'
                    : '分享到广场'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== 像素图标（DESIGN.md §3 禁止 emoji 当功能图标）=====
/** 海报 icon：像素画板 + 4 色块；尺寸 12×12 */
function PixelPosterIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* 画板边框 */}
      <rect x="1" y="2" width="10" height="8" fill="#2B2320" />
      {/* 画板内底色 */}
      <rect x="2" y="3" width="8" height="6" fill="#FEF9EF" />
      {/* 像素色块：4 个不同色（DESIGN.md §2 四族色） */}
      <rect x="3" y="4" width="2" height="2" fill="#785D87" />
      <rect x="6" y="4" width="2" height="2" fill="#3E8F6E" />
      <rect x="3" y="7" width="2" height="2" fill="#399FB9" />
      <rect x="6" y="7" width="2" height="2" fill="#E4C728" />
    </svg>
  )
}

/** 挥手 icon：像素手掌；尺寸 28×28（空状态用） */
function PixelWaveIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="32"
      height="32"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* 手掌轮廓 */}
      <rect x="4" y="3" width="6" height="1" fill="#2B2320" />
      <rect x="3" y="4" width="8" height="1" fill="#2B2320" />
      <rect x="3" y="5" width="9" height="5" fill="#E4C728" />
      <rect x="3" y="10" width="8" height="1" fill="#2B2320" />
      <rect x="4" y="11" width="6" height="1" fill="#2B2320" />
      {/* 手指 */}
      <rect x="3" y="4" width="1" height="2" fill="#2B2320" />
      <rect x="5" y="2" width="1" height="2" fill="#2B2320" />
      <rect x="7" y="2" width="1" height="2" fill="#2B2320" />
      <rect x="9" y="3" width="1" height="2" fill="#2B2320" />
      {/* 袖口 */}
      <rect x="3" y="11" width="8" height="2" fill="#785D87" />
    </svg>
  )
}

/** 闪光 icon：4 个像素块拼一个十字星 */
function PixelSparkleIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 8 8"
      width="10"
      height="10"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="3" y="0" width="2" height="2" fill="#2B2320" />
      <rect x="3" y="6" width="2" height="2" fill="#2B2320" />
      <rect x="0" y="3" width="2" height="2" fill="#2B2320" />
      <rect x="6" y="3" width="2" height="2" fill="#2B2320" />
      <rect x="2" y="2" width="4" height="4" fill="#E4C728" />
    </svg>
  )
}