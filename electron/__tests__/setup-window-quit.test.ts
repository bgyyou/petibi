// 【文件说明】P0-006 回归测试：setup 窗关闭时"该不该退出应用"的判定（shouldQuitOnSetupClosed）。
//
// 背景（owner 第三次复现）：结果页点「完成，去和我的桌宠玩」→ 整个应用退出。
// 前两轮修复都在渲染进程 reducer 层排查（FEEDBACK_RECORDED 不动 step 等），没打中真实触发点。
// 真实链路在主进程：
//   setup:complete → transitionSetupToPet() → setupWin.close()
//     → setup 窗 'closed' 回调看到 mode==='initial' → 认定"用户放弃初始化" → app.quit()
//
// 修复把判定收敛到纯函数 shouldQuitOnSetupClosed(ctx)，本测试钉死它的真值表：
//   - 过渡关闭（transitioningToPet=true）：任何 mode 都不退出；【本 bug 的核心】
//   - 用户手动关 initial 窗：退出（保留 M2 行为，避免后台挂无主窗）；
//   - 用户手动关 retest 窗：不退出（桌宠已在跑，只是取消重测）；
//   - 已在退出流程中（isShuttingDown=true）：不重复 quit。
//
// 真实 Electron 窗口链路（点完成 → setup 窗关 → 桌宠窗出现 → 进程存活）由
// scripts/repro-setup-complete.mjs 驱动真实进程验证，vitest 这层只钉死判定逻辑。

import { describe, expect, it, vi } from 'vitest'

// 屏蔽 electron 模块：main.ts 顶层 import 会触发真实绑定；这里只测导出的纯函数。
// mock 形态与 main-menu.test.ts 保持一致（同一份 main.ts 的顶层副作用路径）。
vi.mock('electron', () => ({
  BrowserWindow: class {
    on(): void {
      /* no-op */
    }
    isDestroyed(): boolean {
      return false
    }
    isVisible(): boolean {
      return true
    }
    isMinimized(): boolean {
      return false
    }
    loadURL(): void {
      /* no-op */
    }
    loadFile(): void {
      /* no-op */
    }
    show(): void {
      /* no-op */
    }
    hide(): void {
      /* no-op */
    }
    focus(): void {
      /* no-op */
    }
    minimize(): void {
      /* no-op */
    }
    restore(): void {
      /* no-op */
    }
    close(): void {
      /* no-op */
    }
    getPosition(): [number, number] {
      return [0, 0]
    }
    setPosition(): void {
      /* no-op */
    }
    webContents = {
      isDestroyed: () => false,
      send: () => undefined,
    }
  },
  Menu: {
    buildFromTemplate: (items: unknown[]) => ({ items }),
  },
  Tray: class {
    setToolTip(): void {
      /* no-op */
    }
    setContextMenu(): void {
      /* no-op */
    }
    on(): void {
      /* no-op */
    }
  },
  app: {
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    quit: () => undefined,
    requestSingleInstanceLock: () => true,
    getPath: () => '',
    isPackaged: false,
  },
  ipcMain: {
    on: () => undefined,
    handle: () => undefined,
  },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => true,
      resize: () => ({ setTemplateImage: () => undefined, isEmpty: () => true }),
    }),
    createEmpty: () => ({ isEmpty: () => true }),
  },
}))

import { shouldQuitOnSetupClosed } from '../main'

describe('P0-006：setup 窗关闭是否退出应用', () => {
  it('【核心】setup:complete 过渡关窗（initial）→ 绝不退出', () => {
    expect(
      shouldQuitOnSetupClosed({
        mode: 'initial',
        isShuttingDown: false,
        transitioningToPet: true,
      }),
    ).toBe(false)
  })

  it('访客模式过渡关窗（retest 语义外的第二条 transition 路径）→ 也不退出', () => {
    expect(
      shouldQuitOnSetupClosed({
        mode: 'retest',
        isShuttingDown: false,
        transitioningToPet: true,
      }),
    ).toBe(false)
  })

  it('用户手动关掉 initial 流程窗（放弃初始化）→ 退出（保留 M2 行为）', () => {
    expect(
      shouldQuitOnSetupClosed({
        mode: 'initial',
        isShuttingDown: false,
        transitioningToPet: false,
      }),
    ).toBe(true)
  })

  it('用户手动关掉 retest 窗（取消重测）→ 不退出，桌宠继续跑', () => {
    expect(
      shouldQuitOnSetupClosed({
        mode: 'retest',
        isShuttingDown: false,
        transitioningToPet: false,
      }),
    ).toBe(false)
  })

  it('已在退出流程中（托盘"退出" / before-quit）→ 不重复 quit', () => {
    for (const mode of ['initial', 'retest'] as const) {
      for (const transitioningToPet of [false, true]) {
        expect(
          shouldQuitOnSetupClosed({ mode, isShuttingDown: true, transitioningToPet }),
        ).toBe(false)
      }
    }
  })

  it('真值表完备：8 种组合里只有"initial + 非过渡 + 非退出中"为 true', () => {
    const trues: string[] = []
    for (const mode of ['initial', 'retest'] as const) {
      for (const isShuttingDown of [false, true]) {
        for (const transitioningToPet of [false, true]) {
          if (shouldQuitOnSetupClosed({ mode, isShuttingDown, transitioningToPet })) {
            trues.push(`${mode}/${isShuttingDown}/${transitioningToPet}`)
          }
        }
      }
    }
    expect(trues).toEqual(['initial/false/false'])
  })
})
