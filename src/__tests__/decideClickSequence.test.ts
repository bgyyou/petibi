// 【文件说明】桌宠单击 vs 双击判定纯函数真值表测试（M4 收尾修复工单）：
//
// M5 修复（P0-A 根因）后位置说明：本测试文件之前同时承担「纯函数定义 + vitest 真值表」
// 两个职责，被 src/App.tsx 反向 import。结果是 vite/esbuild 打 bundle 时把整条 vitest
// 依赖链也打进了 `out/renderer/assets/index-*.js`，安装版运行 React 初始化阶段
// 就抛 "Vitest failed to access its internal state"，导致桌宠窗内容永远没渲染（pet
// 窗 BrowserWindow 存在但全透明不可见）。
//
// 修复方案：纯函数搬到 src/decideClickSequence.ts（不含 vitest import），本测试文件
// 改为 re-import 并只保留 vitest describe/expect。App.tsx 改为从 decideClickSequence.ts
// 导入，bundle 自然不再被 vitest 污染。
//
// 测试目的：钉死 250ms 阈值的真值表（边界 / 单击 / 双击 / 三连击 / 超阈值连击），
// 防止后续重构把 clickState 状态机改坏。

import { describe, expect, it } from 'vitest'

import {
  feedClick,
  isWithinDoubleClickThreshold,
  type ClickState,
} from '../decideClickSequence'

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