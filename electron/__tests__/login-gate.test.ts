// 【文件说明】M4 P2-025 登录门禁主进程级回归测试（ISSUES P2-025 / owner 原话）：
//   "没登录肯定是不能显示桌宠的，不然没登录就显示那这只桌宠是谁的"
//
// 本工单要求启动分流必须按「profile 完整 + token 可用 + 是否访客」三态决定开哪个窗：
//   1. 无 token / 无 profile  → setup 登录页；
//   2. 有 token + 有 profile  → 直接进桌宠（自动登录）；
//   3. token 过期           → 清 token + 回登录页；
//   4. 访客模式             → 仅开主面板（无桌宠，访客没桌宠概念）。
//
// 本测试不启动真实 Electron，只断言两个纯函数：
//   - isJwtUsable()        : token 快筛（解析 exp，不验签）
//   - decideStartupWindow()：启动分流三态决策
//
// vitest 在 node 跑，main.ts 顶层副作用（app.requestSingleInstanceLock / app.whenReady）
// 会触发真实 electron 绑定；因此顶层必须 vi.mock('electron') 把整个模块替成 noop，
// 与已有 setup-window-quit.test.ts / main-menu.test.ts 的 mock 形态保持一致。
//
// 测试目的是"决策表钉死"——真实窗口链路（createPetWindow / createPanelWindow /
// createSetupWindow）由 electron/main.ts 与 scripts/repro-setup-complete.mjs 验证，
// 决策正确性由本测试覆盖。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// 屏蔽 electron：见文件头说明；mock 必须覆盖 main.ts 顶层副作用路径
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

import { decideStartupWindow, isJwtUsable } from '../main'

/** 构造一个 JWT 字符串（payload + 假签名，不做签名校验——isJwtUsable 不验签） */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake-signature-not-verified`
}

/** 现在 + N 秒 */
function expIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds
}

describe('M4 P2-025 登录门禁：isJwtUsable（启动期 token 快筛）', () => {
  it('【路径 1 / 4】token 为 null / undefined / 空串 → 不可用', () => {
    expect(isJwtUsable(null)).toBe(false)
    expect(isJwtUsable(undefined)).toBe(false)
    expect(isJwtUsable('')).toBe(false)
    expect(isJwtUsable('   ')).toBe(false)
  })

  it('非法 JWT 格式（不是三段）→ 不可用', () => {
    expect(isJwtUsable('not-a-jwt')).toBe(false)
    expect(isJwtUsable('a.b')).toBe(false)
    expect(isJwtUsable('a.b.c.d')).toBe(false)
    expect(isJwtUsable('header.body')).toBe(false)
  })

  it('payload 不是合法 JSON → 不可用（catch 兜底）', () => {
    // base64('not-json{')
    const badBody = Buffer.from('not-json{').toString('base64url')
    expect(isJwtUsable(`header.${badBody}.sig`)).toBe(false)
  })

  it('payload 缺 exp 字段 → 不可用', () => {
    const noExp = makeJwt({ sub: '1', email: 'x@y.com' })
    expect(isJwtUsable(noExp)).toBe(false)
  })

  it('payload exp 是字符串而非数字 → 不可用', () => {
    const badExp = makeJwt({ sub: '1', exp: '12345' })
    expect(isJwtUsable(badExp)).toBe(false)
  })

  it('【路径 3】token 已过期（exp < now）→ 不可用', () => {
    const expired = makeJwt({ sub: '1', exp: expIn(-100) })
    expect(isJwtUsable(expired)).toBe(false)
    // 边界：恰好过期（exp == now - 1ms）→ 不可用（> 严格大于）
    const justExpired = makeJwt({ sub: '1', exp: Math.floor(Date.now() / 1000) - 1 })
    expect(isJwtUsable(justExpired)).toBe(false)
  })

  it('【路径 2】token 未过期（exp > now）→ 可用', () => {
    const valid = makeJwt({ sub: '1', exp: expIn(3600) })
    expect(isJwtUsable(valid)).toBe(true)
    // 30 天有效期：模拟 M4 配置 jwtExpiresInSec = 60*60*24*30
    const thirtyDays = makeJwt({ sub: '1', exp: expIn(30 * 24 * 3600) })
    expect(isJwtUsable(thirtyDays)).toBe(true)
  })

  it('真实 server 签发的 JWT（HS256 + 30 天）→ 可用', () => {
    // 这个用例主要保护"用 mock token 测过的代码"也兼容真 server 签发路径。
    // 通过 isJwtUsable 不验签，所以这里用上面 makeJwt 模拟即可（签发/校验分离是设计选择）。
    const realLike = makeJwt({ sub: '1', email: 'a@b.com', iat: expIn(0), exp: expIn(30 * 86400) })
    expect(isJwtUsable(realLike)).toBe(true)
  })
})

describe('M4 P2-025 登录门禁：decideStartupWindow（启动分流三态）', () => {
  it('【路径 2】已登录：profile 完整 + token 可用 → pet', () => {
    expect(
      decideStartupWindow({ hasProfile: true, hasUsableToken: true, isGuest: false }),
    ).toBe('pet')
    // isGuest 不影响已登录态（防御性：双保险）
    expect(
      decideStartupWindow({ hasProfile: true, hasUsableToken: true, isGuest: true }),
    ).toBe('pet')
  })

  it('【路径 4】访客：profile 未初始化 + guest 标志 → panel（无 pet）', () => {
    expect(
      decideStartupWindow({ hasProfile: false, hasUsableToken: false, isGuest: true }),
    ).toBe('panel')
  })

  it('【路径 1】无 profile + 无 token + 无 guest → setup（首次启动）', () => {
    expect(
      decideStartupWindow({ hasProfile: false, hasUsableToken: false, isGuest: false }),
    ).toBe('setup')
  })

  it('【路径 3】profile 有 mbti 但 token 过期 → setup（保留 profile 引导重登）', () => {
    expect(
      decideStartupWindow({ hasProfile: true, hasUsableToken: false, isGuest: false }),
    ).toBe('setup')
  })

  it('token 有但 profile 未完整（半完成态）→ setup', () => {
    expect(
      decideStartupWindow({ hasProfile: false, hasUsableToken: true, isGuest: false }),
    ).toBe('setup')
  })

  it('profile 有但 token 过期 + 残留 guest 标志 → setup（防御：guest 不覆盖 profile 已写）', () => {
    expect(
      decideStartupWindow({ hasProfile: true, hasUsableToken: false, isGuest: true }),
    ).toBe('setup')
  })

  it('真值表完备：2×2×2 = 8 种组合里 pet/panel 各只 1 种', () => {
    // 当前决策表（按 hasProfile / hasUsableToken / isGuest 三个布尔位穷举）：
    //   pet   ：hasProfile && hasUsableToken           （× 2 因 isGuest 两态都不影响）
    //   panel ：!hasProfile && !hasUsableToken && isGuest （× 1）
    //   setup ：其余 5 种（详见下方注释）
    // 关键不变量：仅当"profile 已完整 + token 可用"才进 pet；仅当"全空 + guest"
    // 才进 panel；其它（半完成态 / profile 有 token 失效 等）一律 setup。
    const counts: Record<string, number> = { pet: 0, panel: 0, setup: 0 }
    for (const hasProfile of [false, true]) {
      for (const hasUsableToken of [false, true]) {
        for (const isGuest of [false, true]) {
          const d = decideStartupWindow({ hasProfile, hasUsableToken, isGuest })
          counts[d] += 1
        }
      }
    }
    expect(counts).toEqual({ pet: 2, panel: 1, setup: 5 })
  })
})

describe('M4 P2-025 登录门禁：storage 退出登录链路（保留 profile 字段）', () => {
  // storage.ts 依赖 electron.app.getPath('userData')，mock 已经把它返回空串；
  // 这里用 vi.spyOn 把 getPath 临时指向 tmp 子目录，避免污染真实用户档案。
  // 测试结束后再恢复 mock。
  let tmpDir = ''
  let electronMock: typeof import('electron') | undefined

  beforeEach(async () => {
    const electron = await import('electron')
    electronMock = electron
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    tmpDir = mkdtempSync(join(tmpdir(), 'petibi-logout-'))
    vi.spyOn(electronMock.app, 'getPath').mockReturnValue(tmpDir)
  })

  afterEach(async () => {
    const { rmSync } = await import('node:fs')
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /**
   * 退出登录语义：写 profile.json 时把 token 字段置 null，profile 字段保留。
   * 这条性质与 electron/main.ts 的 panel:logout IPC 处理逻辑一致——测试层面钉死它，
   * 防止后续重构误把 profile 一并清掉导致：
   *   1. 老用户重新登录时被当成新用户；
   *   2. /api/me/profile 409 误伤（profile 已写又被重写）；
   *   3. UX 落差（用户看到"自己的资料"消失会困惑）。
   */
  it('退出登录：writeProfile({token:null, profile:kept}) 后 readProfile 拿到 token=null 但 profile 不变', async () => {
    const { writeProfile, readProfile } = await import('../storage')
    const kept = {
      email: 'a@b.com',
      nickname: '蝴蝶',
      mbti: 'INFP' as const,
      subtype: 'sensitive' as const,
      createdAt: '2026-08-14T08:00:00.000Z',
    }
    await writeProfile({ token: 'old-token-abc', profile: kept })
    // 退出登录：清 token，profile 保留
    await writeProfile({ token: null, profile: kept })
    const next = await readProfile()
    expect(next.token).toBeNull()
    expect(next.profile).not.toBeNull()
    expect(next.profile?.email).toBe('a@b.com')
    expect(next.profile?.nickname).toBe('蝴蝶')
    expect(next.profile?.mbti).toBe('INFP')
    expect(next.profile?.subtype).toBe('sensitive')
    expect(next.profile?.createdAt).toBe('2026-08-14T08:00:00.000Z')
  })

  it('退出登录后 isJwtUsable(null) = false，下一次启动走 setup', async () => {
    const { writeProfile } = await import('../storage')
    await writeProfile({
      token: null,
      profile: {
        email: 'a@b.com',
        nickname: '蝴蝶',
        mbti: 'INFP',
        subtype: 'sensitive',
        createdAt: '2026-08-14T08:00:00.000Z',
      },
    })
    expect(isJwtUsable(null)).toBe(false)
    // decideStartupWindow 应当走 setup 分支（hasProfile=true 但 token 失效）
    expect(
      decideStartupWindow({ hasProfile: true, hasUsableToken: false, isGuest: false }),
    ).toBe('setup')
  })
})
