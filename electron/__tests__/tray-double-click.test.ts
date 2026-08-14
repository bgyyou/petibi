// 【文件说明】M4 收尾修复：托盘双击行为契约测试（owner 实测回归）。
//
// 背景：owner 实测要求"双击托盘图标 → 显示桌宠 + 打开主面板"。
// 收尾修复在 electron/main.ts createTray() 里新增 tray.on('double-click', ...)。
//
// 本测试不启动真实 Electron，也不调用 createTray()（会触发 nativeImage 读盘
// + Tray 实例化），改为静态断言：
//   1. main.ts 源码在 createTray 内必含 tray.on('double-click', ...) 订阅；
//   2. 该 handler 内必含 showPet() + showPanel() 两个调用；
//   3. 单击 handler tray.on('click', ...) 仍只调 showPet()（保留 M4 原行为）；
//   4. 单击 + 双击的 handler 都存在（防回归：删一个不影响另一个）。
//
// 真实链路（创建 Tray 实例 + 真实点击事件触发）由 scripts/repro-setup-complete.mjs
// 或 owner 实测覆盖；本测试只钉死"代码里写了什么"。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8')
}

describe('M4 收尾修复：托盘双击行为契约', () => {
  it('main.ts createTray() 必含 tray.on(\'double-click\', ...) 订阅', () => {
    const src = read('electron/main.ts')
    // 双击订阅必须存在
    expect(src).toMatch(/tray\.on\(\s*['"]double-click['"]/)
  })

  it('双击 handler 内必须同时调 showPet() + showPanel()', () => {
    const src = read('electron/main.ts')
    // 截取 createTray 函数体里双击 handler 那段
    // 简化：用宽松匹配——"tray.on('double-click'" 之后到下一个 tray.on 之前
    // 必须出现 showPet() + showPanel() 调用
    const m = /tray\.on\(\s*['"]double-click['"][^]*?(?=\n\s*tray\.on|\n\s*refreshTrayMenu|\n\s*\})/m.exec(src)
    expect(m).not.toBeNull()
    const handler = m?.[0] ?? ''
    expect(handler).toContain('showPet()')
    expect(handler).toContain('showPanel()')
  })

  it('单击 handler tray.on(\'click\', ...) 仍只调 showPet()（保留 M4 行为）', () => {
    const src = read('electron/main.ts')
    // 单击 handler 不能调 showPanel（避免单击就开面板，与"双击开面板"语义冲突）
    const m = /tray\.on\(\s*['"]click['"][^]*?(?=\n\s*tray\.on|\n\s*refreshTrayMenu|\n\s*\})/m.exec(src)
    expect(m).not.toBeNull()
    const handler = m?.[0] ?? ''
    expect(handler).toContain('showPet()')
    // 单击 handler 不调 showPanel
    expect(handler).not.toContain('showPanel()')
  })
})
