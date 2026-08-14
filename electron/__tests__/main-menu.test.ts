// 【文件说明】M4 工单：主进程右键菜单 / 托盘菜单结构回归测试。
//
// 背景：owner 实测反馈 P0-004 —— 右键菜单点了待机/眨眼/开心无反应，且有重复的"隐藏桌宠"项。
// M4 决策：右键菜单精简为三项（主面板 / 隐藏桌宠 / 退出），调试用的待机/眨眼/开心 radio
// 从菜单移除（仅保留键盘快捷键 1/2/3 供开发调试）。本测试钉死菜单结构：
//
//   1. 右键菜单 = 3 项 + 1 个 separator；
//   2. 没有任何 radio / type 之外的 type（如 'checkbox' / 'submenu'）；
//   3. "隐藏桌宠"项在 petHidden=true 时切换 label 为"显示桌宠"，并改派 onShowPet；
//   4. 托盘菜单 = 2 项 + 1 个 separator（与右键菜单对比，少了"主面板"）；
//   5. 不再出现"待机/眨眼/开心"调试残留字样；
//   6. 不再有重复的"隐藏桌宠"项。
//
// 由于 vitest 在 node 环境跑，本测试通过 vi.mock 屏蔽 electron 模块，只测
// buildPetContextMenuItems / buildTrayMenuItems 两个纯函数（main.ts 已将其抽出）。

import { describe, expect, it, vi } from 'vitest'

// 屏蔽 electron 模块：避免 main.ts 顶层 import 触发真实绑定（app / BrowserWindow 等）。
// 测试只关心 build* 纯函数的返回值，不关心 Menu.buildFromTemplate 实际执行。
// mock 必须覆盖 main.ts 顶层副作用路径（app.whenReady → createTray → registerIpc →
// createSetupWindow 触发）才不会让 BrowserWindow.on 不存在的报错干扰测试结果。
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

import {
  buildPetContextMenuItems,
  buildTrayMenuItems,
} from '../main'

/** 拿 item 的可点击 label 列表（去掉 separator） */
function labelsOf(
  items: ReadonlyArray<{ label?: string; type?: string }>,
): string[] {
  return items
    .filter((it): it is { label: string } => typeof it.label === 'string')
    .map((it) => it.label)
}

describe('桌宠右键菜单结构（M4 简化）', () => {
  it('菜单仅 3 项 + 1 个 separator：主面板 / 隐藏桌宠 / 退出', () => {
    const items = buildPetContextMenuItems({
      petHidden: false,
      onOpenPanel: () => undefined,
      onShowPet: () => undefined,
      onHidePet: () => undefined,
      onQuit: () => undefined,
    })
    // 总共 4 项：3 个 label + 1 个 separator
    expect(items).toHaveLength(4)
    // separator 在第 3 位（"主面板" / "隐藏桌宠" / separator / "退出"）
    expect(items[2]).toEqual({ type: 'separator' })
    // 标签顺序
    expect(labelsOf(items)).toEqual(['主面板', '隐藏桌宠', '退出'])
  })

  it('调试残留的"待机/眨眼/开心"必须全部不存在', () => {
    const items = buildPetContextMenuItems({
      petHidden: false,
      onOpenPanel: () => undefined,
      onShowPet: () => undefined,
      onHidePet: () => undefined,
      onQuit: () => undefined,
    })
    const allText = JSON.stringify(items)
    expect(allText).not.toContain('待机')
    expect(allText).not.toContain('眨眼')
    expect(allText).not.toContain('开心')
    expect(allText).not.toContain('idle')
    expect(allText).not.toContain('blink')
    expect(allText).not.toContain('happy')
  })

  it('不存在重复的"隐藏桌宠"项（owner 反馈 P0-004 已修）', () => {
    const items = buildPetContextMenuItems({
      petHidden: false,
      onOpenPanel: () => undefined,
      onShowPet: () => undefined,
      onHidePet: () => undefined,
      onQuit: () => undefined,
    })
    const counts = labelsOf(items).filter((l) => l === '隐藏桌宠').length
    expect(counts).toBe(1)
  })

  it('不存在 radio / checkbox / submenu 等调试控件', () => {
    const items = buildPetContextMenuItems({
      petHidden: false,
      onOpenPanel: () => undefined,
      onShowPet: () => undefined,
      onHidePet: () => undefined,
      onQuit: () => undefined,
    })
    for (const it of items) {
      // 仅允许 'label+click' 与 'separator' 两种形态
      if ('type' in it) {
        expect(it.type).toBe('separator')
      } else {
        expect(typeof it.label).toBe('string')
        expect(typeof it.click).toBe('function')
      }
    }
  })

  it('petHidden=false 时点击"隐藏桌宠"项 → 调 onHidePet', () => {
    const onShowPet = vi.fn()
    const onHidePet = vi.fn()
    const items = buildPetContextMenuItems({
      petHidden: false,
      onOpenPanel: () => undefined,
      onShowPet,
      onHidePet,
      onQuit: () => undefined,
    })
    const hideItem = items[1]
    if (!('click' in hideItem)) throw new Error('expected click item')
    hideItem.click()
    expect(onHidePet).toHaveBeenCalledTimes(1)
    expect(onShowPet).not.toHaveBeenCalled()
  })

  it('petHidden=true 时该项 label 切到"显示桌宠"，点击 → 调 onShowPet', () => {
    const onShowPet = vi.fn()
    const onHidePet = vi.fn()
    const items = buildPetContextMenuItems({
      petHidden: true,
      onOpenPanel: () => undefined,
      onShowPet,
      onHidePet,
      onQuit: () => undefined,
    })
    expect(labelsOf(items)).toEqual(['主面板', '显示桌宠', '退出'])
    const showItem = items[1]
    if (!('click' in showItem)) throw new Error('expected click item')
    showItem.click()
    expect(onShowPet).toHaveBeenCalledTimes(1)
    expect(onHidePet).not.toHaveBeenCalled()
  })

  it('"主面板"项始终存在，click 永远调 onOpenPanel（不随 petHidden 变化）', () => {
    for (const petHidden of [false, true]) {
      const onOpenPanel = vi.fn()
      const items = buildPetContextMenuItems({
        petHidden,
        onOpenPanel,
        onShowPet: () => undefined,
        onHidePet: () => undefined,
        onQuit: () => undefined,
      })
      const panelItem = items[0]
      if (!('click' in panelItem)) throw new Error('expected click item')
      panelItem.click()
      expect(onOpenPanel).toHaveBeenCalledTimes(1)
    }
  })
})

describe('托盘菜单结构（M4 与右键菜单对比）', () => {
  it('托盘 2 项 + 1 个 separator：显示桌宠（或隐藏桌宠） / 退出', () => {
    const items = buildTrayMenuItems({
      petHidden: false,
      onShowPet: () => undefined,
      onHidePet: () => undefined,
      onQuit: () => undefined,
    })
    expect(items).toHaveLength(3)
    expect(items[1]).toEqual({ type: 'separator' })
    expect(labelsOf(items)).toEqual(['隐藏桌宠', '退出'])
  })

  it('托盘没有"主面板"入口（与右键菜单的差异点）', () => {
    const items = buildTrayMenuItems({
      petHidden: false,
      onShowPet: () => undefined,
      onHidePet: () => undefined,
      onQuit: () => undefined,
    })
    expect(labelsOf(items)).not.toContain('主面板')
  })

  it('托盘"隐藏桌宠"项在 petHidden=true 时切到"显示桌宠"并改派 onShowPet', () => {
    const onShowPet = vi.fn()
    const onHidePet = vi.fn()
    const items = buildTrayMenuItems({
      petHidden: true,
      onShowPet,
      onHidePet,
      onQuit: () => undefined,
    })
    expect(labelsOf(items)).toEqual(['显示桌宠', '退出'])
    const showItem = items[0]
    if (!('click' in showItem)) throw new Error('expected click item')
    showItem.click()
    expect(onShowPet).toHaveBeenCalledTimes(1)
    expect(onHidePet).not.toHaveBeenCalled()
  })
})