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
//   - 'pending-dbl'：收到第二次单击，立即派发 'panel' 并清 timer（注意：本状态机不需要
//                    显式表达 pending-dbl，因为收到第二次 click 会立即转移到 idle 并
//                    派发 panel，详见 feedClick）。
//
// API：
//   feed(state, event) → { next: State, action: 'menu' | 'panel' | null, clearTimer: boolean }
//
//   state: 当前状态（idle / pending）
//   event: { type: 'click', timestamp: number } | { type: 'reset' } | { type: 'fire-pending' }
//     - 'click'        新一次点击落点
//     - 'reset'        外部强行复位（极少用，留接口兜底）
//     - 'fire-pending' 250ms 定时器到点，强制派发待执行的 menu
//
// 边界值：
//   - 两次 click 时间差 < 250ms  → 派发 'panel'；
//   - 两次 click 时间差 ≥ 250ms  → 第一次 timer 触发 'menu'，第二次视为新单击再次进入 pending；
//   - 跨 250ms 但第二次 click 时 timer 已 fire → 第二次进入新 pending（不会派发 'panel'）。
//
// M5 修复（P0-A 根因）：本文件之前放在 `src/__tests__/decideClickSequence.test.ts` 里，
// 但 src/App.tsx 直接从 `./__tests__/decideClickSequence.test` 导入这些纯函数，
// 导致 vite/esbuild 在打渲染端 bundle 时把整条 vitest 依赖链也打进 `index-*.js`。
// 安装版运行时 React 一初始化就抛 "Vitest failed to access its internal state"，
// document.body 为 null / root 容器从未挂载——结果就是 pet 窗存在但完全透明不可见。
//
// 修复方案：把纯函数搬到 `src/decideClickSequence.ts`（非 __tests__ 目录），让 vite
// 自然排除 __tests__/，并在 __tests__/decideClickSequence.test.ts 改为从本文件 re-import。
// 这样既保证 vitest 仍能跑通真值表，又不会污染生产 bundle。

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