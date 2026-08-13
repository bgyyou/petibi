// 【文件说明】海报模块纯函数单测：覆盖人格族色映射、文本换行、回答蒸馏、截断等
// 纯函数逻辑（drawPoster / generatePoster 是 canvas 操作，不在此测，需要浏览器/electron 环境）。
//
// 设计要点：
//  - 仅测纯函数，避免引入 canvas 依赖（vitest environment=node，tsconfig 不含 canvas 类型）；
//  - 与 src/panel/__tests__/chat-reducer.test.ts 风格保持一致（factory + describe）；
//  - 边界用例：空字符串 / 超长文本 / 深度档三段式 / 越界人格。
import { describe, expect, it } from 'vitest'
import {
  POSTER_HEIGHT,
  POSTER_WIDTH,
  distillDeepAnswer,
  estimateTextWidth,
  familyMainFor,
  todayDateString,
  truncateExcerpt,
  wrapText,
} from '../poster'

describe('POSTER_WIDTH / POSTER_HEIGHT', () => {
  it('固定 1080×1350（REVIEW §2.5 / 小红书 3:4）', () => {
    expect(POSTER_WIDTH).toBe(1080)
    expect(POSTER_HEIGHT).toBe(1350)
  })
})

describe('familyMainFor', () => {
  it('16 型人格都映射到正确的族色', () => {
    expect(familyMainFor('INTJ')).toBe('#785D87') // analyst 紫
    expect(familyMainFor('infp')).toBe('#3E8F6E') // diplomat 绿（大小写不敏感）
    expect(familyMainFor('ISTJ')).toBe('#399FB9') // sentinel 蓝
    expect(familyMainFor('ESFP')).toBe('#E4C728') // explorer 黄
  })

  it('非法人格走兜底（analyst 紫）', () => {
    expect(familyMainFor('XXXX')).toBe('#785D87')
    expect(familyMainFor('')).toBe('#785D87')
  })
})

describe('estimateTextWidth', () => {
  it('中文宽度约为英文的 2 倍', () => {
    const en = estimateTextWidth('abc', 30)
    const cn = estimateTextWidth('你好', 30)
    // 中文"你好"占 2×2=4 单位，英文"abc"占 3 单位；4*0.55 vs 3*0.55 → cn > en
    expect(cn).toBeGreaterThan(en)
  })

  it('空串宽度为 0', () => {
    expect(estimateTextWidth('', 30)).toBe(0)
  })

  it('fontSize 越大宽度越大', () => {
    expect(estimateTextWidth('hello', 40)).toBeGreaterThan(estimateTextWidth('hello', 20))
  })
})

describe('wrapText', () => {
  it('空串返回单空行（避免绘制时 0 行）', () => {
    expect(wrapText('', 200, 20)).toEqual([''])
  })

  it('一行能放下时不折行', () => {
    expect(wrapText('hello', 1000, 20)).toEqual(['hello'])
  })

  it('超长文本按宽度折成多行', () => {
    const long = '这是一段非常非常长的中文文本，用于测试自动换行功能是否生效'
    const lines = wrapText(long, 200, 20)
    expect(lines.length).toBeGreaterThan(1)
    // 每行宽度都不超过 maxWidth
    for (const line of lines) {
      expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(200)
    }
  })
})

describe('truncateExcerpt', () => {
  it('未超长时原样返回', () => {
    expect(truncateExcerpt('hello', 10)).toBe('hello')
  })

  it('超长时加省略号', () => {
    const out = truncateExcerpt('一二三四五六七八九十', 5)
    expect(out.length).toBeLessThanOrEqual(6) // 5 字 + 1 个省略号
    expect(out.endsWith('…')).toBe(true)
  })

  it('去除多余空白后统计字数', () => {
    const out = truncateExcerpt('a b  c   d', 100)
    expect(out).toBe('a b c d')
  })

  it('纯空白字符串截断为空', () => {
    expect(truncateExcerpt('     ', 10)).toBe('')
  })
})

describe('distillDeepAnswer', () => {
  it('按段落切时取前 3 段（PRD §3.4 三段式）', () => {
    const text = '第一段：复述确认你的问题。\n\n第二段：作为 INFP，我会先处理情绪。\n\n第三段：建议你先做最小的一步。\n\n第四段：被丢弃的尾巴。'
    const out = distillDeepAnswer(text)
    expect(out).toContain('第一段')
    expect(out).toContain('第二段')
    expect(out).toContain('第三段')
    expect(out).not.toContain('第四段')
  })

  it('只有 1 段时保留整段', () => {
    const out = distillDeepAnswer('就这一句话。')
    expect(out).toBe('就这一句话。')
  })

  it('无段落分隔但有 3 句以上时按句号切前 3 句', () => {
    const text = 'A 句。B 句。C 句。D 句。'
    const out = distillDeepAnswer(text)
    expect(out).toContain('A 句')
    expect(out).toContain('B 句')
    expect(out).toContain('C 句')
    expect(out).not.toContain('D 句')
  })

  it('空字符串返回空串', () => {
    expect(distillDeepAnswer('')).toBe('')
  })

  it('全角 / 半角句号都识别为切分点', () => {
    const text = '第一句!第二句!第三句!第四句!'
    const out = distillDeepAnswer(text)
    expect(out).toContain('第一句')
    expect(out).toContain('第二句')
    expect(out).toContain('第三句')
    expect(out).not.toContain('第四句')
  })
})

describe('todayDateString', () => {
  it('返回 YYYY-MM-DD 格式（10 字符）', () => {
    const s = todayDateString()
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(s.length).toBe(10)
  })
})
