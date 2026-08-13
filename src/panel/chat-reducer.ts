// 【文件说明】对话 Tab 的纯函数 reducer：把 SSE 事件应用到消息列表。
// 抽离 ChatTab.tsx 中的 applyEvent 逻辑为独立纯函数，便于 vitest 单测覆盖；
// ChatTab.tsx 调用本文件导出的 applyChatEvent 完成 UI 状态更新。
//
// 设计原则：
//   - 不可变更新（返回新数组/新对象），避免 React 引用比较失效；
//   - 找不到对应消息 id 时返回原数组（容错：极端时序下事件先于消息创建）；
//   - 流式状态由 streamingId 决定当前写入哪条消息，调用方维护 id 生命周期。
import type { ChatMessage, ChatSseEvent } from '../api/types'

/**
 * 把单个 SSE 事件应用到消息列表。
 *
 * @param messages 当前消息列表（不可变）
 * @param evt      后端发来的事件
 * @param streamingId 当前正在流式写入的消息 id（assistant 占位气泡）；找不到则跳过
 * @returns 新消息列表（不可变）
 */
export function applyChatEvent(
  messages: ChatMessage[],
  evt: ChatSseEvent,
  streamingId: string | null,
): ChatMessage[] {
  // meta / done / error / guard 等控制事件也要在流式消息不存在时安全降级
  return messages.map((m) => {
    if (m.id !== streamingId) return m
    if (evt.type === 'meta') {
      return { ...m, refused: evt.refused, rag_entry_id: evt.rag_entry_id }
    }
    if (evt.type === 'delta') {
      // 流式文本追加：mock 模式下可能一次性 emit 整段，这里不做限速
      return { ...m, text: m.text + evt.text }
    }
    if (evt.type === 'guard') {
      // M3 流式守卫：mid-stream 截断；用该人格的拒绝模板替换剩余输出，关闭 streaming
      return { ...m, text: evt.text, streaming: false }
    }
    if (evt.type === 'done') {
      return { ...m, streaming: false }
    }
    if (evt.type === 'error') {
      return { ...m, streaming: false, error: evt.message }
    }
    return m
  })
}

/**
 * 判断一条 SSE 事件是否意味着"流已结束，应当切回桌宠 idle 动画"。
 * 抽取独立函数便于测试覆盖（ChatTab.tsx 复用）。
 *
 * M3 流式守卫改造：guard 事件也作为终态（流被中途截断，UI 应切回 idle）。
 */
export function isTerminalEvent(evt: ChatSseEvent): boolean {
  return evt.type === 'meta' || evt.type === 'done' || evt.type === 'error' || evt.type === 'guard'
}

/**
 * 简易气泡文本格式化（当前 passthrough；后续可能接入 markdown）。
 * 抽出便于将来扩展时不影响 UI 组件。
 */
export function formatBubbleText(text: string): string {
  return text
}