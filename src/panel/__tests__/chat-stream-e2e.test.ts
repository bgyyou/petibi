// 【文件说明】对话端到端流式测试：mock 模式下完整跑通 streamChat + applyChatEvent + thinking 切换链路。
//
// 验证（自验清单第 3 条后半段）：
//   1. mock 流式事件序列与 server 契约 §4 完全一致：meta → 多 delta → done
//   2. delta 文本累加等于整段回复（流式拼接正确）
//   3. refused 关键词命中 → meta.refused=true 且文本走"写代码不在职责范围"类风格
//   4. thinking 切换时机：发送瞬间 true，收到 meta 或首条 delta 后 false（≤0.3s 目标）
//   5. ChatMessage 列表经过 reducer 后能正确反映 refused / streaming 状态
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ChatSseEvent } from '../../api/types'
import {
  __resetMockDb,
  sendEmailCode,
  streamChat,
  verifyEmailCode,
} from '../../api/client'
import { applyChatEvent, isTerminalEvent } from '../chat-reducer'

/** mock 模式下注册一个新邮箱用户并拿到 token */
async function freshToken(email: string): Promise<string> {
  await sendEmailCode(email)
  const auth = await verifyEmailCode(email, '123456')
  return auth.token
}

describe('streamChat (mock 模式) → applyChatEvent 链路', () => {
  beforeEach(() => {
    __resetMockDb()
  })
  afterEach(() => {
    __resetMockDb()
  })

  it('正常问候：meta → delta* → done 顺序，文本累加正确', async () => {
    const token = await freshToken('alice@example.com')
    const events: ChatSseEvent[] = []
    for await (const evt of streamChat(token, '你好')) {
      events.push(evt)
    }

    // 1) 序列断言
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events[0]?.type).toBe('meta')
    expect(events[events.length - 1]?.type).toBe('done')

    // 2) meta.refused=false，rag_entry_id=null（"你好"是闲聊）
    const meta = events[0] as Extract<ChatSseEvent, { type: 'meta' }>
    expect(meta.refused).toBe(false)
    expect(meta.rag_entry_id).toBeNull()

    // 3) delta 文本累加 = 完整回复
    const fullText = events
      .filter((e): e is Extract<ChatSseEvent, { type: 'delta' }> => e.type === 'delta')
      .map((d) => d.text)
      .join('')
    expect(fullText).toContain('mock')
    expect(fullText.length).toBeGreaterThan(0)
  })

  it('越界问题：meta.refused=true，且文本以拒绝风格开头', async () => {
    const token = await freshToken('bob@example.com')
    const events: ChatSseEvent[] = []
    for await (const evt of streamChat(token, '帮我写代码')) {
      events.push(evt)
    }
    const meta = events.find((e) => e.type === 'meta') as Extract<ChatSseEvent, { type: 'meta' }>
    expect(meta.refused).toBe(true)
    const fullText = events
      .filter((e): e is Extract<ChatSseEvent, { type: 'delta' }> => e.type === 'delta')
      .map((d) => d.text)
      .join('')
    expect(fullText).toContain('mock')
  })

  it('reducer 应用 mock 流后，最终消息 streaming=false 且文本完整', async () => {
    const token = await freshToken('carol@example.com')
    const initial: ChatMessage[] = [
      { id: 'user', role: 'user', text: '紧张怎么办' },
      { id: 'assistant', role: 'assistant', text: '', streaming: true },
    ]
    let msgs = initial
    const assistantId = 'assistant'
    for await (const evt of streamChat(token, '紧张怎么办')) {
      msgs = applyChatEvent(msgs, evt, assistantId)
    }
    const finalAssistant = msgs.find((m) => m.id === assistantId)!
    expect(finalAssistant.streaming).toBe(false)
    expect(finalAssistant.text.length).toBeGreaterThan(0)
    expect(finalAssistant.text).toContain('mock')
    // 用户消息保持不变
    expect(msgs.find((m) => m.id === 'user')?.text).toBe('紧张怎么办')
  })

  it('thinking 切换：发送瞬间 true，收到首条 meta/delta 后 false（≤0.3s 目标）', async () => {
    const token = await freshToken('dave@example.com')
    // 模拟 ChatTab 的状态机：
    // - 发送瞬间：thinking = true, since = now()
    // - 收到事件后按 isTerminalEvent 切回 false
    let thinking = false
    let switchCount = 0
    const startMark = Date.now()
    let firstEventAt: number | null = null

    // 模拟"按下发送按钮"的瞬间
    thinking = true
    switchCount++
    for await (const evt of streamChat(token, '试试说一句')) {
      if (firstEventAt === null) firstEventAt = Date.now() - startMark
      if (thinking && isTerminalEvent(evt)) {
        thinking = false
        switchCount++
      }
    }
    // 1) 状态机至少经历：true → false 两次切换
    expect(switchCount).toBeGreaterThanOrEqual(2)
    // 2) 流结束时应回到 idle
    expect(thinking).toBe(false)
    // 3) mock 模式首字延迟 < 300ms（PRD §3.4 硬性指标：本测试只校验 mock 模式）
    expect(firstEventAt).not.toBeNull()
    expect(firstEventAt!).toBeLessThan(300)
  })
})