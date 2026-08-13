// 【文件说明】ChatTab 多轮对话会话串接线测试（M4 工单 A 衔接工单 B §B1 验收）：
//
// 验收点（终审反馈的衔接缺口）：
//  1) ChatTab.send 真实跑通：mock 模式下 streamChat 接受 options.sessionId 不抛错；
//  2) options.sessionId 通过 streamChat 的真实接口分支透传到 fetch body（session_id 字段）；
//  3) 真接口分支下 sessionId 为空时 fetch body 不携带 session_id（向后兼容）；
//  4) streamChat mock 模式调用次序仍是 meta → delta* → done（与既有契约一致）。
//
// 实现策略：
//  - USE_MOCK 是模块顶层 const，但配套 __setMockMode 让测试可临时切到 real 路径；
//  - 不引入 React 渲染依赖：直接用 fetch spy 验证 realStreamChat 路径上的 body；
//  - mock 模式直接调 streamChat 不接 fetch，验证不会因新参数崩溃即可。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSseEvent } from '../../api/types'

describe('streamChat sessionId 透传（M4 工单 A 衔接 B）', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let originalMockMode = true

  beforeEach(async () => {
    fetchSpy = vi.fn()
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    // 记录初始模式便于 afterEach 还原
    const api = await import('../../api/client')
    originalMockMode = api.isMockMode
  })

  afterEach(async () => {
    const api = await import('../../api/client')
    api.__setMockMode(originalMockMode)
    vi.restoreAllMocks()
  })

  it('mock 模式：streamChat 接受 options.sessionId 且事件序列不变', async () => {
    const api = await import('../../api/client')
    api.__setMockMode(true)
    api.__resetMockDb()
    await api.sendEmailCode('session-a@example.com')
    const auth = await api.verifyEmailCode('session-a@example.com', '123456')
    const events: ChatSseEvent[] = []
    for await (const evt of api.streamChat(auth.token, '你好', {
      sessionId: 'mock-session-1',
    })) {
      events.push(evt)
    }
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events[0]?.type).toBe('meta')
    expect(events[events.length - 1]?.type).toBe('done')
    // mock 路径不触发 fetch
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('真接口 + 传 sessionId：fetch body 含 session_id 字段', async () => {
    const api = await import('../../api/client')
    api.__setMockMode(false)
    const encoder = new TextEncoder()
    const fakeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"meta","rag_entry_id":null,"refused":false}\n\n'),
        )
        controller.enqueue(encoder.encode('data: {"type":"done","total_chars":0}\n\n'))
        controller.close()
      },
    })
    fetchSpy.mockResolvedValueOnce(
      new Response(fakeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    const events: ChatSseEvent[] = []
    for await (const evt of api.streamChat('test-token', '你好', { sessionId: 'sid-xyz-001' })) {
      events.push(evt)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    const bodyStr = (call?.[1] as RequestInit).body as string
    expect(bodyStr).toBeDefined()
    const parsed = JSON.parse(bodyStr) as { question: string; session_id?: string }
    expect(parsed.question).toBe('你好')
    expect(parsed.session_id).toBe('sid-xyz-001')
    expect(events[0]?.type).toBe('meta')
    expect(events[events.length - 1]?.type).toBe('done')
  })

  it('真接口 + 不传 sessionId：fetch body 不含 session_id（向后兼容）', async () => {
    const api = await import('../../api/client')
    api.__setMockMode(false)
    const encoder = new TextEncoder()
    const fakeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"meta","rag_entry_id":null,"refused":false}\n\n'),
        )
        controller.enqueue(encoder.encode('data: {"type":"done","total_chars":0}\n\n'))
        controller.close()
      },
    })
    fetchSpy.mockResolvedValueOnce(
      new Response(fakeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    for await (const _evt of api.streamChat('test-token', '不带 sessionId')) {
      void _evt
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const bodyStr = (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string
    const parsed = JSON.parse(bodyStr) as { question: string; session_id?: string }
    expect(parsed.question).toBe('不带 sessionId')
    // 关键：session_id 不应出现在 body（向后兼容旧 server / mock 不接该字段也不报错）
    expect(parsed.session_id).toBeUndefined()
  })

  it('真接口 + 传空串 sessionId：fetch body 不含 session_id（容错）', async () => {
    const api = await import('../../api/client')
    api.__setMockMode(false)
    const encoder = new TextEncoder()
    const fakeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"meta","rag_entry_id":null,"refused":false}\n\n'),
        )
        controller.enqueue(encoder.encode('data: {"type":"done","total_chars":0}\n\n'))
        controller.close()
      },
    })
    fetchSpy.mockResolvedValueOnce(
      new Response(fakeStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )
    for await (const _evt of api.streamChat('test-token', '空 sessionId', {
      sessionId: '   ',
    })) {
      void _evt
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const bodyStr = (fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string
    const parsed = JSON.parse(bodyStr) as { session_id?: string }
    // 空串/空白 → 不携带
    expect(parsed.session_id).toBeUndefined()
  })
})