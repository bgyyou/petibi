// 【文件说明】计分链路联调测试（M2 工单自验清单第 2 条）：
//   - 加载真实题库 data/questions/questions.json；
//   - 构造极端答案（每维度极化）与平局答案；
//   - 调用 score() 出 TypeResult，与 vitest 已知答案对拍一致；
//   - 校验题库规模 = 40 题（PRD §3.3 允许 28-36+8）。
//
// 运行：`npx vitest run src/scoring/integration.test.ts`
import { describe, expect, it } from 'vitest'
import { questionBank } from './questions'
import { score } from './score'
import type { Answers, AnswerValue } from './types'

describe('题库加载', () => {
  it('数据契约 §1：dimensions 顺序为 EI/SN/TF/JP/ES', () => {
    expect(questionBank.dimensions).toEqual(['EI', 'SN', 'TF', 'JP', 'ES'])
  })

  it('题库规模 = 40 题（PRD §3.3）', () => {
    expect(questionBank.questions).toHaveLength(40)
  })

  it('每维度 8 题（与 PRD §3.3 题量约束一致）', () => {
    const counts: Record<string, number> = {}
    for (const q of questionBank.questions) {
      counts[q.dimension] = (counts[q.dimension] ?? 0) + 1
    }
    expect(counts).toEqual({ EI: 8, SN: 8, TF: 8, JP: 8, ES: 8 })
  })

  it('题号唯一且非空', () => {
    const ids = new Set(questionBank.questions.map((q) => q.id))
    expect(ids.size).toBe(questionBank.questions.length)
  })

  it('每题都有 source + source_ref 溯源字段（R6）', () => {
    for (const q of questionBank.questions) {
      expect(q.source).toBeTruthy()
      expect(q.source_ref).toBeTruthy()
    }
  })
})

/** 把 answers 全答 5，看每个维度第一极占比是否为 100% */
describe('极端答案', () => {
  it('所有题答 5 → 每个维度都恰好 50%（一半正向题 + 一半反向题同时拉满），均归第一极', () => {
    // 题库每个维度一半正向题、一半反向题；全答 5 时：
    //   - 正向题（direction=第一极）：scoreOne = 5-1 = 4
    //   - 反向题（direction=第二极）：scoreOne = 5-5 = 0
    // 所以第一极得分 = 4*4 = 16；max = 4*8 = 32 → 50%（命中 R5 平局边界，取第一极）
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      ans[q.id] = 5 as AnswerValue
    }
    const r = score(ans, questionBank)
    for (const dim of ['EI', 'SN', 'TF', 'JP', 'ES'] as const) {
      expect(r.percentages[dim]).toBe(50)
    }
    expect(r.type).toBe('ESTJ')
    expect(r.subtype).toBe('stable')
  })

  it('所有题答 1 → 同样 50%，全取第一极（R5 平局边界）', () => {
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      ans[q.id] = 1 as AnswerValue
    }
    const r = score(ans, questionBank)
    for (const dim of ['EI', 'SN', 'TF', 'JP', 'ES'] as const) {
      expect(r.percentages[dim]).toBe(50)
    }
    expect(r.type).toBe('ESTJ')
    expect(r.subtype).toBe('stable')
  })

  it('所有题答 3 → 同样 50%，R5 平局取第一极（与 score.test.ts neutralAnswers 用例一致）', () => {
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      ans[q.id] = 3 as AnswerValue
    }
    const r = score(ans, questionBank)
    expect(r.type).toBe('ESTJ')
    expect(r.subtype).toBe('stable')
  })
})

/** 按 direction 精准极化：第一极题答 5，反向题答 1 → 该维度 100% 第一极
 *  这才是 UI 链路联调里"全选第一极"该用的真实答案序列 */
describe('按 direction 精准极化（UI 链路联调）', () => {
  // 单维度第一极 100%：该维度正向题答 5、反向题答 1；其它维度反向极化（第一极 0%）
  function polarize(targetDim: 'EI' | 'SN' | 'TF' | 'JP' | 'ES'): Answers {
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      if (q.dimension === targetDim) {
        ans[q.id] = (q.direction === firstPoleOf(targetDim) ? 5 : 1) as AnswerValue
      } else {
        ans[q.id] = (q.direction === firstPoleOf(q.dimension as any) ? 1 : 5) as AnswerValue
      }
    }
    return ans
  }

  function firstPoleOf(dim: 'EI' | 'SN' | 'TF' | 'JP' | 'ES'): string {
    return { EI: 'E', SN: 'S', TF: 'T', JP: 'J', ES: 'stable' }[dim]
  }

  it('EI 极化 → EI 第一极 100%，其它四维度第一极 0%；type 第一字母取 E', () => {
    const r = score(polarize('EI'), questionBank)
    expect(r.percentages.EI).toBe(100)
    expect(r.percentages.SN).toBe(0)
    expect(r.percentages.TF).toBe(0)
    expect(r.percentages.JP).toBe(0)
    expect(r.percentages.ES).toBe(0)
    expect(r.type.startsWith('E')).toBe(true)
  })

  it('ES 极化 → ES 第一极 100%，subtype=stable', () => {
    const r = score(polarize('ES'), questionBank)
    expect(r.percentages.ES).toBe(100)
    expect(r.subtype).toBe('stable')
  })

  it('五维度全极化第一极 → ESTJ + stable（100%）', () => {
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      ans[q.id] = (q.direction === firstPoleOf(q.dimension as any) ? 5 : 1) as AnswerValue
    }
    const r = score(ans, questionBank)
    for (const dim of ['EI', 'SN', 'TF', 'JP', 'ES'] as const) {
      expect(r.percentages[dim]).toBe(100)
    }
    expect(r.type).toBe('ESTJ')
    expect(r.subtype).toBe('stable')
  })

  it('五维度全反向极化 → INFP + sensitive（0%）', () => {
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      ans[q.id] = (q.direction === firstPoleOf(q.dimension as any) ? 1 : 5) as AnswerValue
    }
    const r = score(ans, questionBank)
    for (const dim of ['EI', 'SN', 'TF', 'JP', 'ES'] as const) {
      expect(r.percentages[dim]).toBe(0)
    }
    expect(r.type).toBe('INFP')
    expect(r.subtype).toBe('sensitive')
  })
})

/** 16 型 + 2 细分各选一种代表性组合，验证对拍一致（R5 16 型可达性 + UI 链路） */
describe('16 型代表性组合（UI 链路联调对拍）', () => {
  // 用全极化构造：direction 与目标一致→5，反向→1（拉满第一极；其它维度同理可极化）
  function buildAnswers(target: {
    ei: 'E' | 'I'
    sn: 'S' | 'N'
    tf: 'T' | 'F'
    jp: 'J' | 'P'
    es: 'stable' | 'sensitive'
  }): Answers {
    const pole: Record<string, string> = {
      EI: target.ei,
      SN: target.sn,
      TF: target.tf,
      JP: target.jp,
      ES: target.es,
    }
    const ans: Answers = {}
    for (const q of questionBank.questions) {
      ans[q.id] = (q.direction === pole[q.dimension] ? 5 : 1) as AnswerValue
    }
    return ans
  }

  const cases: Array<{
    label: string
    target: {
      ei: 'E' | 'I'
      sn: 'S' | 'N'
      tf: 'T' | 'F'
      jp: 'J' | 'P'
      es: 'stable' | 'sensitive'
    }
    expectedType: string
    expectedSubtype: 'stable' | 'sensitive'
  }> = [
    { label: 'INTJ / stable',   target: { ei: 'I', sn: 'N', tf: 'T', jp: 'J', es: 'stable' },     expectedType: 'INTJ', expectedSubtype: 'stable' },
    { label: 'INTJ / sensitive', target: { ei: 'I', sn: 'N', tf: 'T', jp: 'J', es: 'sensitive' },  expectedType: 'INTJ', expectedSubtype: 'sensitive' },
    { label: 'ENFP / sensitive', target: { ei: 'E', sn: 'N', tf: 'F', jp: 'P', es: 'sensitive' },  expectedType: 'ENFP', expectedSubtype: 'sensitive' },
    { label: 'ISFJ / stable',    target: { ei: 'I', sn: 'S', tf: 'F', jp: 'J', es: 'stable' },     expectedType: 'ISFJ', expectedSubtype: 'stable' },
    { label: 'ESTP / stable',    target: { ei: 'E', sn: 'S', tf: 'T', jp: 'P', es: 'stable' },     expectedType: 'ESTP', expectedSubtype: 'stable' },
  ]

  for (const c of cases) {
    it(`${c.label}：UI 全极化 → score() 一致`, () => {
      const r = score(buildAnswers(c.target), questionBank)
      expect(r.type).toBe(c.expectedType)
      expect(r.subtype).toBe(c.expectedSubtype)
    })
  }
})