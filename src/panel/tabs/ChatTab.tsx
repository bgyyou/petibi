// 【文件说明】对话 Tab（M3 桌宠交互层核心）：与 server POST /api/chat（SSE 流式）对接。
//
// 行为契约（PRD §2 / §3.4）：
//   1. 加载期：调 getInit() 取 token；调 getQuota(token) 取今日剩余次数；展示在顶部
//   2. 发送消息：立刻（≤0.3s）切桌宠思考动画（petState('thinking')），首字延迟到再切回 idle
//   3. 流式接收：每条 delta 累加到对应 assistant 消息，UI 自动滚动到底部
//   4. 完成（done）：保留 streaming=false；触发切回 idle；刷新配额
//   5. 错误（error）：显示在系统消息气泡；停止流；切回 idle
//   6. 配额耗尽：发送按钮禁用，提示「今日次数已用完」
//
// mock 模式：默认开启（VITE_USE_MOCK_API !== 'false'），dev 无 server 也能完整体验流式与越界拒绝。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, ChatSseEvent, QuotaInfo } from '../../api/types'
import {
  ApiCallError,
  getQuota,
  isMockMode,
  streamChat,
} from '../../api/client'
import { applyChatEvent, formatBubbleText, isTerminalEvent } from '../chat-reducer'

// 本地常量
const THINKING_MIN_MS = 250 // 思考动画最短显示，避免一闪而过丢失拟人感
const PLACEHOLDER_SAMPLE = '试试问：「明天要当众演讲好紧张」或「写代码不在我职责范围」'

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

    // 4) 调用 streamChat
    try {
      for await (const evt of streamChat(token, text)) {
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
  }, [input, streaming, quota, setThinking, finishThinking, refreshQuota])

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

  /** 渲染单条消息 */
  const renderMessage = useCallback((m: ChatMessage): ReactNode => {
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
      </div>
    )
  }, [])

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
        <span className={`chat-quota-pill ${quotaEmpty ? 'is-empty' : ''}`}>
          {quota ? `已用 ${quota.used}` : '—'}
        </span>
        {isMockMode && <span className="chat-mock-hint">mock 模式</span>}
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div style={{ fontSize: 28, marginBottom: 8 }}>👋</div>
            <div>和你的桌宠聊聊吧</div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#b0b0aa' }}>
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
    </div>
  )
}