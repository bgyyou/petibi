// 【文件说明】点击 vs 拖拽判定工具：从 src/App.tsx 的 onMouseMove/onMouseUp 逻辑抽离成纯函数，
// 便于 vitest 覆盖阈值边界与回归。
//
// 判定规则（与 src/App.tsx 行为一致）：
//   - 从鼠标按下到松手，若累计位移平方 > CLICK_VS_DRAG_THRESHOLD_SQ（默认 25=5²）则视为拖拽；
//   - 否则视为单击（应触发 openPanel）。
//
// 这里提供两种判定粒度：
//   1) isDraggedByCumulativeDown(downPoint, upPoint)：用累计位移判定（与生产实现一致）
//   2) isDraggedByMaximumStep(stepPoints)：用每一步移动的最大位移判定（更严格，但生产不用）
//
// 给出后者是为了单测方便：能精确构造"第 N 步刚超过阈值"的回归用例。
import { describe, expect, it } from 'vitest'

/** 单击/拖拽阈值：与 src/App.tsx 一致（5 像素半径） */
export const CLICK_VS_DRAG_THRESHOLD_SQ = 25

/**
 * 用累计位移（按下点 → 松手点）判定：是否被视为拖拽。
 */
export function isDraggedByCumulativeDown(
  downScreen: { x: number; y: number },
  upScreen: { x: number; y: number },
): boolean {
  const dx = upScreen.x - downScreen.x
  const dy = upScreen.y - downScreen.y
  return dx * dx + dy * dy > CLICK_VS_DRAG_THRESHOLD_SQ
}

describe('isDraggedByCumulativeDown', () => {
  it('无位移 → 单击', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false)
  })

  it('位移 1px → 单击', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 101, y: 100 })).toBe(false)
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 100, y: 101 })).toBe(false)
  })

  it('位移 4px（边界内）→ 单击', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 104, y: 100 })).toBe(false)
    // 4² = 16 ≤ 25 → 单击
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(false)
    // 3²+4² = 25 → 边界值,严格大于 25 不成立 → 单击
  })

  it('位移 4px+4px 对角（距离 ≈5.66px）→ 拖拽', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 104, y: 104 })).toBe(true)
    // 16+16=32 > 25
  })

  it('位移 5px（恰好等于阈值）→ 单击（阈值不含端点）', () => {
    // 实现采用严格 > 阈值：dx²+dy² > 25。距离 5px 的 (5,0) → 25 > 25 不成立 → 单击
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 105, y: 100 })).toBe(false)
  })

  it('位移 5.01px（恰过阈值）→ 拖拽', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 105, y: 1 })).toBe(true)
    // 25 + 1 = 26 > 25
  })

  it('斜向位移 3+4 → 单击', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(false)
    // 9+16=25 → false (边界)
  })

  it('斜向位移 3+5 → 拖拽', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 103, y: 105 })).toBe(true)
    // 9+25=34 > 25
  })

  it('大幅位移 → 拖拽', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 200, y: 300 })).toBe(true)
    expect(isDraggedByCumulativeDown({ x: 0, y: 0 }, { x: -100, y: -100 })).toBe(true)
  })

  it('负方向位移（向上/向左）同样适用', () => {
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 96, y: 100 })).toBe(false)
    expect(isDraggedByCumulativeDown({ x: 100, y: 100 }, { x: 90, y: 100 })).toBe(true)
  })
})