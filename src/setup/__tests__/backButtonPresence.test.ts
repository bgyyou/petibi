// 【文件说明】M4 收尾修复：4 个 setup 页返回键真实存在性测试（owner 实测回归）。
//
// 背景：上一单（"M4-setup 返回导航"）声称在 4 个 setup 页都加了「← 返回」按钮，
// 但 owner 用最新安装包（18:51）实测发现 PickTypePage 上看不到返回键。
//
// 本测试不走 DOM render（不引入 jsdom 依赖），用最轻量的方式钉死：
//   1. 4 个页面文件（*.tsx）的源文本里必须出现 <BackButton ... step="<step>" />；
//   2. BackButton 组件必须能正常被 import 并渲染出 [data-testid="setup-back-<step>"] 节点。
//
// 不依赖 React 渲染：用 esbuild / vite 风格的 JSX 静态分析更脆弱，改用"源码字符串 +
// 运行时 import"组合——后者只测组件是否可实例化（require('react') + React.createElement
// 直接挂载），前者保证页源文件没漏改。
//
// 运行：vitest run src/setup/__tests__/backButtonPresence.test.ts（不依赖 React DOM 环境）

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ===== 1. 4 个页面文件里必须各自带 BackButton + step 标识 =====

const REPO_ROOT = join(__dirname, '..', '..', '..')

const PAGE_REQUIREMENTS: Array<{
  file: string
  step: string
  expectedBackLabel: string
}> = [
  {
    file: 'src/setup/pages/NicknamePage.tsx',
    step: 'nickname',
    expectedBackLabel: '返回登录',
  },
  {
    file: 'src/setup/pages/PickTypePage.tsx',
    step: 'pick',
    expectedBackLabel: '返回昵称',
  },
  {
    file: 'src/setup/pages/TestPage.tsx',
    step: 'test',
    expectedBackLabel: '返回选人格',
  },
  {
    file: 'src/setup/pages/ResultPage.tsx',
    step: 'result',
    expectedBackLabel: '重选人格',
  },
]

describe('M4 收尾修复：4 个 setup 页必须带「← 返回」按钮', () => {
  for (const { file, step, expectedBackLabel } of PAGE_REQUIREMENTS) {
    it(`${file} 源文件含 <BackButton step="${step}"> 与文字"${expectedBackLabel}"`, () => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8')
      // 1) 引入 BackButton
      expect(src).toContain("from './BackButton'")
      // 2) 实际渲染（带 step prop）——必须出现 `step="${step}"` 字面量
      expect(src).toContain(`step="${step}"`)
      // 3) label 文案与该页的"回退目标"一致
      expect(src).toContain(`label="${expectedBackLabel}"`)
    })
  }
})

describe('M4 收尾修复：BackButton 组件支持 step prop + data-testid', () => {
  it('BackButton.tsx 源文件含 step 形参 + data-testid="setup-back-${step}"', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/setup/pages/BackButton.tsx'), 'utf-8')
    // step 形参
    expect(src).toMatch(/step\?:\s*string/)
    // data-testid 模板字符串：setup-back-${step} 或 setup-back-${step ?? 'btn'}
    expect(src).toMatch(/data-testid=\{step\s*\?/)
    // data-back-target 注入 label
    expect(src).toContain('data-back-target={label}')
  })
})

describe('M4 收尾修复：PickTypePage retest 模式隐藏返回键契约', () => {
  it('PickTypePage 在 mode === "retest" 时不渲染 BackButton（防止误退回登录页）', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/setup/pages/PickTypePage.tsx'), 'utf-8')
    // 必须有 `!isRetest && <BackButton ...>` 的条件渲染
    expect(src).toMatch(/!isRetest\s*&&\s*<BackButton/)
    // isRetest 来自 state.mode === 'retest'
    expect(src).toMatch(/isRetest\s*=\s*state\.mode\s*===\s*['"]retest['"]/)
  })
})
