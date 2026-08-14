// 【文件说明】桌宠 sprite 路径拼接纯函数测试（M4 重测人格）。
//
// 验证 src/pet-sprite.ts 在重测完成 → 主进程广播 pet:sprite-change →
// 桌宠热切 sprite 路径场景下的契约：
//   - 16 型白名单校验：合法 mbti 返回小写形式，非法 mbti 回退 'intj'
//   - 路径前缀随 mbti 变化（避免硬编码 intj）
//   - 帧号越界时回退到第 0 帧（防御性）
//   - 帧表结构稳定（owner 决策：idle/happy 单帧，blink/thinking 双帧）

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_MBTI,
  MBTI_TYPE_RE,
  buildSpritePaths,
  sanitizeMbti,
  spritePath,
  type PetState,
} from '../pet-sprite'

describe('sanitizeMbti：mbti 校验 + 兜底', () => {
  it('16 型人格（大小写不敏感）全部合法 → 小写返回', () => {
    const all = [
      'INTJ', 'INTP', 'ENTJ', 'ENTP',
      'INFJ', 'INFP', 'ENFJ', 'ENFP',
      'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
      'ISTP', 'ISFP', 'ESTP', 'ESFP',
    ]
    for (const m of all) {
      expect(sanitizeMbti(m)).toBe(m.toLowerCase())
      expect(sanitizeMbti(m.toLowerCase())).toBe(m.toLowerCase())
    }
  })

  it('非法人格（含路径穿越/空串/null/undefined）→ 回退 FALLBACK_MBTI', () => {
    expect(sanitizeMbti('intj/../etc/passwd')).toBe(FALLBACK_MBTI)
    expect(sanitizeMbti('../../../')).toBe(FALLBACK_MBTI)
    expect(sanitizeMbti('XXXX')).toBe(FALLBACK_MBTI)
    expect(sanitizeMbti('')).toBe(FALLBACK_MBTI)
    expect(sanitizeMbti(null)).toBe(FALLBACK_MBTI)
    expect(sanitizeMbti(undefined)).toBe(FALLBACK_MBTI)
    expect(sanitizeMbti(123 as unknown as string)).toBe(FALLBACK_MBTI)
  })

  it('FALLBACK_MBTI 必须在白名单内（保证兜底后路径仍可拼）', () => {
    expect(MBTI_TYPE_RE.test(FALLBACK_MBTI)).toBe(true)
  })
})

describe('buildSpritePaths：动态 sprite 路径拼接', () => {
  it('每个合法 mbti 拼出对应的 sprites/<mbti>/<frame>.png 路径', () => {
    expect(buildSpritePaths('INTJ').idle[0]).toBe('sprites/intj/idle_0.png')
    expect(buildSpritePaths('ENFP').idle[0]).toBe('sprites/enfp/idle_0.png')
    expect(buildSpritePaths('ISTP').idle[0]).toBe('sprites/istp/idle_0.png')
  })

  it('非法 mbti → 回退到 intj 路径（防路径穿越）', () => {
    expect(buildSpritePaths('XXXX').idle[0]).toBe('sprites/intj/idle_0.png')
    expect(buildSpritePaths('').idle[0]).toBe('sprites/intj/idle_0.png')
    expect(buildSpritePaths('../../etc').idle[0]).toBe('sprites/intj/idle_0.png')
  })

  it('帧表结构稳定：idle/happy 单帧，blink/thinking 双帧', () => {
    const paths = buildSpritePaths('INTJ')
    expect(paths.idle).toHaveLength(1)
    expect(paths.happy).toHaveLength(1)
    expect(paths.blink).toHaveLength(2)
    expect(paths.thinking).toHaveLength(2)
  })

  it('M4 重测人格契约：mbti 改变时，路径前缀必须随之改变', () => {
    // 这是 owner 反馈的核心问题：原 App.tsx 硬编码 'intj'，重测后桌宠仍显示 INTJ
    const before = buildSpritePaths('INTJ').idle[0]
    const after = buildSpritePaths('ENFP').idle[0]
    expect(before).not.toBe(after)
    expect(before).toContain('intj')
    expect(after).toContain('enfp')
  })
})

describe('spritePath：单帧路径查询', () => {
  it('返回指定状态 + 帧号的相对路径', () => {
    expect(spritePath('INTJ', 'idle', 0)).toBe('sprites/intj/idle_0.png')
    expect(spritePath('INTJ', 'blink', 1)).toBe('sprites/intj/blink_1.png')
    expect(spritePath('ENFP', 'thinking', 1)).toBe('sprites/enfp/thinking_1.png')
  })

  it('帧号越界时回退到第 0 帧（防御性）', () => {
    // idle 只有 1 帧（frame=0），frame=5 应回退 0
    expect(spritePath('INTJ', 'idle', 5)).toBe('sprites/intj/idle_0.png')
    expect(spritePath('INTJ', 'idle', -1)).toBe('sprites/intj/idle_0.png')
    // blink 有 2 帧（0/1），frame=10 应回退 0
    expect(spritePath('INTJ', 'blink', 10)).toBe('sprites/intj/blink_0.png')
  })

  it('4 状态全 16 型遍历：每个 mbti × 每个状态都能产出路径', () => {
    const all = [
      'INTJ', 'INTP', 'ENTJ', 'ENTP',
      'INFJ', 'INFP', 'ENFJ', 'ENFP',
      'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
      'ISTP', 'ISFP', 'ESTP', 'ESFP',
    ]
    const states: PetState[] = ['idle', 'blink', 'happy', 'thinking']
    for (const m of all) {
      for (const s of states) {
        const path = spritePath(m, s, 0)
        expect(path).toMatch(new RegExp(`^sprites/${m.toLowerCase()}/`))
      }
    }
  })
})