// 【文件说明】M5 P1-D 修复：env 加载（主进程手写 .env 解析）单元测试。
//
// 覆盖：
//   1) parseDotenvManually 基本解析（KEY=VALUE / 注释 / 空行 / 双引号 / 单引号）
//   2) parseDotenvManually 不存在文件返回 null
//
// 跑法：npx vitest run electron/__tests__/env-loader.test.ts

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 屏蔽 electron：env-loader.test.ts 只用 parseDotenvManually（纯函数），但
// main.ts 顶层有 requestSingleInstanceLock / app.on / app.whenReady 等副作用，
// 必须全 mock 掉，否则 import 都跑不通。复用 login-gate.test.ts 的 mock 形态。
vi.mock('electron', () => ({
  BrowserWindow: class {
    on(): void { /* no-op */ }
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return true }
    isMinimized(): boolean { return false }
    loadURL(): void { /* no-op */ }
    loadFile(): void { /* no-op */ }
    show(): void { /* no-op */ }
    hide(): void { /* no-op */ }
    focus(): void { /* no-op */ }
    minimize(): void { /* no-op */ }
    restore(): void { /* no-op */ }
    close(): void { /* no-op */ }
    getPosition(): [number, number] { return [0, 0] }
    setPosition(): void { /* no-op */ }
    webContents = { isDestroyed: () => false, send: () => undefined }
  },
  Menu: { buildFromTemplate: (items: unknown[]) => ({ items }) },
  Tray: class {
    setToolTip(): void { /* no-op */ }
    setContextMenu(): void { /* no-op */ }
    on(): void { /* no-op */ }
  },
  app: {
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    quit: () => undefined,
    requestSingleInstanceLock: () => true,
    getPath: () => '',
    isPackaged: false,
  },
  ipcMain: { on: () => undefined, handle: () => undefined },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => true,
      resize: () => ({ setTemplateImage: () => undefined, isEmpty: () => true }),
    }),
    createEmpty: () => ({ isEmpty: () => true }),
  },
}))

import { parseDotenvManually } from '../main'

describe('M5 P1-D：parseDotenvManually（手写 .env 解析兜底）', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'petibi-env-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('基本 KEY=VALUE 解析', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(f, 'DEEPSEEK_API_KEY=sk-test-1234\nPETIBI_PORT=9000\n', 'utf-8')
    const r = parseDotenvManually(f)
    expect(r).toEqual({ DEEPSEEK_API_KEY: 'sk-test-1234', PETIBI_PORT: '9000' })
  })

  it('支持注释与空行', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(
      f,
      '# this is a comment\n\nDEEPSEEK_API_KEY=sk-real\n# another comment\n',
      'utf-8',
    )
    const r = parseDotenvManually(f)
    expect(r).toEqual({ DEEPSEEK_API_KEY: 'sk-real' })
  })

  it('支持双/单引号包裹', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(
      f,
      'A="value with spaces"\nB=\'single quoted\'\nC=unquoted\n',
      'utf-8',
    )
    const r = parseDotenvManually(f)
    expect(r).toEqual({ A: 'value with spaces', B: 'single quoted', C: 'unquoted' })
  })

  it('不存在文件返回 null', () => {
    const r = parseDotenvManually(join(tmpDir, 'no-such.env'))
    expect(r).toBeNull()
  })

  it('空文件返回空对象', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(f, '', 'utf-8')
    const r = parseDotenvManually(f)
    expect(r).toEqual({})
  })

  it('跳过非法行（无 = 号）', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(f, 'NOEQUALS\nKEY=value\n', 'utf-8')
    const r = parseDotenvManually(f)
    expect(r).toEqual({ KEY: 'value' })
  })

  it('key 与 value 自动 trim', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(f, '  KEY  =  value with surrounding spaces  \n', 'utf-8')
    const r = parseDotenvManually(f)
    expect(r?.KEY).toBe('value with surrounding spaces')
  })

  it('key 含等号也能正确切（只切第一个 =）', () => {
    const f = join(tmpDir, '.env')
    writeFileSync(f, 'URL=https://api.example.com?token=abc\n', 'utf-8')
    const r = parseDotenvManually(f)
    expect(r?.URL).toBe('https://api.example.com?token=abc')
  })
})