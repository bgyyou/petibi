// 【文件说明】M4 收尾修复：TitleBar 组件回调链契约测试（owner 实测回归）。
//
// 背景：owner 实测反馈"自绘标题栏的最小化按钮点击无反应"。根因排查后
// 收尾修复把 TitleBar 拆成显式 onMinimize / onClose props：
//   - 调用方（setup/App.tsx / panel/App.tsx）显式注入回调；
//   - 移除运行时类型断言 + 字符串比较 document.title 的脆弱链路。
//
// 本测试不渲染 React（vitest 在 node 环境跑，无 jsdom），改为：
//   1. 静态分析 TitleBar.tsx 源码：必须含 onMinimize / onClose props 形参、
//      必含 -webkit-app-region: no-drag / mousedown stopPropagation 的修复标记；
//   2. 静态分析 setup/App.tsx：必须把 window.petApi.minimizeSetup 注入 onMinimize；
//   3. 静态分析 panel/App.tsx：必须把 window.petApi.minimizePanel 注入 onMinimize，
//      把 window.panelApi.hidePanel 注入 onClose。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8')
}

describe('M4 收尾修复：TitleBar 组件契约', () => {
  it('TitleBar.tsx 含 onMinimize / onClose props 形参与 onClick 注入', () => {
    const src = read('src/components/TitleBar.tsx')
    // props 形参
    expect(src).toMatch(/onMinimize\?:\s*\(\)\s*=>\s*void/)
    expect(src).toMatch(/onClose\?:\s*\(\)\s*=>\s*void/)
    // 按钮 onClick 绑定到 props
    expect(src).toMatch(/onClick=\{onMinimize\}/)
    expect(src).toMatch(/onClick=\{onClose\}/)
    // 不再依赖运行时 document.title 比较（移除脆弱链路）
    expect(src).not.toMatch(/document\.title\s*===\s*['"]Petibi['"]/)
  })

  it('TitleBar 按钮含 stopPropagation mousedown 防御（吞父级 drag 区域事件）', () => {
    const src = read('src/components/TitleBar.tsx')
    expect(src).toMatch(/onMouseDown=\{swallowDragArea\}/)
    expect(src).toMatch(/e\.stopPropagation\(\)/)
  })

  it('TitleBar 按钮含 data-testid 便于 owner / E2E 验收', () => {
    const src = read('src/components/TitleBar.tsx')
    expect(src).toContain('data-testid="titlebar-minimize-btn"')
    expect(src).toContain('data-testid="titlebar-close-btn"')
  })
})

describe('M4 收尾修复：setup App 注入 IPC 回调', () => {
  it('setup/App.tsx 显式调用 petApi.minimizeSetup 作为 onMinimize', () => {
    const src = read('src/setup/App.tsx')
    expect(src).toContain('onMinimize={() => window.petApi?.minimizeSetup?.()}')
    expect(src).toContain('onClose={() => window.petApi?.cancelSetup?.()}')
  })
})

describe('M4 收尾修复：panel App 注入 IPC 回调', () => {
  it('panel/App.tsx 显式调用 petApi.minimizePanel 作为 onMinimize、panelApi.hidePanel 作为 onClose', () => {
    const src = read('src/panel/App.tsx')
    expect(src).toContain('onMinimize={() => window.petApi?.minimizePanel?.()}')
    expect(src).toContain('onClose={() => window.panelApi?.hidePanel?.()}')
  })
})

describe('M4 收尾修复：titlebar.css 按钮层 no-drag 防御', () => {
  it('titlebar.css 在 .petibi-titlebar-btn 上声明 -webkit-app-region: no-drag', () => {
    const src = read('src/styles/titlebar.css')
    // 必须出现 no-drag 声明
    expect(src).toMatch(/-webkit-app-region:\s*no-drag/)
    expect(src).toMatch(/app-region:\s*no-drag/)
  })
})
