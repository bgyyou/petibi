// 【文件说明】chat-reducer 纯函数测试：覆盖 SSE 事件 → 消息列表的状态更新。
//
// 设计要点：
//   - reducer 是纯函数，不依赖 React；可直接 import 调用；
//   - 重点验证：delta 文本追加、meta 携带 refused/rag_entry_id、done/error 关闭 streaming 流式标志、
//     容错（streamingId 找不到时返回原数组）、流式状态不被非目标消息影响。
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../api/types'
import { applyChatEvent, formatBubbleText, isTerminalEvent } from '../chat-reducer'

/** 构造单条消息的简易工厂 */
function makeMsg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    text: '',
    streaming: true,
    ...over,
  }
}

describe('applyChatEvent', () => {
  it('meta 事件写入 refused 与 rag_entry_id', () => {
    const msg = makeMsg({ id: 'm1' })
    const next = applyChatEvent(
      [msg],
      { type: 'meta', rag_entry_id: 'ENTP-scenario-public-speaking', refused: false },
      'm1',
    )
    expect(next[0]?.refused).toBe(false)
    expect(next[0]?.rag_entry_id).toBe('ENTP-scenario-public-speaking')
    // meta 不应清掉 streaming：后续还会来 delta
    expect(next[0]?.streaming).toBe(true)
    // 不可变
    expect(next[0]).not.toBe(msg)
  })

  it('meta 事件 refused=true 也照样写入', () => {
    const next = applyChatEvent(
      [makeMsg({})],
      { type: 'meta', rag_entry_id: null, refused: true },
      'm1',
    )
    expect(next[0]?.refused).toBe(true)
    expect(next[0]?.rag_entry_id).toBeNull()
  })

  it('多个 delta 事件累加文本', () => {
    let msgs: ChatMessage[] = [makeMsg({})]
    msgs = applyChatEvent(msgs, { type: 'delta', text: '你好' }, 'm1')
    msgs = applyChatEvent(msgs, { type: 'delta', text: '，' }, 'm1')
    msgs = applyChatEvent(msgs, { type: 'delta', text: '我是 Mock。' }, 'm1')
    expect(msgs[0]?.text).toBe('你好，我是 Mock。')
    expect(msgs[0]?.streaming).toBe(true)
  })

  it('done 事件清掉 streaming 标志', () => {
    let msgs: ChatMessage[] = [makeMsg({ text: 'abc' })]
    msgs = applyChatEvent(msgs, { type: 'done', total_chars: 3 }, 'm1')
    expect(msgs[0]?.streaming).toBe(false)
    expect(msgs[0]?.text).toBe('abc')
  })

  it('error 事件清掉 streaming 并写入 error 字段', () => {
    let msgs: ChatMessage[] = [makeMsg({})]
    msgs = applyChatEvent(msgs, { type: 'error', message: '今日对话次数已用完' }, 'm1')
    expect(msgs[0]?.streaming).toBe(false)
    expect(msgs[0]?.error).toBe('今日对话次数已用完')
  })

  it('streamingId 找不到时消息字段不变（容错）', () => {
    const msgs: ChatMessage[] = [
      makeMsg({ id: 'm1', text: '老内容' }),
      makeMsg({ id: 'm2', text: '其他消息', streaming: false }),
    ]
    const next = applyChatEvent(msgs, { type: 'delta', text: '追加' }, 'm-not-found')
    // 内容相等：所有消息的字段都不变
    expect(next).toEqual(msgs)
    expect(next[0]?.text).toBe('老内容')
    expect(next[1]?.text).toBe('其他消息')
    expect(next[1]?.streaming).toBe(false)
  })

  it('只更新 streamingId 对应的那条消息，其他消息不受影响', () => {
    const msgs: ChatMessage[] = [
      makeMsg({ id: 'a', text: 'A' }),
      makeMsg({ id: 'b', text: 'B', streaming: false }),
    ]
    const next = applyChatEvent(msgs, { type: 'delta', text: '+' }, 'a')
    expect(next[0]?.text).toBe('A+')
    expect(next[1]?.text).toBe('B')
    expect(next[1]?.streaming).toBe(false)
  })

  it('不可变更新：返回新数组/新对象，原引用未变', () => {
    const msg = makeMsg({})
    const msgs = [msg]
    const next = applyChatEvent(msgs, { type: 'delta', text: 'x' }, 'm1')
    expect(next).not.toBe(msgs)
    expect(next[0]).not.toBe(msg)
    expect(msg.text).toBe('')
  })

  it('用户消息（streamingId 不匹配）永远不被 reducer 改动', () => {
    const userMsg: ChatMessage = { id: 'u1', role: 'user', text: '提问' }
    const next = applyChatEvent([userMsg], { type: 'delta', text: 'x' }, 'a1')
    expect(next[0]?.text).toBe('提问')
    expect(next[0]?.role).toBe('user')
  })
})

describe('isTerminalEvent', () => {
  it('meta / done / error 视为终止事件（应当切回 idle）', () => {
    expect(isTerminalEvent({ type: 'meta', rag_entry_id: null, refused: false })).toBe(true)
    expect(isTerminalEvent({ type: 'done', total_chars: 0 })).toBe(true)
    expect(isTerminalEvent({ type: 'error', message: 'x' })).toBe(true)
  })

  it('delta 不是终止事件（不应切 idle）', () => {
    expect(isTerminalEvent({ type: 'delta', text: 'x' })).toBe(false)
  })
})

describe('formatBubbleText', () => {
  it('passthrough：当前实现原样返回文本', () => {
    expect(formatBubbleText('hello')).toBe('hello')
    expect(formatBubbleText('包含\n换行')).toBe('包含\n换行')
  })
})