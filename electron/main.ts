// 【文件说明】Petibi 主进程（M3 桌宠交互层重构 + M4 海报分享补 portrait IPC + M4-P0 修复 + M4 右键菜单与重测 +
//   M4 内嵌 server 工单 + M4 登录态门禁）：
//   1. 启动时根据 userData/profile.json + 本地 token 是否可用（含 JWT exp 校验）决定先开
//      setup 窗 / pet 窗 / 仅 panel 窗（访客）。ISSUES P2-025：未登录不显示桌宠；
//   2. 同时创建系统托盘（tray），托盘在 setup 阶段也已驻留，方便用户随时退出；
//   3. 提供 IPC：拖拽（M1 沿用）/ 桌宠右键菜单（三项：主面板/隐藏桌宠/退出，M4 简化掉调试 radio 与重复项）/
//      profile 读写（M2 沿用）/ 单击桌宠打开面板（M3 新增）/ 面板隐藏（M3 新增）/
//      portrait 读取（M4 海报生成：把 assets/art/portraits/<type>.png 转成 data URL 返回渲染进程）/
//      重测人格（M4 新增：profile:set-mbti 写回 + pet:sprite-change 广播，让桌宠热切换 sprite）/
//      server 信息（M4 内嵌 server 工单：把 server 在主进程内启动，把实际 host:port 经 IPC 告知 renderer）/
//      退出登录（M4 P2-025：panel → 主进程清 token + 隐藏桌宠 + 打开 setup 窗）/
//      token 失效（M4 P2-025：panel 401 触发后通知主进程隐藏桌宠 + 打开 setup 窗）；
//   4. 桌宠窗和面板窗"关闭"按钮都只隐藏不销毁，进程不退出；托盘"退出"菜单才真正 quit；
//   5. setup 窗被用户手动关闭（放弃初始化）依旧 quit；但主进程主动关它去开桌宠窗
//      （setup:complete）不退出——见 shouldQuitOnSetupClosed（P0-006 修复）；
//   6. 访客模式（M4 A3）开 setup → 写 guest 标志 + 关 setup + 仅开 panel；不再开桌宠窗
//      （M4 P2-025 修正：访客没桌宠概念）。
//
// 桌宠窗属性完全保留 M1 已验收的 128×128 透明无边框悬浮窗配置；
// setup 窗为正常应用窗口（不透明、有边框、出现在任务栏），适合做邮箱登录 + 测试长流程；
// panel 窗为 400×600 正常应用窗口，居中显示。
//
// 资源路径（M4-P0 修复）：
//   - 打包后 resources/ assets/ data/ 由 electron-builder 的 extraResources 拷贝到
//     process.resourcesPath 下（即安装目录 resources/ 下）；
//   - dev 模式下走仓库根；
//   - 工具函数 resolveResourcePath() 统一两条路径，方便后续添加资源时一处切换。
//
// M4 内嵌 server 工单补充：
//   - app.whenReady 第一件事：startServerInMain()，把 esbuild 产出的 dist/server/server.cjs
//     用 require 加载并调用 startServer()，数据库落到 userData/chat.db（prod 可写）；
//   - 端口默认 127.0.0.1:8787，被占用顺延 8788/8789/8790/再不行 OS 随机分配；
//   - 真实 host:port 通过 IPC server:get-info 暴露给 renderer（同步取值，因启动期已固定）；
//   - 渲染进程 src/api/client.ts 的 BASE_URL 由 client.ts 内置的 petApi.getServerBaseUrl()
//     同步取得；
//   - 应用退出前 await server.close() 优雅关停（先停 HTTP 再关 DB）。
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
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

// 【M5 真 API 接入工单】主进程启动时加载项目根 .env，让 DEEPSEEK_API_KEY 等
// 在 startServerInMain() 调用 require('./server.cjs') 之前就注入到 process.env。
// 这样 embed bundle 内部 loadConfig() 读到的 apiKey 不是空，路由会走真实流式。
// 路径解析：dev = __dirname/../..，prod = process.resourcesPath（与 server bundle 的
// resources/data 寻址保持一致；不在 prod 包根目录写 .env）。
//
// M5 P1-D 升级：env 加载顺序必须满足「系统环境变量 > userData/.env > 项目 .env（dev）」：
//   1. 系统环境变量：process.env 启动时已继承父进程（Windows 用户级 env 变量通过 setx 设置后
//      启动 Petibi.exe 会自动出现在 process.env）；优先级最高，dotenv 默认不覆盖（保持显式
//      setx 的设置永远胜出 .env 里的 fallback）；
//   2. userData/.env（安装版 per-user 覆盖）：用户可在自己的用户目录下放一个 .env，
//      比项目 .env 优先级高——典型场景是 owner 在生产机器上换 key 不想改安装包；
//   3. 项目 .env（dev）：仓库根 .env，仅 dev 路径下生效；prod 走 process.resourcesPath/.env
//      （electron-builder extraResources 把 .env 拷过去）作为兜底。
// 不再 require('dotenv')：直接用 server/src/env.ts 同款的手写 fallback parser（10 行内），
// 避免 electron-builder 漏 bundle dotenv 导致安装版 require 抛错、env 加载完全失败。
function loadProjectEnvInMain(): void {
  const candidates: Array<{ path: string; source: string }> = []
  // 1) userData/.env：app.isPackaged 才考虑（dev 模式没必要写到 userData）
  if (app.isPackaged) {
    candidates.push({
      path: join(app.getPath('userData'), '.env'),
      source: 'userData',
    })
  }
  // 2) 项目 .env：dev 走仓库根，prod 走 process.resourcesPath
  candidates.push({
    path: app.isPackaged
      ? join(process.resourcesPath, '.env')
      : join(__dirname, '..', '..', '.env'),
    source: app.isPackaged ? 'resources' : 'dev',
  })
  // 3) cwd 兜底：用户 cd 到任意目录启动 Petibi.exe 的场景
  candidates.push({
    path: join(process.cwd(), '.env'),
    source: 'cwd',
  })

  for (const c of candidates) {
    if (!existsSync(c.path)) continue
    const parsed = parseDotenvManually(c.path)
    if (!parsed) continue
    let applied = 0
    for (const [k, v] of Object.entries(parsed)) {
      // 不覆盖已有 env（系统环境变量优先级最高，setx 设的 key 永远胜出 .env）
      if (process.env[k] === undefined) {
        process.env[k] = v
        applied++
      }
    }
    if (applied > 0) {
      console.log(`[main] env loaded: ${applied} keys from ${c.path} (source=${c.source})`)
    } else {
      console.log(`[main] env file ${c.path} 已存在但所有键已被系统 env 覆盖（source=${c.source}）`)
    }
  }
  if (process.env['DEEPSEEK_API_KEY']) {
    // 不打印 key 值，只打印是否已配置 + key 长度（让 owner 确认是否真的拿到了 key）
    console.log(`[main] DEEPSEEK_API_KEY present (length=${process.env['DEEPSEEK_API_KEY'].length})`)
  } else {
    console.log('[main] DEEPSEEK_API_KEY 未配置（走 mock LLM）')
  }
}

/**
 * 手写 .env 解析：dotenv 不可用时的兜底（10 行内），与 server/src/env.ts 同款实现。
 *   - 支持 KEY=VALUE 单行
 *   - 支持 # 注释与空行
 *   - 支持双/单引号包裹（去掉外层引号）
 * 不支持转义、多行 value——这些场景用 dotenv 即可，不影响 Petibi 现有 .env.example 形态。
 *
 * 导出便于 vitest 在 node 环境钉死行为（不依赖 electron mock 也能跑）。
 */
export function parseDotenvManually(path: string): Record<string, string> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}
// 在 app.whenReady 之前调一次最稳：让后续 startServerInMain() 拿到的 process.env 已经含 key
loadProjectEnvInMain()

// electron-vite 在 dev 模式下注入的渲染进程 dev-server 地址；打包后该变量为空
const devUrl = process.env['ELECTRON_RENDERER_URL']

// 桌宠 + setup + panel 三个窗口的引用；同一时刻 pet / setup 二选一，panel 按需展示
let petWin: BrowserWindow | null = null
let setupWin: BrowserWindow | null = null
let panelWin: BrowserWindow | null = null
let tray: Tray | null = null

// 桌宠是否被"隐藏"（点托盘"隐藏桌宠"后），用于菜单项勾选与状态回告
let petHidden = false

// 用户是否主动退出（与 window-all-closed 配合判断是否真退出）
let isShuttingDown = false

// setup 窗是否正在被"主动切换到桌宠"关闭（P0-006 根因修复）：
// transitionSetupToPet 主动 close() setup 窗时置 true，setup 窗的 'closed' 回调据此
// 判定这不是用户放弃初始化，因而不能 app.quit()。closed 回调消费后立刻复位。
let setupClosingForTransition = false

// 内嵌 server 句柄（startServerInMain 后填充）；close 走 await handle.close()
type ServerBundle = {
  startServer: (opts: Record<string, unknown>) => Promise<{
    port: number
    host: string
    dbPath: string
    close: () => Promise<void>
  }>
}
let runningServer: Awaited<ReturnType<ServerBundle['startServer']>> | null = null

/**
 * 计算 esbuild 产出的 server bundle 路径：
 *   - dev：仓库根/dist/server/server.cjs（__dirname 形如 out/main，向上两级即仓库根）
 *   - prod：process.resourcesPath/server/server.cjs（electron-builder extraResources 把
 *     dist/server 拷到 resources/server 下）
 */
function resolveServerBundlePath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'server', 'server.cjs')
  }
  return join(__dirname, '..', '..', 'dist', 'server', 'server.cjs')
}

/**
 * 主进程内嵌启动 server：app.whenReady 第一件事，确保所有 BrowserWindow 创建之前
 * server 已经 listen（renderer 第一次 fetch 不会撞上 refused）。
 *
 * 关键配置：
 *   - host/port 默认 127.0.0.1:8787；startServer 内部已实现端口顺延；
 *   - dbPath 在 prod 下落到 app.getPath('userData')/chat.db（可写）；
 *   - publicDir 指向 resources/server/public（含 privacy.html / terms.html）；
 *   - postersDir 指向 userData/posters（用户上传海报独立于安装目录）；
 *   - personasDir 指向 <dataRoot>/personas（打包后即 process.resourcesPath/data/personas）；
 *   - 通过环境变量告知 server 各 data/*.json 的绝对路径（避免 esbuild CJS bundle 下
 *     import.meta.url 为空导致的相对路径解析失败）。
 */
async function startServerInMain(): Promise<void> {
  const userData = app.getPath('userData')
  const fspSync = (() => {
    // 保证 userData / posters 目录存在（mkdirSync recursive，幂等）
    try {
      const { mkdirSync } = require('fs') as typeof import('fs')
      mkdirSync(join(userData, 'posters'), { recursive: true })
    } catch (e) {
      console.warn('[main] 创建 userData 子目录失败：', e)
    }
  })()
  void fspSync

  // 设置 server 各 data/* 路径环境变量（embed bundle 内的 import.meta.url 不可用）
  // dev 路径：仓库根/data/...
  // prod 路径：process.resourcesPath/data/...
  const dataRoot = app.isPackaged
    ? join(process.resourcesPath, 'data')
    : join(__dirname, '..', '..', 'data')
  process.env['PETIBI_SENSITIVE_WORDS_PATH'] = join(dataRoot, 'sensitive-words.json')
  process.env['PETIBI_INTENT_FILTER_PATH'] = join(dataRoot, 'intent-filter.json')
  process.env['PETIBI_REFUSALS_PATH'] = join(dataRoot, 'refusals.json')
  process.env['PETIBI_ENCYCLOPEDIA_INDEX_PATH'] = join(dataRoot, 'encyclopedia', 'index.json')
  process.env['PETIBI_ENCYCLOPEDIA_DIR'] = join(dataRoot, 'encyclopedia')
  // 人格速查卡目录：打包后 data/ 在 process.resourcesPath 下，bundle 自身推算不出来
  // （esbuild CJS bundle 里 import.meta.url 为空）。不注入就会退化成"伙伴/未知"兜底文案。
  process.env['PETIBI_PERSONAS_DIR'] = join(dataRoot, 'personas')
  process.env['PETIBI_EMBED'] = '1'  // 标识当前是主进程内嵌，server 走 dev 模式打码

  const bundlePath = resolveServerBundlePath()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bundle: ServerBundle = require(bundlePath)

  // publicDir：打包后 resources/server/public，dev 时仓库根/server/public
  const publicDir = app.isPackaged
    ? join(process.resourcesPath, 'server', 'public')
    : join(__dirname, '..', '..', 'server', 'public')

  runningServer = await bundle.startServer({
    host: '127.0.0.1',
    port: 8787,
    dbPath: join(userData, 'chat.db'),
    publicDir,
    postersDir: join(userData, 'posters'),
    // 人格速查卡：dev = 仓库根/data/personas，prod = process.resourcesPath/data/personas
    personasDir: join(dataRoot, 'personas'),
    // dev 默认 secret 即可（只在 127.0.0.1 暴露，无外部攻击面）
    jwtSecret: process.env['PETIBI_JWT_SECRET'] || 'petibi-desktop-secret',
    // 【M5】当用户已在 .env 配 DEEPSEEK_API_KEY 时不再强制 mock；
    // 没配或显式 FORCE_MOCK=1 时走 mock 流式；START_FORCE_MOCK 可在测试场景显式覆盖。
    forceMock: process.env['FORCE_MOCK'] === '1' || !process.env['DEEPSEEK_API_KEY'],
  })
  console.log(
    `[main] 内嵌 server 启动完成：${runningServer.host}:${runningServer.port}`,
  )
}

/** 把 server URL 转成渲染进程可消费的字符串（供 BrowserWindow additionalArguments 注入） */
function buildServerUrlArg(): string {
  if (!runningServer) return '--server-url=http://127.0.0.1:8787'
  return `--server-url=http://${runningServer.host}:${runningServer.port}`
}

/**
 * 资源根目录：
 *   - dev：仓库根（__dirname 形如 out/main，向上两级即仓库根）
 *   - prod：process.resourcesPath，即安装目录下的 resources/；
//     extraResources 把 resources/ assets/ data/ 三个目录整体拷到 process.resourcesPath 下
//     （最终安装路径 resources/resources/...），这里返回这一层。
 *
 * 返回值是"装着 resources/ assets/ data/ 三个子目录的那一层"，调用方自己拼子目录名。
 */
function resourcesRoot(): string {
  // devUrl 在打包后为空；在 dev 下也用作 dev/prod 区分标记
  if (!devUrl) {
    return app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
  }
  return join(__dirname, '../..')
}

/** tray 图标 / 主进程读取 sprite 用的目录（指向 resources/ 下） */
const RESOURCES_DIR = join(resourcesRoot(), 'resources')
/** 海报 portrait / 美术资产目录（指向 assets/ 下） */
const ASSETS_DIR = join(resourcesRoot(), 'assets')
/** 百科 / 数据库目录（指向 data/ 下） */
const DATA_DIR = join(resourcesRoot(), 'data')

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
      // 让 preload 通过 additionalArguments 识别当前窗口角色；M4 内嵌 server 工单同步注入
      // --server-url=... 让 src/api/client.ts 同步取得 baseURL（preload 在 contextBridge 暴露时一次性固化）
      additionalArguments: ['--petibi-role=pet', buildServerUrlArg()],
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
 * 关闭行为：保留 M2 行为——用户放弃初始化即退出 app（避免后台挂个无主窗）。
 * **但**主进程主动关 setup 窗切桌宠（transitionSetupToPet）时不能退出——
 * 这是 P0-006 的根因，判定逻辑收敛在纯函数 shouldQuitOnSetupClosed 里。
 *
 * M4 重测人格：options 允许指定 mode + initialStep：
 *   - mode='initial'（默认）：从 login 走完整流程
 *   - mode='retest'：从 pick 直接进入（用户已有 token / 昵称，重测只换人格）
 * 渲染进程 setupStore 根据 query 串初始化 state，Router 自动跳过 login / nickname。
 */
interface CreateSetupWindowOptions {
  mode?: 'initial' | 'retest'
  initialStep?: 'pick' | 'test'
}
function createSetupWindow(options: CreateSetupWindowOptions = {}): void {
  const mode = options.mode ?? 'initial'
  const initialStep = options.initialStep ?? 'pick'
  // 新窗口的生命周期与上一个窗口的过渡状态无关：这里显式复位，避免上一次
  // transitionSetupToPet 因窗口已销毁而没触发 'closed' 时把 flag 留成 true。
  setupClosingForTransition = false
  setupWin = new BrowserWindow({
    width: 800,
    height: 640,
    // T3 工单：setup 窗改为无边框 + 自绘标题栏（DESIGN.md §6）
    // 用渲染进程自绘 28px 标题栏，主进程不再提供原生 frame。
    // 桌面小窗需要整窗拖动时通过 titlebar 的 -webkit-app-region: drag 区域。
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    // 让用户能从任务栏找回正在进行的初始化流程
    skipTaskbar: false,
    // 居中显示，避免初次启动位置奇怪
    center: true,
    title: 'Petibi 初始化',
    backgroundColor: '#fef9ef',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      additionalArguments: ['--petibi-role=setup', buildServerUrlArg()],
    },
  })

  setupWin.on('closed', () => {
    setupWin = null
    // P0-006 根因：这里以前只判 mode==='initial' 就 app.quit()，
    // 而 setup:complete → transitionSetupToPet() 正是主进程自己 close() 这个窗，
    // 于是"点完成，去和我的桌宠玩"被当成"用户放弃初始化"→ 整个应用退出。
    // 现在把判定收敛到 shouldQuitOnSetupClosed：过渡关闭（transition）一律不退出。
    const quit = shouldQuitOnSetupClosed({
      mode,
      isShuttingDown,
      transitioningToPet: setupClosingForTransition,
    })
    // flag 是一次性的：消费完立刻复位，避免影响后续新建的 setup 窗
    setupClosingForTransition = false
    if (quit) {
      isShuttingDown = true
      app.quit()
    }
  })

  // 把 mode / initialStep 通过 query 串塞给渲染进程（避免 additionalArguments 长字符串转义坑）
  const qs = new URLSearchParams({ mode, initialStep }).toString()
  if (devUrl) {
    // devUrl 形如 http://localhost:5173/（带尾斜杠）或 http://localhost:5173（不带），统一处理
    setupWin.loadURL(`${devUrl.replace(/\/$/, '')}/setup/index.html?${qs}`)
  } else {
    setupWin.loadFile(join(__dirname, '../renderer/setup/index.html'), { search: qs })
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
    // T3 工单：panel 窗同样改为无边框 + 自绘标题栏（DESIGN.md §6）
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    skipTaskbar: false,
    center: true,
    title: 'Petibi',
    backgroundColor: '#fef9ef',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      additionalArguments: ['--petibi-role=panel', buildServerUrlArg()],
    },
  })

  // 关闭按钮 = 隐藏，保留 BrowserWindow 便于下次快速唤回
  panelWin.on('close', (e) => {
    if (isShuttingDown) return
    e.preventDefault()
    panelWin?.hide()
  })

  if (devUrl) {
    panelWin.loadURL(`${devUrl.replace(/\/$/, '')}/panel/index.html`)
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

/**
 * setup 窗 'closed' 时是否应该退出应用（P0-006 修复的判定核心，抽成纯函数便于 vitest 钉死）。
 *
 * 三条规则，按优先级：
 *   1. isShuttingDown：已经在退出流程里（托盘"退出"/ before-quit），不重复 quit → false；
 *   2. transitioningToPet：主进程主动关 setup 窗去开桌宠窗（setup:complete / 访客模式），
 *      这是**正常完成**，绝不能退出 → false；【P0-006 根因】
 *   3. 其余情况按 mode 判定：
 *      - 'initial'：用户在初始化流程里手动关窗 = 放弃初始化 → true（保留 M2 行为）；
 *      - 'retest' ：桌宠已在跑，关掉重测窗只是取消重测 → false。
 */
export function shouldQuitOnSetupClosed(ctx: {
  mode: 'initial' | 'retest'
  isShuttingDown: boolean
  transitioningToPet: boolean
}): boolean {
  if (ctx.isShuttingDown) return false
  if (ctx.transitioningToPet) return false
  return ctx.mode === 'initial'
}

/**
 * 关闭 setup 窗并启动 pet 窗（setup:complete / 访客模式共用的过渡）。
 *
 * 顺序很重要（P0-006 修复）：
 *   1. 先置 setupClosingForTransition = true —— 告诉 setup 窗的 'closed' 回调
 *      "这是主进程主动切窗，不是用户放弃初始化"，否则整个应用会退出；
 *   2. 先建桌宠窗再关 setup 窗 —— 保证任一时刻至少有一个窗口存活，
 *      不会瞬时触发 window-all-closed，用户观感上也是"桌宠直接出现"。
 */
function transitionSetupToPet(): void {
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow()
  } else if (!petWin.isVisible()) {
    petWin.show()
  }
  if (setupWin && !setupWin.isDestroyed()) {
    setupClosingForTransition = true
    setupWin.close()
  }
  setupWin = null
}

/**
 * 创建系统托盘：菜单含"显示桌宠 / 隐藏桌宠 / 退出"。
 * 点托盘图标默认唤回桌宠（与 Windows 用户习惯一致）。
 *
 * 托盘图标：复用 32×32 sprite 缩放到 16×16（Windows 托盘原生尺寸）；
 * nativeImage 在 Windows 下若不 resize，icon 会被系统按 icon 规范缩放但像质变差，
 * 这里显式 resize 到 16×16 并标记为 template image（Windows 自动适配深浅主题）。
 */
function createTray(): void {
  if (tray) return
  const iconPath = join(RESOURCES_DIR, 'sprites/intj/idle_0.png')
  let image = nativeImage.createFromPath(iconPath)
  // 资源缺失时退化为空图标（不阻塞启动）；日志打印便于排查打包漏资源
  if (image.isEmpty()) {
    console.warn(`[main] 托盘图标加载失败：${iconPath}（检查 resources/sprites 是否随 extraResources 打包）`)
    image = nativeImage.createEmpty()
  } else {
    // Windows 托盘推荐 16×16；这里 setTemplateImage 让系统按主题适配（深色任务栏反色）
    image = image.resize({ width: 16, height: 16 })
    image.setTemplateImage(false)
  }
  tray = new Tray(image)
  tray.setToolTip('Petibi 桌宠')
  // 单击：仅显示桌宠（M4 原有行为）
  tray.on('click', () => {
    // 单击托盘图标：显示桌宠（如已隐藏则唤回）
    showPet()
  })
  // 收尾修复：双击托盘 → 显示桌宠 + 打开主面板（与桌宠双击的 UX 一致）。
  // 区别于单击：单击只唤回桌宠（用户继续点右键菜单走完整操作），
  // 双击是"我想立刻开始对话"的快捷路径。
  // 注意 Windows 上托盘 click 和 double-click 都会触发，需要靠 Electron 内部
  // 防抖（系统级双击阈值）保证不会两个 handler 都跑——这里接受"双击时同时
  // 触发 click + double-click"的事实，因为 showPet 是幂等的。
  tray.on('double-click', () => {
    showPet()
    showPanel()
  })
  refreshTrayMenu()
}

/** 重建托盘菜单项：显示/隐藏桌宠按 petHidden 切换 label 和 enabled */
function refreshTrayMenu(): void {
  if (!tray) return
  const items = buildTrayMenuItems({
    petHidden,
    onShowPet: () => showPet(),
    onHidePet: () => hidePet(),
    onQuit: () => {
      isShuttingDown = true
      app.quit()
    },
  })
  const menu = Menu.buildFromTemplate(items)
  tray.setContextMenu(menu)
}

/**
 * 抽出托盘菜单的 item 数组为纯函数（不依赖 Menu.buildFromTemplate / tray 实例），
 * 方便 vitest 在 node 环境直接断言"显示/隐藏/退出"三项结构稳定。
 * 切换项 label 跟随 petHidden：未隐藏显示"隐藏桌宠"，已隐藏显示"显示桌宠"。
 */
export interface TrayMenuActions {
  petHidden: boolean
  onShowPet: () => void
  onHidePet: () => void
  onQuit: () => void
}
export function buildTrayMenuItems(actions: TrayMenuActions): Array<
  | { label: string; click: () => void }
  | { type: 'separator' }
> {
  return [
    {
      label: actions.petHidden ? '显示桌宠' : '隐藏桌宠',
      click: () => (actions.petHidden ? actions.onShowPet() : actions.onHidePet()),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: actions.onQuit,
    },
  ]
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

/**
 * 桌宠右键菜单的 item 数组纯函数（M4 重构：抽出来便于 vitest 直接断言结构）：
 *   - 三项：主面板 / 隐藏桌宠（已隐藏时显示"显示桌宠"）/ 退出；
 *   - "隐藏桌宠"项按 petHidden 切换 label 与 click 行为；
 *   - 不再有调试残留的待机/眨眼/开心 radio 与重复项（owner 实测反馈 P0-004）。
 *
 * 与 buildTrayMenuItems 的差异：托盘只暴露隐藏切换 + 退出（无主面板入口）；
 * 右键菜单多了主面板入口（pet 窗就在那里，桌宠右键"主面板"是同窗口唤起）。
 */
export interface PetContextMenuActions {
  petHidden: boolean
  onOpenPanel: () => void
  onShowPet: () => void
  onHidePet: () => void
  onQuit: () => void
}
export function buildPetContextMenuItems(actions: PetContextMenuActions): Array<
  | { label: string; click: () => void }
  | { type: 'separator' }
> {
  return [
    {
      label: '主面板',
      click: actions.onOpenPanel,
    },
    {
      // 切换项：根据 petHidden 切换 label + 行为
      //   - 已隐藏：label = "显示桌宠"，click = onShowPet
      //   - 未隐藏：label = "隐藏桌宠"，click = onHidePet
      label: actions.petHidden ? '显示桌宠' : '隐藏桌宠',
      click: () => (actions.petHidden ? actions.onShowPet() : actions.onHidePet()),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: actions.onQuit,
    },
  ]
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

  // M4 简化：动画状态切换从右键菜单移除，键盘 1/2/3/4 在渲染进程本地切换，
  // 不再回告主进程；pet:state-changed IPC 同步移除（保留接口无用还会误导后续读代码的人）。

  ipcMain.on('pet:menu', () => {
    if (!petWin) return
    // M4 工单简化：右键菜单三项（主面板 / 隐藏桌宠 / 退出），干掉调试残留的
    // 待机/眨眼/开心 radio 与重复的"隐藏桌宠"。动画状态切换仅保留键盘快捷键 1/2/3 供
    // 开发调试，菜单不再暴露给普通用户。owner 实测反馈 P0-004 + M4 整合决策。
    const items = buildPetContextMenuItems({
      petHidden,
      onOpenPanel: () => showPanel(),
      onShowPet: () => showPet(),
      onHidePet: () => hidePet(),
      onQuit: () => {
        isShuttingDown = true
        app.quit()
      },
    })
    const menu = Menu.buildFromTemplate(items)
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

  // ===== M4 P2-025 Bug 2 修复：老用户登录完成 → pet + panel 双开 =====
  /**
   * 老用户登录（LoginPage 检测到 user.mbti 已存在 → 写本地 profile 后触发）→
   * 主进程关 setup、开 pet + panel。区别于 setup:complete 的仅 pet：
   *   - setup:complete（首次注册）：用户刚走完 5 步初始化，结果页点"完成，去和你的
   *     桌宠玩"——此时 pet 是新出现的惊喜，由用户单击 pet 唤出 panel，UX 上更聚焦。
   *   - setup:complete-existing-user（老用户登录）：用户已经熟悉产品，登录后
   *     应该立即看到桌宠 + 主面板一起出现，桌面宠物应用的"常伴面板"姿态（M4 owner 实测
   *     反馈"主面板和桌宠要一起出现"）。
   *
   * 流程对齐 transitionSetupToPet：先建 pet（保证任一时刻至少有一个窗口）→ 关 setup
   * （用 setupClosingForTransition flag 避免被当作"放弃初始化"退出）→ 开 panel。
   * pet 和 panel 都是懒加载 / 已存在则复用 show()，不重复创建。
   */
  ipcMain.on('setup:complete-existing-user', () => {
    // pet：先 ensure + 显示
    if (!petWin || petWin.isDestroyed()) {
      createPetWindow()
    } else if (!petWin.isVisible()) {
      petWin.show()
    }
    petHidden = false
    petWin?.webContents.send('pet:visibility', false)
    refreshTrayMenu()
    // 关 setup（用 transition flag）
    if (setupWin && !setupWin.isDestroyed()) {
      setupClosingForTransition = true
      setupWin.close()
    }
    setupWin = null
    // panel：老用户登录后立即出现（区别于 setup:complete 的"等用户单击 pet"）
    createPanelWindow()
    if (panelWin && !panelWin.isVisible()) {
      panelWin.show()
      panelWin.focus()
    }
  })

  // M4 工单 A3 访客模式：用户在 LoginPage 点"先逛逛" → 写 guest 标志 → 关 setup、开 panel。
  // M4 P2-025 登录门禁修正：访客态**不再起 pet 窗**——桌宠必须属于已登录用户，
  // 访客只能逛百科/社区，对话/我的由 panel GuestLock 锁定。
  ipcMain.on('setup:enter-guest', async () => {
    try {
      await writeGuestFlag(true)
    } catch (err) {
      console.warn('[main] 写入 guest 标志失败：', err)
    }
    // 关 setup 窗（用 transition flag 避免被当作「放弃初始化」退出）
    if (setupWin && !setupWin.isDestroyed()) {
      setupClosingForTransition = true
      setupWin.close()
    }
    setupWin = null
    // 仅开主面板（不调 transitionSetupToPet，避免误起 pet）
    createPanelWindow()
  })

  // 调试用：渲染进程请求退出 setup（保留接口，方便后续扩展）
  ipcMain.on('setup:cancel', () => {
    isShuttingDown = true
    app.quit()
  })

  // ===== T3 工单：自绘标题栏 IPC（最小化）=====
  /**
   * setup 窗标题栏的最小化按钮：调用 BrowserWindow.minimize()。
   * 不调 quit（用户只是把窗口收起来，进程依旧在）。
   */
  ipcMain.on('setup:minimize', () => {
    if (setupWin && !setupWin.isDestroyed()) {
      setupWin.minimize()
    }
  })

  /**
   * panel 窗标题栏的最小化按钮：调用 BrowserWindow.minimize()。
   * 隐藏/最小化都由用户显式控制，不做自动 hide。
   */
  ipcMain.on('panel:minimize', () => {
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.minimize()
    }
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

  // ===== M4 P2-025 登录门禁：退出登录 / token 失效恢复 =====
  /**
   * 「我的」Tab 点「退出登录」→ 主进程清 token（保留 profile 字段便于重新登录后 UX）+
   * 隐藏桌宠 + 打开 setup 登录窗。
   *
   * 取舍说明：保留 profile 字段（email / nickname / mbti / subtype / createdAt），
   * 而不是整体清空——理由：
   *   1. 老用户退出后想重新登录时，setup 流程不会跳过 nickname/pick/test/result
   *      等步骤（这些步骤由 LoginPage 直接 dispatch LOGIN_SUCCESS 控制，与本地
   *      profile 无关），保留字段不会让用户"被当成已注册用户自动跳过测试"；
   *   2. 保留字段让重新登录成功后写回的 profile 是"合并"而非"全新"，避免
   *      server /api/me/profile 409（profile 已存在）误伤；
   *   3. token 单独清掉，下次启动时 decideStartupWindow 走 setup 分支。
   *
   * 桌宠隐藏而不是销毁：与 M3 设计一致（close 只 hide 不 quit），用户重新登录
   * 成功后 completeSetup → transitionSetupToPet 会把同一 BrowserWindow 唤回。
   */
  ipcMain.on('panel:logout', async () => {
    try {
      const stored = await readProfile()
      await writeProfile({ token: null, profile: stored.profile })
    } catch (err) {
      console.warn('[main] 退出登录：清本地 token 失败：', err)
    }
    // 隐藏桌宠（保留 BrowserWindow 实例）
    if (petWin && !petWin.isDestroyed()) {
      petWin.hide()
      petHidden = true
      petWin.webContents.send('pet:visibility', true)
      refreshTrayMenu()
    }
    // 打开登录 setup 窗
    if (!setupWin || setupWin.isDestroyed()) {
      createSetupWindow()
    } else {
      setupWin.show()
      setupWin.focus()
    }
  })

  /**
   * token 失效（panel 收到任意 401）：通知主进程执行与 logout 等价的"隐藏桌宠 + 开
   * 登录页"动作。注意本地 token 字段由 panel 端负责清（避免主进程与 panel 写竞态），
   * 主进程只负责 UI 侧状态切换。
   *
   * 与 panel:logout 的差异：本 IPC 触发时 panel 已经把 token 置 null，
   * 这里不再重复写 profile.json，只做窗口切换 + 隐藏桌宠。
   */
  ipcMain.on('panel:auth-expired', () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.hide()
      petHidden = true
      petWin.webContents.send('pet:visibility', true)
      refreshTrayMenu()
    }
    if (!setupWin || setupWin.isDestroyed()) {
      createSetupWindow()
    } else {
      setupWin.show()
      setupWin.focus()
    }
  })

  // ===== M4 重测人格：panel → 主进程拉起一个 retest 模式的 setup 窗 =====
  /**
   * 「我的」Tab 点「重新测试人格」→ 通知主进程拉起 retest 模式 setup 窗：
   *   - mode='retest' → 渲染进程从 pick 起步，跳过 login/nickname；
   *   - 复用现有 setup 窗对象（如已存在则先关，避免多窗）。
   * 流程对比 panel:open-setup（首次注册）：后者走 initial 模式，本 IPC 走 retest。
   */
  ipcMain.on('panel:open-setup-retest', () => {
    // 重测时把 panel 收起来（不销毁），让 setup 窗成为前台焦点
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.hide()
    }
    if (setupWin && !setupWin.isDestroyed()) {
      setupWin.close()
      setupWin = null
    }
    createSetupWindow({ mode: 'retest', initialStep: 'pick' })
  })

  /**
   * retest 完成（用户在 setup 结果页点「完成」）：携带新人格 + 细分类型，
   * 主进程负责三件事：
   *   1. 读 profile.json，更新 mbti / subtype 字段，其他字段保留；
   *   2. 写回 profile.json（原子写入，setProfile 走 writeProfile 路径）；
   *   3. 广播 pet:sprite-change 给 pet 窗，触发桌宠热切换 sprite；
   *   4. 关 setup 窗（不拉起新 pet 窗——pet 窗已存在）。
   */
  ipcMain.on(
    'setup:retest-complete',
    async (
      _event,
      payload: { mbti: string; subtype: 'stable' | 'sensitive' },
    ) => {
      const { mbti, subtype } = payload
      if (!mbti || !MBTI_TYPE_RE.test(mbti)) {
        console.warn('[main] retest 收到非法人格：', mbti)
        return
      }
      if (subtype !== 'stable' && subtype !== 'sensitive') {
        console.warn('[main] retest 收到非法 subtype：', subtype)
        return
      }
      try {
        const stored = await readProfile()
        if (!stored.profile || !stored.token) {
          console.warn('[main] retest 失败：profile 或 token 缺失（访客态？）')
          return
        }
        const next: StoredProfile = {
          token: stored.token,
          profile: {
            ...stored.profile,
            mbti: mbti.toUpperCase(),
            subtype,
          },
        }
        await writeProfile(next)
        // 广播 sprite 切换：pet 窗收到后立刻换路径
        if (petWin && !petWin.isDestroyed() && !petWin.webContents.isDestroyed()) {
          petWin.webContents.send('pet:sprite-change', mbti.toUpperCase())
        }
        // 通知 panel 刷新（getMe 拉一次）—— 用户改完人格后，"我的" Tab 里的
        // mbti / subtype 字段也应同步更新
        if (panelWin && !panelWin.isDestroyed() && !panelWin.webContents.isDestroyed()) {
          panelWin.webContents.send('panel:profile-changed')
        }
      } catch (err) {
        console.warn('[main] retest 写 profile 失败：', err)
      } finally {
        // 关 setup 窗（pet 窗已存在，不要 transitionSetupToPet）
        if (setupWin && !setupWin.isDestroyed()) {
          setupWin.close()
        }
        setupWin = null
      }
    },
  )

  /**
   * pet 启动期读取当前人格 mbti（来自 profile.json）。
   * profile 缺失时返回 'intj' 兜底（保持原 M2 默认行为；pet App 渲染进程同步回退）。
   */
  ipcMain.handle('pet:get-mbti', async (): Promise<string> => {
    const stored = await readProfile()
    return stored.profile?.mbti ?? 'intj'
  })

  // ===== M4 海报分享新增 =====
  /**
   * 读取人格形象图（assets/art/portraits/<type>.png）并转成 data URL 返回渲染进程。
   * 设计要点：
   *  - portrait 是闭源美术资产，放在 assets/ 而非 resources/，不打包进渲染进程的 publicDir；
   *  - 因此渲染进程不能直接用相对 URL 加载，必须经主进程读取后以 base64 data URL 返回；
   *  - 只允许 16 型人格白名单内的 type，防止路径穿越读仓库外的文件；
   *  - 文件不存在时返回 null（UI 走兜底分支：跳过形象图，正常生成海报）；
   *  - M4-P0 修复：路径由 process.cwd() 改为 ASSETS_DIR（dev 是仓库根 / 打包后是 process.resourcesPath + assets），
   *    解决"用户从任意目录启动应用导致 portrait 找不到"的问题。
   */
  ipcMain.handle('portrait:read', async (_event, type: string): Promise<string | null> => {
    if (!MBTI_TYPE_RE.test(type)) return null
    const portraitPath = join(ASSETS_DIR, 'art', 'portraits', `${type.toLowerCase()}.png`)
    try {
      const buf = readFileSync(portraitPath)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch (err) {
      console.warn(`[main] portrait 读取失败：${portraitPath}`, err)
      return null
    }
  })

  // ===== M4-P0-A 修复：sprite 形象图 IPC =====
  /**
   * 读取人格形象图 sprite（resources/sprites/<type>/<frame>.png）并转成 data URL 返回渲染进程。
   * 设计要点：
   *  - P0-A 修复：百科 Tab 在 panel 窗渲染（panel HTML 位于 out/renderer/panel/index.html），
   *    相对 URL `sprites/<type>/<frame>.png` 会解析到 out/renderer/panel/sprites/...（不存在）。
   *    桌宠窗能正常加载是因为 pet HTML 位于 out/renderer/index.html，路径解析恰好对得上；
   *    而 panel / setup 窗就不行（setup HTML 位于 out/renderer/setup/index.html 同样问题）。
   *  - 解决方案：仿照 portrait:read，把 sprite 也走 IPC 读盘 → base64 data URL，
   *    渲染端 <img src="data:image/png;base64,..."> 不依赖任何相对路径，
   *    pet / panel / setup 三个窗都能稳定显示；
   *  - 白名单限定 type（16 型人格）+ frame（避免路径穿越读仓库外文件）；
   *  - 文件不存在时返回 null，UI 走"跳过形象图"兜底。
   */
  ipcMain.handle(
    'sprite:read',
    async (
      _event,
      args: { type: string; frame: string },
    ): Promise<string | null> => {
      if (!args || typeof args.type !== 'string' || typeof args.frame !== 'string') return null
      if (!MBTI_TYPE_RE.test(args.type)) return null
      // frame 白名单：M4 桌宠 sprite 一共 6 个帧（idle_0/_1 / blink_0/_1 / thinking_0/_1）
      if (!ALLOWED_SPRITE_FRAMES.has(args.frame)) return null
      const spritePath = join(
        RESOURCES_DIR,
        'sprites',
        args.type.toLowerCase(),
        `${args.frame}.png`,
      )
      try {
        const buf = readFileSync(spritePath)
        return `data:image/png;base64,${buf.toString('base64')}`
      } catch (err) {
        console.warn(`[main] sprite 读取失败：${spritePath}`, err)
        return null
      }
    },
  )

  // ===== M4 整合体验 A1：百科 IPC（data/encyclopedia/<type>.json） =====
  /**
   * 读取某一人格的百科全文条目（结构化 JSON：{ personality, animal, family, entries[] }）。
   * 设计要点：
   *  - 百科数据是产品核心数据资产（PRD §3.6 / RAG 检索源），但放在 data/ 而非 resources/，
   *    渲染进程无法直接 fetch，必须经主进程读取 JSON 字符串返回；
   *  - 白名单限定 16 型人格，防止路径穿越；
   *  - 文件不存在时返回 null（UI 走兜底：列表展示完整，文案"暂无该人格百科"）；
   *  - 同步读取：条目平均 ~12KB，IO < 1ms，不走异步。
   *  - M4-P0 修复：路径由 process.cwd() 改为 DATA_DIR，确保打包后从 process.resourcesPath 读。
   */
  ipcMain.handle(
    'encyclopedia:read',
    async (_event, type: string): Promise<unknown | null> => {
      if (!MBTI_TYPE_RE.test(type)) return null
      const filePath = join(DATA_DIR, 'encyclopedia', `${type.toLowerCase()}.json`)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        return JSON.parse(raw)
      } catch (err) {
        console.warn(`[main] encyclopedia 读取失败：${filePath}`, err)
        return null
      }
    },
  )

  /**
   * 读取百科 index.json（16 人格 → 文件名 + 族色 + 动物）。
   * 与 data/encyclopedia/<type>.json 是 1:N 关系；index 体积小（<3KB），一次读全。
   * M4-P0 修复：路径同 encyclopedia:read，由 process.cwd() 改为 DATA_DIR。
   */
  ipcMain.handle('encyclopedia:index', async (): Promise<unknown | null> => {
    const filePath = join(DATA_DIR, 'encyclopedia', 'index.json')
    try {
      const raw = readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch (err) {
      console.warn(`[main] encyclopedia index 读取失败：${filePath}`, err)
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

  // ===== M4 内嵌 server：把实际 host:port 经 IPC 告知 renderer =====
  /**
   * 渲染进程（任意窗口）请求 server 信息：返回 host + port + baseURL。
   * - 用于：在 src/api/client.ts 走真接口时拿到动态 baseURL（端口可能被顺延）；
   * - 与 additionalArguments 中的 --server-url 互为冗余：additionalArguments 是同步通道
   *   （client.ts 顶层取），本 IPC 是异步通道（用于运行时重读，例如 dev 期间 server 重启）。
   */
  ipcMain.handle('server:get-info', async (): Promise<{
    host: string
    port: number
    baseURL: string
  }> => {
    if (!runningServer) {
      // 极端：server 启动失败但 UI 仍起来了；返回占位让 UI 走 mock 兜底
      return { host: '127.0.0.1', port: 8787, baseURL: 'http://127.0.0.1:8787' }
    }
    return {
      host: runningServer.host,
      port: runningServer.port,
      baseURL: `http://${runningServer.host}:${runningServer.port}`,
    }
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

/**
 * 启动期判定本地 token 是否"快筛可用"（M4 P2-025 登录门禁）：
 *   - 必须是形如 `<base64>.<base64>.<sig>` 的 JWT 三段；
 *   - payload.exp（Unix 秒）> 当前时间；
 *   - 不做签名校验——签名由 server /api/me 在收到请求时严格校验，本函数只做
 *     「已过期就别直接进桌宠」的快筛，避免带着过期 token 起 pet 后第一次请求就 401。
 *
 * 取出后供主进程 whenReady / activate / panel:logout 三处统一判定：
 *   - token 不可用（null / 过期 / 格式坏）→ 走 setup 登录页或访客分支；
 *   - token 可用 + profile.mbti 完整 → 起 pet 窗。
 *
 * 抽出为纯函数便于 vitest 钉死真值表（electron/__tests__/login-gate.test.ts）。
 */
export function isJwtUsable(token: string | null | undefined): boolean {
  if (!token || typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    // JWT 用 base64url：- → +，_ → /；补齐 padding 后用 'base64' 解码（Node Buffer 双支持）
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const payloadJson = Buffer.from(b64, 'base64').toString('utf8')
    const payload = JSON.parse(payloadJson) as { exp?: unknown }
    if (typeof payload.exp !== 'number') return false
    // exp 是秒，Date.now() 是毫秒
    return payload.exp * 1000 > Date.now()
  } catch {
    return false
  }
}

/**
 * 启动期统一分流（M4 P2-025）：根据「profile 是否完整 + token 是否可用 + 是否访客」三态
 * 决定开哪个窗口。收敛在一处便于 vitest 钉死真值表（login-gate.test.ts）。
 *
 * 返回值（用对象而非命令式调窗，方便测试断言）：
 *   - 'pet'       ：已登录（有 token 且未过期 + profile.mbti）→ 开 pet 窗
 *   - 'panel'     ：访客模式（profile 未初始化 + guest 标志）→ 仅开 panel
 *   - 'setup'     ：其它情况 → 开 setup 登录页（含 profile 有 mbti 但 token 失效场景）
 *
 * 设计取舍：token 有效性的优先级最高——若 token 可用但 profile 未完整（半完成态），
 * 也走 setup 而非 pet。理由：profile.mbti 缺失时桌宠没有可渲染的 sprite（resources/sprites/<type>/
 * 没值），强行开 pet 会回退到默认 intj，给用户"我是 INTJ"的错觉。setup 流程会自动续接
 * 老用户直通或新用户 nickname 步骤。
 */
export function decideStartupWindow(args: {
  hasProfile: boolean
  hasUsableToken: boolean
  isGuest: boolean
}): 'pet' | 'panel' | 'setup' {
  // 已登录：profile 完整 + token 可用 → 桌宠
  if (args.hasProfile && args.hasUsableToken) return 'pet'
  // 有 token 但 profile 未完整（半完成态）→ setup，让 LoginPage 走 nickname/pick/test/result
  // 这一条同时覆盖 `!hasProfile && hasUsableToken && isGuest`：token 有效性 > guest 标志，
  // 因为 token 一旦可用就意味着已通过 server 签发，比本地 guest 标志更可信。
  if (args.hasUsableToken && !args.hasProfile) return 'setup'
  // 访客模式：profile 未初始化 + 用户上次选了"先逛逛" → 仅面板，无桌宠
  if (!args.hasProfile && args.isGuest) return 'panel'
  // 其它（profile 有但 token 失效 / 全空）→ setup
  return 'setup'
}

/**
 * sprite 帧白名单：与 src/pet-sprite.ts 的帧表结构对齐（idle_0/_1 / blink_0/_1 / thinking_0/_1）。
 * happy 帧复用 idle_0 故不独立出现。P0-A 修复：sprite:read IPC 必须校验 frame 防止路径穿越。
 */
const ALLOWED_SPRITE_FRAMES: ReadonlySet<string> = new Set([
  'idle_0',
  'idle_1',
  'blink_0',
  'blink_1',
  'thinking_0',
  'thinking_1',
])

// ===== 单实例锁（P0-003）：重复启动聚焦已有实例，避免出现两只桌宠 =====
// requestSingleInstanceLock 必须在 app.whenReady 之前调用；
// 拿到锁即继续，拿到失败（已有实例运行）则直接退出。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 这里不要做任何重操作，只退出；真正的"二次启动聚焦"逻辑放在下面 second-instance 事件里
  app.quit()
} else {
  // 第二次启动时主进程收到的回调：拿到 argv 之后让现有实例把窗口拉到前台
  app.on('second-instance', () => {
    // 任一可见窗拉到前台；优先 pet 窗（用户最常用），没有再选 setup
    const target = petWin ?? setupWin ?? panelWin
    if (target && !target.isDestroyed()) {
      if (!target.isVisible()) target.show()
      // minimize 状态恢复
      if (target.isMinimized()) target.restore()
      target.focus()
    }
  })
}

// Electron 就绪后查档案，按状态决定起始窗口；同步建托盘
app.whenReady().then(async () => {
  // M4 内嵌 server：必须先启动 server 再建 BrowserWindow，否则 renderer 启动后第一次
  // fetch 会撞上 ECONNREFUSED。端口冲突顺延由 server 内部处理。
  try {
    await startServerInMain()
  } catch (err) {
    // server 启动失败是致命问题：登录/对话/广场全挂；UI 给个 console.error 不再自动恢复
    console.error('[main] 内嵌 server 启动失败，应用将无法登录/对话：', err)
  }
  // 托盘先建好——即使在 setup 阶段用户也能从托盘强制退出
  try {
    createTray()
  } catch (err) {
    // 极少数环境（Linux 无托盘）会抛错；不让它阻断启动流程
    console.warn('[main] 创建托盘失败：', err)
  }
  registerIpc()
  // M4 P2-025 登录门禁：分流由 decideStartupWindow() 统一决策。
  //   - 已登录（profile 完整 + token 未过期）→ 直接进桌宠；
  //   - 访客模式（profile 未初始化 + guest 标志）→ 仅开面板（无桌宠）；
  //   - 其它（无 profile / profile 有但 token 失效 / 老 token 格式坏）→ 引导重新登录。
  // 历史行为（comment 删除）：原"profile 缺失但 guest 标志"会起 pet 窗——这违反
  // ISSUES P2-025「没登录肯定是不能显示桌宠的，不然没登录就显示那这只桌宠是谁的」；
  // 现已改为仅 panel；百科/社区可逛，对话/我的 Tab 由 GuestLock 锁定。
  const stored = await readProfile()
  const isGuest = await readGuestFlag()
  const hasProfile = !!(stored.profile && stored.profile.mbti)
  const hasUsableToken = isJwtUsable(stored.token)
  const decision = decideStartupWindow({ hasProfile, hasUsableToken, isGuest })
  if (decision === 'pet') {
    createPetWindow()
  } else if (decision === 'panel') {
    createPanelWindow()
  } else {
    createSetupWindow()
  }
})

// macOS 习惯：dock 图标被点击时若无窗口则重建。这里没有 dock 图标，纯保险。
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const storedPromise = readProfile()
    storedPromise.then(async (stored) => {
      const isGuest = await readGuestFlag()
      const hasProfile = !!(stored.profile && stored.profile.mbti)
      const hasUsableToken = isJwtUsable(stored.token)
      const decision = decideStartupWindow({ hasProfile, hasUsableToken, isGuest })
      if (decision === 'pet') {
        createPetWindow()
      } else if (decision === 'panel') {
        createPanelWindow()
      } else {
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

/**
 * M4 内嵌 server：app 退出前优雅关停 server（先停 HTTP 接收新连接 → 关 DB）。
 * - before-quit：用户从托盘选"退出"或 app.quit() 触发；同步等 server.close() 完成。
 * - 兜底 5s 超时：close 阻塞时强退，避免卡住 Electron quit。
 */
app.on('before-quit', async (event) => {
  if (!runningServer) return
  // 阻止 quit，等 close 完成再放行
  event.preventDefault()
  const serverRef = runningServer
  runningServer = null
  console.log('[main] 正在关闭内嵌 server...')
  const closePromise = serverRef.close().catch((err) => {
    console.error('[main] server close 失败：', err)
  })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
  await Promise.race([closePromise, timeout])
  console.log('[main] 内嵌 server 已关闭，退出应用')
  isShuttingDown = true
  app.quit()
})