// 【文件说明】桌宠单击 vs 双击判定纯函数（M4 收尾修复工单）：
//   - 单击（无后续点击且位移 <5px）→ 250ms 延时后触发「快捷菜单」
//   - 双击（250ms 内出现第二次点击且位移 <5px）→ 立即触发「打开主面板」
//   - 拖拽（位移 ≥5px）→ 不触发任何点击行为，由 mousedown/move 路径处理
//
// 设计目标：
//   1. 行为可预测——状态机用「上一击时间戳 + 待执行 timer 引用」两个变量描述；
//   2. 纯函数化——不依赖 React runtime，把"接收一次点击 + 当前状态"和"返回下一次状态
//      + 派发动作"分开，便于 vitest 在 node 环境钉死边界（timeout 边界、连击边界）。
//
// 状态：
//   - 'idle'       ：无 pending 状态；
//   - 'pending'    ：收到一次单击，setTimeout 计时中，250ms 内未收到第二次则派发 'menu'；
//   - 'pending-dbl'：收到第二次单击，立即派发 'panel' 并清 timer。
//
// API：
//   feed(state, event) → { next: State, action: 'menu' | 'panel' | null, clearTimer: boolean }
//
//   state: 当前状态（idle / pending / pending-dbl）
//   event: { type: 'click', timestamp: number } | { type: 'reset' } | { type: 'fire-pending' }
//     - 'click'        新一次点击落点
//     - 'reset'        外部强行复位（极少用，留接口兜底）
//     - 'fire-pending' 250ms 定时器到点，强制派发待执行的 menu
//
// 边界值：
//   - 两次 click 时间差 < 250ms  → 派发 'panel'；
//   - 两次 click 时间差 ≥ 250ms  → 第一次 timer 触发 'menu'，第二次视为新单击再次进入 pending；
//   - 跨 250ms 但第二次 click 时 timer 已 fire → 第二次进入新 pending（不会派发 'panel'）。

import { describe, expect, it } from 'vitest'

/** 双击判定阈值：250ms 内出现第二次点击视为双击（owner 决定） */
export const DOUBLE_CLICK_THRESHOLD_MS = 250

/** 桌宠单击/双击状态机的状态 */
export type ClickState = 'idle' | 'pending'

/** 喂入事件 */
export type ClickEvent =
  | { type: 'click'; timestamp: number }
  | { type: 'reset' }
  | { type: 'fire-pending' }

/** 状态机转移结果 */
export interface ClickDecision {
  next: ClickState
  /** null = 不派发；'menu' = 派发"打开快捷菜单"；'panel' = 派发"打开主面板" */
  action: 'menu' | 'panel' | null
  /** 是否需要 clearTimeout 上一次的 250ms 计时器（避免双触发） */
  clearTimer: boolean
}

/**
 * 桌宠单击 / 双击状态机纯函数。
 * 注意：这是事件流判定器，timer 由调用方在 fire-pending 时启动（详见 App.tsx 实现）。
 */
export function feedClick(state: ClickState, event: ClickEvent): ClickDecision {
  // reset：外部强行复位（用于窗口隐藏 / 显示状态切换时清掉残留）
  if (event.type === 'reset') {
    return { next: 'idle', action: null, clearTimer: true }
  }
  if (event.type === 'fire-pending') {
    // 250ms 到点：必须当前是 pending 状态（防御性，防止外部误调）
    if (state !== 'pending') {
      return { next: state, action: null, clearTimer: false }
    }
    return { next: 'idle', action: 'menu', clearTimer: true }
  }
  // event.type === 'click'
  if (state === 'idle') {
    // 第一次点击：进入 pending，等待 250ms 看是否有第二次
    return { next: 'pending', action: null, clearTimer: false }
  }
  // state === 'pending' 且收到新 click：视为双击，立即派发 panel
  return { next: 'idle', action: 'panel', clearTimer: true }
}

/**
 * 两次点击之间是否在 250ms 阈值内（用于 setTimeout 内事件路径直接判定）。
 * 单独抽出便于测试 + App.tsx 内部用。
 */
export function isWithinDoubleClickThreshold(
  prevTimestamp: number,
  currTimestamp: number,
  thresholdMs: number = DOUBLE_CLICK_THRESHOLD_MS,
): boolean {
  return currTimestamp - prevTimestamp < thresholdMs
}

describe('M4 收尾修复：桌宠单击/双击状态机', () => {
  it('idle → click → pending，不派发', () => {
    const r = feedClick('idle', { type: 'click', timestamp: 1000 })
    expect(r).toEqual({ next: 'pending', action: null, clearTimer: false })
  })

  it('pending → fire-pending（250ms 到点）→ 派发 menu', () => {
    const r = feedClick('pending', { type: 'fire-pending' })
    expect(r).toEqual({ next: 'idle', action: 'menu', clearTimer: true })
  })

  it('pending → click（250ms 内）→ 派发 panel', () => {
    const r = feedClick('pending', { type: 'click', timestamp: 1200 })
    expect(r).toEqual({ next: 'idle', action: 'panel', clearTimer: true })
  })

  it('idle → click → fire-pending → 再 click → 重新进入 pending（不派发）', () => {
    // 模拟"第一次 timer 到点派发 menu，第二次独立进入新 pending"
    let s: ClickState = 'idle'
    let r = feedClick(s, { type: 'click', timestamp: 1000 })
    s = r.next
    expect(s).toBe('pending')
    r = feedClick(s, { type: 'fire-pending' })
    s = r.next
    expect(s).toBe('idle')
    expect(r.action).toBe('menu')
    r = feedClick(s, { type: 'click', timestamp: 2000 })
    s = r.next
    expect(s).toBe('pending')
    expect(r.action).toBeNull()
  })

  it('reset 强制复位（清 timer）', () => {
    const r = feedClick('pending', { type: 'reset' })
    expect(r).toEqual({ next: 'idle', action: null, clearTimer: true })
  })

  it('fire-pending 在 idle 状态下不派发（防御性）', () => {
    const r = feedClick('idle', { type: 'fire-pending' })
    expect(r).toEqual({ next: 'idle', action: null, clearTimer: false })
  })
})

describe('M4 收尾修复：250ms 阈值边界', () => {
  it('差值 249ms → 在阈值内', () => {
    expect(isWithinDoubleClickThreshold(1000, 1249)).toBe(true)
  })

  it('差值 250ms → 不在阈值内（严格小于）', () => {
    expect(isWithinDoubleClickThreshold(1000, 1250)).toBe(false)
  })

  it('差值 251ms → 不在阈值内', () => {
    expect(isWithinDoubleClickThreshold(1000, 1251)).toBe(false)
  })

  it('同时间戳 → 视为双击（差值 0）', () => {
    expect(isWithinDoubleClickThreshold(1000, 1000)).toBe(true)
  })

  it('自定义阈值（150ms 测试）', () => {
    expect(isWithinDoubleClickThreshold(1000, 1149, 150)).toBe(true)
    expect(isWithinDoubleClickThreshold(1000, 1150, 150)).toBe(false)
  })
})

describe('M4 收尾修复：双击交互端到端事件流（模拟 App.tsx 实际路径）', () => {
  it('单击：idle → click(t1) → 250ms 后 fire-pending → action=menu', () => {
    let s: ClickState = 'idle'
    // t1 = 1000
    let r = feedClick(s, { type: 'click', timestamp: 1000 })
    s = r.next
    expect(s).toBe('pending')
    // 250ms 后到点（外部 setTimeout 触发 fire-pending）
    r = feedClick(s, { type: 'fire-pending' })
    s = r.next
    expect(s).toBe('idle')
    expect(r.action).toBe('menu')
  })

  it('双击：idle → click(1000) → 100ms 后 click(1100) → 派发 panel', () => {
    let s: ClickState = 'idle'
    let r = feedClick(s, { type: 'click', timestamp: 1000 })
    s = r.next
    expect(s).toBe('pending')
    // 第二次点击：差值 100ms < 250ms → 立即派发 panel
    r = feedClick(s, { type: 'click', timestamp: 1100 })
    s = r.next
    expect(s).toBe('idle')
    expect(r.action).toBe('panel')
  })

  it('三连击：第二次派发 panel 后，第三次进入新 pending（不重复 panel）', () => {
    let s: ClickState = 'idle'
    let r = feedClick(s, { type: 'click', timestamp: 1000 })
    s = r.next
    r = feedClick(s, { type: 'click', timestamp: 1100 })
    s = r.next
    expect(r.action).toBe('panel')
    expect(s).toBe('idle')
    // 第三次 click：进入 pending，等待
    r = feedClick(s, { type: 'click', timestamp: 1200 })
    s = r.next
    expect(s).toBe('pending')
    expect(r.action).toBeNull()
  })

  it('超阈值连击：第一次 timer 已 fire 派发 menu，第二次 click 重新进入 pending', () => {
    let s: ClickState = 'idle'
    let r = feedClick(s, { type: 'click', timestamp: 1000 })
    s = r.next
    // 250ms 后 timer 触发
    r = feedClick(s, { type: 'fire-pending' })
    s = r.next
    expect(r.action).toBe('menu')
    // 用户在 300ms 时再点（远超 250ms）：新的 pending
    r = feedClick(s, { type: 'click', timestamp: 1300 })
    s = r.next
    expect(s).toBe('pending')
    expect(r.action).toBeNull()
  })
})
