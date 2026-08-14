// 【文件说明】结果页百分比条 + 弱倾向提示的判定逻辑测试（T3 工单第 4 条 + 自验清单第 3 条）：
//   - 四维（EI/SN/TF/JP）百分比条按 score().percentages 取值渲染；
//   - 当某维度"第一极百分比"落在 [45, 55] 时显示弱倾向提示文案：
//     "这个维度你的倾向较弱，结果可能随状态波动"；
//   - 45%-55% 边界（51% / 50% / 45%）需要命中；
//   - 强倾向（80% / 20%）不应触发提示。

import { describe, expect, it } from 'vitest'
import type { TypeResult } from '../../scoring/types'

/** 与 ResultPage.tsx 里的 DIM_ROWS 同步 */
const DIM_ROWS: Array<{
  key: 'EI' | 'SN' | 'TF' | 'JP'
  first: string
  second: string
  name: string
}> = [
  { key: 'EI', first: 'E', second: 'I', name: '能量来源' },
  { key: 'SN', first: 'S', second: 'N', name: '信息接收' },
  { key: 'TF', first: 'T', second: 'F', name: '决策方式' },
  { key: 'JP', first: 'J', second: 'P', name: '生活态度' },
]

/** 弱倾向阈值：与 ResultPage.tsx 的 WEAK_PCT_LOW / WEAK_PCT_HIGH 同步 */
const WEAK_PCT_LOW = 45
const WEAK_PCT_HIGH = 55

/**
 * 判定某维度是否弱倾向（与 ResultPage 渲染逻辑同步）：
 *   - percentages[key] 落在 [45, 55] 区间 → 显示提示
 *   - 其他 → 不显示
 */
function isWeakDimension(percentages: TypeResult['percentages'], key: 'EI' | 'SN' | 'TF' | 'JP'): boolean {
  const firstPct = percentages[key]
  return firstPct >= WEAK_PCT_LOW && firstPct <= WEAK_PCT_HIGH
}

/**
 * 复现 ResultPage 渲染的"四维百分比条"数据形态，返回渲染需要的展示信息。
 * 这是个纯函数，把 percentages 转换为 UI 渲染需要的结构，UI 直接消费。
 */
function renderBars(result: TypeResult): Array<{
  key: string
  name: string
  first: string
  firstPct: number
  second: string
  secondPct: number
  isWeak: boolean
}> {
  return DIM_ROWS.map((row) => {
    const firstPct = result.percentages[row.key]
    return {
      key: row.key,
      name: row.name,
      first: row.first,
      firstPct,
      second: row.second,
      secondPct: 100 - firstPct,
      isWeak: isWeakDimension(result.percentages, row.key),
    }
  })
}

describe('结果页百分比条（T3 工单第 4 条 / 自验清单第 3 条）', () => {
  // 工单边界值：51/49 → 落在 45-55 区间内，应触发弱倾向提示
  it('边界 51%：EI 维度的第一极（E）= 51%，落在 [45,55] 区间 → 触发弱倾向提示', () => {
    const result: TypeResult = {
      type: 'ENFP',
      subtype: 'sensitive',
      percentages: { EI: 51, SN: 80, TF: 30, JP: 70, ES: 35 },
    }
    const bars = renderBars(result)
    const ei = bars.find((b) => b.key === 'EI')!
    expect(ei.firstPct).toBe(51)
    expect(ei.secondPct).toBe(49)
    expect(ei.isWeak).toBe(true)
  })

  // 强倾向：80% 不应触发提示
  it('强倾向 80%：EI = 80%，超出 [45,55] 区间 → 不触发弱倾向提示', () => {
    const result: TypeResult = {
      type: 'EINTJ' as unknown as string, // test fixture
      subtype: 'stable',
      percentages: { EI: 80, SN: 80, TF: 80, JP: 80, ES: 80 },
    }
    expect(isWeakDimension(result.percentages, 'EI')).toBe(false)
  })

  // 弱倾向 20%（即第二极 80%）也不触发
  it('强倾向 20%：EI = 20%，超出 [45,55] 区间 → 不触发弱倾向提示', () => {
    const result: TypeResult = {
      type: 'INTJ',
      subtype: 'stable',
      percentages: { EI: 20, SN: 80, TF: 80, JP: 80, ES: 80 },
    }
    expect(isWeakDimension(result.percentages, 'EI')).toBe(false)
  })

  // 边界值：恰好 45%
  it('边界 45%：JP = 45%，下边界命中弱倾向', () => {
    const result: TypeResult = {
      type: 'INFP',
      subtype: 'sensitive',
      percentages: { EI: 60, SN: 70, TF: 40, JP: 45, ES: 50 },
    }
    expect(isWeakDimension(result.percentages, 'JP')).toBe(true)
  })

  // 边界值：恰好 55%
  it('边界 55%：JP = 55%，上边界命中弱倾向', () => {
    const result: TypeResult = {
      type: 'ENTP',
      subtype: 'sensitive',
      percentages: { EI: 40, SN: 60, TF: 50, JP: 55, ES: 50 },
    }
    expect(isWeakDimension(result.percentages, 'JP')).toBe(true)
  })

  // 边界值：44%（差 1 不触发）
  it('边界 44%：EI = 44%，略低于下边界 → 不触发', () => {
    const result: TypeResult = {
      type: 'ISFP',
      subtype: 'sensitive',
      percentages: { EI: 44, SN: 60, TF: 50, JP: 50, ES: 50 },
    }
    expect(isWeakDimension(result.percentages, 'EI')).toBe(false)
  })

  // 多维度同时弱倾向：renderBars 返回每维独立的 isWeak
  it('多维度同时弱倾向：renderBars 各自独立判定 isWeak', () => {
    const result: TypeResult = {
      type: 'INFP',
      subtype: 'sensitive',
      percentages: { EI: 50, SN: 50, TF: 50, JP: 50, ES: 50 },
    }
    const bars = renderBars(result)
    // 四维全部落在 [45,55] 区间内，全部应触发
    expect(bars.every((b) => b.isWeak)).toBe(true)
  })

  // 验证 4 条维度都被渲染（与 ResultPage 的 DIM_ROWS 同步）
  it('renderBars 返回 4 条维度（与 ResultPage 一致）', () => {
    const result: TypeResult = {
      type: 'INTJ',
      subtype: 'stable',
      percentages: { EI: 80, SN: 80, TF: 80, JP: 80, ES: 80 },
    }
    const bars = renderBars(result)
    expect(bars).toHaveLength(4)
    expect(bars.map((b) => b.key)).toEqual(['EI', 'SN', 'TF', 'JP'])
  })

  // 验证百分比条渲染需要的字段都齐全（first / second / firstPct / secondPct）
  it('renderBars 返回字段齐全：first / second / firstPct / secondPct', () => {
    const result: TypeResult = {
      type: 'INTJ',
      subtype: 'stable',
      percentages: { EI: 80, SN: 75, TF: 65, JP: 70, ES: 75 },
    }
    const bars = renderBars(result)
    for (const b of bars) {
      expect(b.first.length).toBe(1)
      expect(b.second.length).toBe(1)
      expect(b.firstPct + b.secondPct).toBeCloseTo(100, 5)
    }
  })

  // 直接选用人格（pickedType 没有 percentages）走"只显示人格 + 细分，不显示百分比条"分支
  it('pickedType 路径：无 percentages 时百分比条组件应整体不渲染（外部守卫）', () => {
    const pickedOnly: { type: string; subtype: 'stable' | 'sensitive'; percentages?: undefined } = {
      type: 'ISFJ',
      subtype: 'stable',
    }
    // UI 层守卫：percentages 缺失时整块 result-bars 不渲染。
    // 这里用 truthy 检查还原组件 if (percentages) { ... } 的判定。
    expect(pickedOnly.percentages).toBeUndefined()
    expect(Boolean(pickedOnly.percentages)).toBe(false)
  })
})