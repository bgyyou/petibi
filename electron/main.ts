// 【文件说明】Petibi 主进程（M3 桌宠交互层重构 + M4 海报分享补 portrait IPC）：
//   1. 启动时根据 userData/profile.json 是否含 mbti 决定先开 setup 窗还是 pet 窗；
//   2. 同时创建系统托盘（tray），托盘在 setup 阶段也已驻留，方便用户随时退出；
//   3. 提供 IPC：拖拽（M1 沿用）/ 桌宠右键菜单（含"隐藏桌宠",M3 新增）/ profile 读写（M2 沿用）/
//      单击桌宠打开面板（M3 新增）/ 面板隐藏（M3 新增）/
//      portrait 读取（M4 海报生成：把 assets/art/portraits/<type>.png 转成 data URL 返回渲染进程）；
//   4. 桌宠窗和面板窗"关闭"按钮都只隐藏不销毁，进程不退出；托盘"退出"菜单才真正 quit；
//   5. setup 窗关闭（取消）依旧 quit（避免后台挂窗口）。
//
// 桌宠窗属性完全保留 M1 已验收的 128×128 透明无边框悬浮窗配置；
// setup 窗为正常应用窗口（不透明、有边框、出现在任务栏），适合做邮箱登录 + 测试长流程；
// panel 窗为 400×600 正常应用窗口，居中显示。
import { join } from 'path'
import { readFileSync } from 'fs'
import * as fsp from 'fs/promises'
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  ipcMain,
  nativeImage,
} from 'electron'
import { readProfile, writeProfile, type StoredProfile } from './storage'

// electron-vite 在 dev 模式下注入的渲染进程 dev-server 地址；打包后该变量为空
const devUrl = process.env['ELECTRON_RENDERER_URL']

// 桌宠 + setup + panel 三个窗口的引用；同一时刻 pet / setup 二选一，panel 按需展示
let petWin: BrowserWindow | null = null
let setupWin: BrowserWindow | null = null
let panelWin: BrowserWindow | null = null
let tray: Tray | null = null

// 桌宠是否被"隐藏"（点托盘"隐藏桌宠"后），用于菜单项勾选与状态回告
let petHidden = false

// 当前动画状态，仅用于右键菜单的单选勾选显示；真实播放状态在渲染进程维护
let currentState: 'idle' | 'blink' | 'happy' = 'idle'

// 用户是否主动退出（与 window-all-closed 配合判断是否真退出）
let isShuttingDown = false

// 资源目录：tray 图标复用一张 sprite（32×32，运行时系统托盘会自动缩放）
const RESOURCES_DIR = join(__dirname, '../../resources')

/**
 * 创建桌宠悬浮窗。
 * 关键属性（沿用 M1 工单 / 红线 R2）：
 *   transparent 透明背景、alwaysableOnTop 置顶、resizable:false 固定 128×128、
 *   skipTaskbar 不进任务栏、hasShadow:false 避免阴影残边、backgroundThrottling:false 防止节流到 1Hz。
 *
 * 关闭按钮行为：仅 hide（保留窗口对象），进程不退出，托盘常驻。
 */
function createPetWindow(): void {
  petWin = new BrowserWindow({
    width: 128,
    height: 128,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      // 预加载脚本：以 contextBridge 暴露最小 API，渲染进程不直接持有 Node 能力
      preload: join(__dirname, '../preload/preload.js'),
      // 桌宠窗常年无焦点/被遮挡，必须关掉后台节流（否则 8fps 变 1fps）
      backgroundThrottling: false,
      // 让 preload 通过 additionalArguments 识别当前窗口角色
      additionalArguments: ['--petibi-role=pet'],
    },
  })

  // 关闭按钮 = 隐藏（保留 BrowserWindow 实例便于下次唤回）
  petWin.on('close', (e) => {
    if (isShuttingDown) return
    e.preventDefault()
    petHidden = true
    petWin?.hide()
    petWin?.webContents.send('pet:visibility', true)
    refreshTrayMenu()
  })

  if (devUrl) {
    petWin.loadURL(devUrl)
  } else {
    petWin.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 创建初始化流程窗（login → nickname → pickType → test → result）。
 * 与 pet 窗的关键差异：
 *   - 正常应用窗口（不透明 / 有边框 / 进任务栏），让用户能正常最小化、移动；
 *   - 不置顶，让桌宠在桌面正常显示；
 *   - 用 query 串区分入口（setup.html?role=setup），渲染进程据此加载 setup/App。
 *
 * 关闭行为：保留 M2 行为——放弃初始化即退出 app（避免后台挂个无主窗）。
 */
function createSetupWindow(): void {
  setupWin = new BrowserWindow({
    width: 800,
    height: 640,
    // 普通应用窗口，避免被误判为系统工具窗口
    frame: true,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    // 让用户能从任务栏找回正在进行的初始化流程
    skipTaskbar: false,
    // 居中显示，避免初次启动位置奇怪
    center: true,
    title: 'Petibi 初始化',
    backgroundColor: '#fafaf7',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      additionalArguments: ['--petibi-role=setup'],
    },
  })

  setupWin.on('closed', () => {
    setupWin = null
    // setup 窗被关掉视为放弃初始化 → 直接退出 app（避免后台挂个窗口）
    if (!isShuttingDown) {
      isShuttingDown = true
      app.quit()
    }
  })

  if (devUrl) {
    setupWin.loadURL(`${devUrl}setup/index.html`)
  } else {
    setupWin.loadFile(join(__dirname, '../renderer/setup/index.html'))
  }
}

/**
 * 创建主面板窗（对话 / 百科 / 社区 / 我的 四个 Tab）。
 *
 * 关键差异：
 *   - 400×600 正常应用窗口，有边框、可缩放，进任务栏；
 *   - 关闭按钮只 hide（保留窗口对象），下次单击桌宠快速唤回；
 *   - 懒加载：首次单击桌宠时再创建（缩短冷启动时间）。
 */
function createPanelWindow(): BrowserWindow {
  if (panelWin && !panelWin.isDestroyed()) {
    return panelWin
  }
  panelWin = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 360,
    minHeight: 480,
    // 正常应用窗口：边框、任务栏图标都保留
    frame: true,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    skipTaskbar: false,
    center: true,
    title: 'Petibi',
    backgroundColor: '#fafaf7',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      additionalArguments: ['--petibi-role=panel'],
    },
  })

  // 关闭按钮 = 隐藏，保留 BrowserWindow 便于下次快速唤回
  panelWin.on('close', (e) => {
    if (isShuttingDown) return
    e.preventDefault()
    panelWin?.hide()
  })

  if (devUrl) {
    panelWin.loadURL(`${devUrl}panel/index.html`)
  } else {
    panelWin.loadFile(join(__dirname, '../renderer/panel/index.html'))
  }
  return panelWin
}

/**
 * 显示主面板：懒加载 + focus + 解屏。
 * 单击桌宠触发，确保用户在桌面随手点开就能看到对话。
 */
function showPanel(): void {
  const win = createPanelWindow()
  if (!win.isVisible()) win.show()
  win.focus()
  // 通知 panel 渲染进程：可能需要刷新（配额、本地档案等）
  win.webContents.send('panel:shown')
}

/**
 * M4 快捷菜单"跟我对话"：先 ensure panel 窗，再发切 Tab 信号给 panel 渲染进程。
 * 之所以用独立 IPC 通道（panel:switch-to-chat）而非复用 panel:shown，
 * 是因为"跟我对话"应当强制切到对话 Tab，而"主面板"是让用户停留在当前 Tab。
 */
function showPanelSwitchTo(target: 'chat' | 'baike' | 'community' | 'profile'): void {
  const win = createPanelWindow()
  if (!win.isVisible()) win.show()
  win.focus()
  win.webContents.send('panel:shown')
  win.webContents.send('panel:switch-to-chat')
  // 当前实现下 target 仅作记录（panel 渲染端按 'chat' 处理；后续工单可扩展）
  void target
}

/** 关闭 setup 窗并启动 pet 窗（仅在两个窗同时存在的极短过渡期内顺序执行） */
function transitionSetupToPet(): void {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.close()
  }
  setupWin = null
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow()
  }
}

/**
 * 创建系统托盘：菜单含"显示桌宠 / 隐藏桌宠 / 退出"。
 * 点托盘图标默认唤回桌宠（与 Windows 用户习惯一致）。
 */
function createTray(): void {
  if (tray) return
  // 复用 32×32 sprite 作为托盘图标；缺资源时退化为空图标（不报错）
  const iconPath = join(RESOURCES_DIR, 'sprites/intj/idle_0.png')
  const image = nativeImage.createFromPath(iconPath)
  const icon = image.isEmpty() ? nativeImage.createEmpty() : image
  tray = new Tray(icon)
  tray.setToolTip('Petibi 桌宠')
  tray.on('click', () => {
    // 单击托盘图标：显示桌宠（如已隐藏则唤回）
    showPet()
  })
  refreshTrayMenu()
}

/** 重建托盘菜单项：显示/隐藏桌宠按 petHidden 切换 label 和 enabled */
function refreshTrayMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: petHidden ? '显示桌宠' : '隐藏桌宠',
      click: () => (petHidden ? showPet() : hidePet()),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isShuttingDown = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

/** 显示桌宠：从隐藏态恢复（保留 BrowserWindow 实例） */
function showPet(): void {
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow()
  } else if (!petWin.isVisible()) {
    petWin.show()
  }
  petHidden = false
  petWin?.webContents.send('pet:visibility', false)
  refreshTrayMenu()
}

/** 隐藏桌宠：仅 hide，托盘保留；右键菜单与托盘菜单都可触发 */
function hidePet(): void {
  if (!petWin || petWin.isDestroyed()) return
  petHidden = true
  petWin.hide()
  petWin.webContents.send('pet:visibility', true)
  refreshTrayMenu()
}

/** 注册 IPC：拖拽位移 + 右键状态菜单 + 桌宠状态回告（M1）+ profile 读写 + setup 完成（M2）+ 面板与隐藏（M3） */
function registerIpc(): void {
  // ===== M1 沿用 =====
  ipcMain.on('pet:drag', (_event, dx: number, dy: number) => {
    if (!petWin) return
    const [x, y] = petWin.getPosition()
    petWin.setPosition(Math.round(x + dx), Math.round(y + dy))
  })

  ipcMain.on('pet:state-changed', (_event, state: 'idle' | 'blink' | 'happy') => {
    currentState = state
  })

  ipcMain.on('pet:menu', () => {
    if (!petWin) return
    const states: Array<{ id: 'idle' | 'blink' | 'happy'; label: string }> = [
      { id: 'idle', label: '待机 idle' },
      { id: 'blink', label: '眨眼 blink' },
      { id: 'happy', label: '开心 happy' },
    ]
    const menu = Menu.buildFromTemplate([
      ...states.map((s) => ({
        label: s.label,
        type: 'radio' as const,
        checked: currentState === s.id,
        click: () => {
          currentState = s.id
          petWin?.webContents.send('pet:set-state', s.id)
        },
      })),
      { type: 'separator' },
      {
        label: petHidden ? '显示桌宠' : '隐藏桌宠',
        click: () => (petHidden ? showPet() : hidePet()),
      },
    ])
    menu.popup({ window: petWin })
  })

  // ===== M2 新增 =====

  // 渲染进程（任意窗口）读档案；不存在时返回 token=null, profile=null
  ipcMain.handle('profile:get', async (): Promise<StoredProfile> => {
    return readProfile()
  })

  // 渲染进程写档案；写入成功后主进程自行决定是否切换窗口
  ipcMain.handle(
    'profile:set',
    async (_event, next: StoredProfile): Promise<{ ok: true }> => {
      await writeProfile(next)
      return { ok: true }
    }
  )

  // setup 流程结束 → 主进程关 setup、开 pet
  ipcMain.on('setup:complete', () => {
    transitionSetupToPet()
  })

  // M4 工单 A3 访客模式：用户在 LoginPage 点"先逛逛" → 写 guest 标志 → 关 setup、开 pet
  ipcMain.on('setup:enter-guest', async () => {
    try {
      await writeGuestFlag(true)
    } catch (err) {
      console.warn('[main] 写入 guest 标志失败：', err)
    }
    transitionSetupToPet()
  })

  // 调试用：渲染进程请求退出 setup（保留接口，方便后续扩展）
  ipcMain.on('setup:cancel', () => {
    isShuttingDown = true
    app.quit()
  })

  // ===== M3 桌宠交互层新增 =====

  // 桌宠单击（位移 <5px） → 打开主面板（保留旧接口：兼容未升级的渲染端）
  ipcMain.on('pet:open-panel', () => {
    showPanel()
  })

  // 桌宠"隐藏桌宠"右键项 → 隐藏 pet 窗
  ipcMain.on('pet:hide', () => {
    hidePet()
  })

  // ===== M4 快捷菜单 A4：桌宠单击改为弹气泡菜单，点选项各自通知主进程 =====

  // "跟我对话" → 打开主面板 + 让 panel 切到对话 Tab
  ipcMain.on('pet:quick-chat', () => {
    showPanelSwitchTo('chat')
  })

  // "主面板" → 只打开主面板（停留在当前 Tab，让用户自己切）
  ipcMain.on('pet:quick-panel', () => {
    showPanel()
  })

  // panel 启动期读取本地 profile（panel 渲染进程第一件事）
  ipcMain.handle('panel:get-init', async () => {
    const stored = await readProfile()
    return { profile: stored.profile, token: stored.token }
  })

  // panel 关闭按钮 → 隐藏 panel 窗（不销毁）
  ipcMain.on('panel:hide', () => {
    panelWin?.hide()
  })

  // M4 工单 A3：访客模式锁定遮罩里"去登录"按钮 → 主进程关 panel、拉起 setup 窗
  ipcMain.on('panel:open-setup', () => {
    // panel 窗先 hide（不销毁），让 setup 窗成为前台焦点
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.hide()
    }
    if (!setupWin || setupWin.isDestroyed()) {
      createSetupWindow()
    } else {
      setupWin.show()
      setupWin.focus()
    }
  })

  // ===== M4 海报分享新增 =====
  /**
   * 读取人格形象图（assets/art/portraits/<type>.png）并转成 data URL 返回渲染进程。
   * 设计要点：
   *  - portrait 是闭源美术资产，放在 assets/ 而非 resources/，不打包进渲染进程的 publicDir；
   *  - 因此渲染进程不能直接用相对 URL 加载，必须经主进程读取后以 base64 data URL 返回；
   *  - 只允许 16 型人格白名单内的 type，防止路径穿越读仓库外的文件；
   *  - 文件不存在时返回 null（UI 走兜底分支：跳过形象图，正常生成海报）。
   */
  ipcMain.handle('portrait:read', async (_event, type: string): Promise<string | null> => {
    if (!MBTI_TYPE_RE.test(type)) return null
    // process.cwd() 在 dev 是仓库根，prod 是 resources/ 的兄弟目录 out/，两种都需要向上找仓库根
    const portraitPath = join(process.cwd(), 'assets', 'art', 'portraits', `${type.toLowerCase()}.png`)
    try {
      const buf = readFileSync(portraitPath)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // ===== M4 整合体验 A1：百科 IPC（data/encyclopedia/<type>.json） =====
  /**
   * 读取某一人格的百科全文条目（结构化 JSON：{ personality, animal, family, entries[] }）。
   * 设计要点：
   *  - 百科数据是产品核心数据资产（PRD §3.6 / RAG 检索源），但放在 data/ 而非 resources/，
   *    渲染进程无法直接 fetch，必须经主进程读取 JSON 字符串返回；
   *  - 白名单限定 16 型人格，防止路径穿越；
   *  - 文件不存在时返回 null（UI 走兜底：列表展示完整，文案"暂无该人格百科"）；
   *  - 同步读取：条目平均 ~12KB，IO < 1ms，不走异步。
   */
  ipcMain.handle(
    'encyclopedia:read',
    async (_event, type: string): Promise<unknown | null> => {
      if (!MBTI_TYPE_RE.test(type)) return null
      const filePath = join(process.cwd(), 'data', 'encyclopedia', `${type.toLowerCase()}.json`)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        return JSON.parse(raw)
      } catch {
        return null
      }
    },
  )

  /**
   * 读取百科 index.json（16 人格 → 文件名 + 族色 + 动物）。
   * 与 data/encyclopedia/<type>.json 是 1:N 关系；index 体积小（<3KB），一次读全。
   */
  ipcMain.handle('encyclopedia:index', async (): Promise<unknown | null> => {
    const filePath = join(process.cwd(), 'data', 'encyclopedia', 'index.json')
    try {
      const raw = readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  })

  /**
   * 访客模式标志写入（M4 工单 A3）：渲染进程（LoginPage 点"先逛逛"）写入 userData/guest.json，
   * 主进程下次启动据此跳过强制登录，直接起 pet + panel。
   * 不直接读写 StoredProfile，避免污染初始化数据。
   */
  ipcMain.handle('guest:set', async (_event, value: boolean): Promise<{ ok: true }> => {
    await writeGuestFlag(value)
    return { ok: true }
  })

  ipcMain.handle('guest:get', async (): Promise<{ isGuest: boolean }> => {
    return { isGuest: await readGuestFlag() }
  })
}

/** 访客模式标记：写入 userData/guest.json；存在视为已选 guest */
async function writeGuestFlag(value: boolean): Promise<void> {
  const path = join(app.getPath('userData'), 'guest.json')
  const tmp = `${path}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ isGuest: value }, null, 2), { mode: 0o600 })
  await fsp.rename(tmp, path)
}

async function readGuestFlag(): Promise<boolean> {
  const path = join(app.getPath('userData'), 'guest.json')
  try {
    const raw = await fsp.readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as { isGuest?: boolean }
    return Boolean(parsed.isGuest)
  } catch {
    return false
  }
}

/** 16 型 MBTI 白名单：与 server routes/me.ts 保持一致，避免 portrait IPC 路径穿越 */
const MBTI_TYPE_RE = /^(INTJ|INTP|ENTJ|ENTP|INFJ|INFP|ENFJ|ENFP|ISTJ|ISFJ|ESTJ|ESFJ|ISTP|ISFP|ESTP|ESFP)$/i

// Electron 就绪后查档案，按状态决定起始窗口；同步建托盘
app.whenReady().then(async () => {
  // 托盘先建好——即使在 setup 阶段用户也能从托盘强制退出
  try {
    createTray()
  } catch (err) {
    // 极少数环境（Linux 无托盘）会抛错；不让它阻断启动流程
    console.warn('[main] 创建托盘失败：', err)
  }
  registerIpc()
  const stored = await readProfile()
  // 访客模式分流：profile 未初始化但用户上次选过"先逛逛" → 直接起 pet + panel（绕过 setup）
  if (!stored.profile || !stored.profile.mbti) {
    const isGuest = await readGuestFlag()
    if (isGuest) {
      createPetWindow()
      return
    }
    createSetupWindow()
    return
  }
  createPetWindow()
})

// macOS 习惯：dock 图标被点击时若无窗口则重建。这里没有 dock 图标，纯保险。
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const storedPromise = readProfile()
    storedPromise.then(async (stored) => {
      if (stored.profile && stored.profile.mbti) {
        createPetWindow()
      } else {
        const isGuest = await readGuestFlag()
        if (isGuest) {
          createPetWindow()
          return
        }
        createSetupWindow()
      }
    })
  }
})

// 全部窗口关闭时不主动 quit：托盘常驻，用户从托盘菜单选"退出"才真退出
// （M2 旧行为是直接 quit，M3 桌宠交互层要求"最小化/隐藏桌宠→托盘驻留"）
app.on('window-all-closed', () => {
  if (isShuttingDown) {
    app.quit()
  }
  // 否则保留进程：托盘仍驻留，等用户唤回桌宠或主动退出
})