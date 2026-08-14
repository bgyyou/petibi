// 【文件说明】预加载脚本：通过 contextBridge 向渲染进程暴露最小安全 API。
// 三种窗口共用一份 preload，按当前窗口角色（pet / panel / setup）暴露对应方法：
//   - 桌宠窗（pet）    ：drag / showMenu（M1 沿用；M4 菜单结构精简）
//                          + openPanel / hidePet（M3 桌宠交互层新增）
//                          + getCurrentMbti / onSpriteChange（M4 重测新增：动态切人格 sprite）
//   - 主面板窗（panel） ：getInit / openChatWithQuestion（panel 启动期读取本地 profile）
//                          + onPanelHidden（关闭按钮回调）
//                          + openSetupRetest（M4 新增：从我的 Tab 触发重测流程）
//                          + logout / notifyAuthExpired（M4 P2-025 新增：登录门禁退出/失效）
//   - 系统托盘桥（仅主进程消费，无渲染端 API）
//   - setup 窗沿用 M2 的 getProfile / setProfile / completeSetup / cancelSetup / spriteUrl
//                          + notifyRetestComplete（M4 新增：setup 完成重测后回告主进程）
//
// M4 内嵌 server 工单新增：
//   - petApi.getServerBaseUrl()：同步取 main 进程启动时注入的 --server-url=...，
//     渲染进程 src/api/client.ts 顶层就能拿到 baseURL（无需 await IPC）。
//   - petApi.getServerInfo()：异步 IPC，等 main 进程读 runningServer 句柄；
//     用于运行时重读（dev 期间 server 重启 / 端口顺延后的再确认）。
//
// 设计原则：
//  - 渲染进程不直接接触 Node / fs / electron；所有 IPC 通过这里转发；
//  - sprite 路径返回相对 URL（dev 下走 vite server，prod 下走 build 产物里的相对路径），
//    不返回 file:// 硬编码，避免打包后跨平台路径分隔符问题（工单硬性要求）。
import { contextBridge, ipcRenderer } from 'electron'
import type { StoredProfile } from './storage'

// 三状态动画的联合类型，与主进程、渲染进程共用同一约定
export type PetState = 'idle' | 'blink' | 'happy'

// 反向类型：让渲染进程侧 import 时也能引用到 StoredProfile（与主进程定义保持一致）
export type { StoredProfile }

// 反向类型：定义 setup 渲染流程完成时提交给主进程的 profile 形状
export interface ProfilePayload {
  email: string
  nickname: string
  mbti: string
  subtype: 'stable' | 'sensitive'
  createdAt: string
}

/** 当前窗口角色；主进程启动 BrowserWindow 时通过 additionalArguments 注入 */
function currentRole(): 'pet' | 'panel' | 'setup' | 'unknown' {
  // 主进程会用 additionalArguments 注入 --petibi-role=<role>
  for (const arg of process.argv) {
    const m = /^--petibi-role=(pet|panel|setup)$/.exec(arg)
    if (m) return m[1] as 'pet' | 'panel' | 'setup'
  }
  return 'unknown'
}

const ROLE = currentRole()

/**
 * 从 process.argv 同步提取主进程注入的 --server-url=http://host:port。
 * - main 进程在 BrowserWindow 创建前已完成 startServerInMain()，
 *   把最终 host:port 通过 additionalArguments 写入 process.argv；
 * - 兜底：未传时回退 localhost:8787（与旧 VITE_API_BASE_URL 默认对齐）。
 */
function readServerUrlFromArgv(): string {
  for (const arg of process.argv) {
    const m = /^--server-url=(.+)$/.exec(arg)
    if (m) return m[1]
  }
  return 'http://127.0.0.1:8787'
}

/** server info 同步版（用于 client.ts 顶层 BASE_URL 初值） */
const SERVER_BASE_URL = readServerUrlFromArgv()

// 暴露给 window.petApi 的方法集合（pet / setup 窗用到）
const petApi = {
  // ===== M1 桌宠 API（沿用） =====
  /** 请求主进程把窗口按屏幕坐标增量 (dx, dy) 移动（拖拽用） */
  drag: (dx: number, dy: number): void => {
    ipcRenderer.send('pet:drag', dx, dy)
  },
  /** 请求主进程弹出"切换动画状态"的右键菜单 */
  showMenu: (): void => {
    ipcRenderer.send('pet:menu')
  },
  /** 订阅主进程右键菜单选中的新状态（回调参数为 idle / blink / happy）。
   *  M4 简化后菜单不再切动画状态，但保留 IPC 通道与回调，方便后续扩展；
   *  当前无主进程发送方，订阅不会触发任何回调。 */
  onSetState: (callback: (state: PetState) => void): void => {
    ipcRenderer.on('pet:set-state', (_event, state: PetState) => callback(state))
  },
  /** 把渲染进程当前状态回告主进程（M4 简化后已无消费者——菜单不再勾选状态）。
   *  保留 IPC 通道以避免破坏旧渲染端，但主进程不再做任何处理。
   *  后续若需主进程感知动画状态，再启用。 */
  notifyState: (_state: PetState): void => {
    // 显式 no-op：不再发 'pet:state-changed' 到主进程（无处理函数）
  },

  // ===== M3 桌宠交互层新增（仅 pet 窗有实际意义） =====
  /** 单击桌宠（位移 <5px）→ 通知主进程打开主面板 */
  openPanel: (): void => {
    if (ROLE !== 'pet') return
    ipcRenderer.send('pet:open-panel')
  },
  /** 右键菜单"隐藏桌宠" → 主进程隐藏 pet 窗，留下托盘 */
  hidePet: (): void => {
    if (ROLE !== 'pet') return
    ipcRenderer.send('pet:hide')
  },
  /** 订阅主进程发来的"桌宠被显示/隐藏"事件（用于切动画状态，桌宠隐藏时无需更新 DOM） */
  onPetHidden: (callback: (hidden: boolean) => void): void => {
    ipcRenderer.on('pet:visibility', (_event, hidden: boolean) => callback(hidden))
  },
  /**
   * M4 工单 A4 快捷菜单：桌宠单击改为弹气泡菜单（不再直接 openPanel），
   * 菜单里"跟我对话"/"主面板"/"隐藏桌宠"三选项各自通过 IPC 通知主进程。
   */
  quickActionChat: (): void => {
    if (ROLE !== 'pet') return
    ipcRenderer.send('pet:quick-chat')
  },
  quickActionPanel: (): void => {
    if (ROLE !== 'pet') return
    ipcRenderer.send('pet:quick-panel')
  },
  quickActionHide: (): void => {
    if (ROLE !== 'pet') return
    ipcRenderer.send('pet:hide')
  },
  /**
   * 主进程通知 pet 渲染进程打开 / 关闭快捷菜单气泡。
   * 快捷菜单 A4：单击桌宠 → pet 渲染进程显示气泡；点菜单外区域 → pet 渲染进程隐藏。
   */
  onQuickMenuVisibility: (callback: (visible: boolean) => void): void => {
    ipcRenderer.on('pet:quick-menu-visibility', (_event, visible: boolean) => callback(visible))
  },
  /**
   * M4 工单 A3 访客模式：panel 在锁屏点击"去登录"→ 通知主进程拉起 setup 窗。
   * 与 enterGuest（LoginPage 用）方向相反：从 panel 出发打开 setup。
   */
  openSetup: (): void => {
    ipcRenderer.send('panel:open-setup')
  },
  /**
   * M4 重测人格：从"我的"Tab 触发 → 通知主进程打开一个 retest 模式的 setup 窗
   * （跳过 login / nickname 步骤，直接进入 pick / test）。
   * 与 openSetup 不同：openSetup 走首次注册流程，openSetupRetest 携带已登录态。
   */
  openSetupRetest: (): void => {
    ipcRenderer.send('panel:open-setup-retest')
  },
  /**
   * M4 重测人格：setup 窗（retest 模式）在用户完成选人格 / 测试后通知主进程，
   * 携带新人格与细分类型；主进程负责写 profile.json + 广播 sprite 切换 + 关 setup 窗。
   * 不走 completeSetup（completeSetup 会拉起 pet 窗，但 pet 窗已存在 → 重复创建）。
   */
  notifyRetestComplete: (payload: { mbti: string; subtype: 'stable' | 'sensitive' }): void => {
    ipcRenderer.send('setup:retest-complete', payload)
  },
  /**
   * M4 重测人格：pet 渲染进程启动期 / 重测完成后读一次当前 mbti，
   * 用于动态拼 sprite 路径（resources/sprites/<mbti>/<frame>.png）。
   * 默认 'intj' 在 src/App.tsx 里兜底——但启动期拿真值更稳。
   */
  getCurrentMbti: (): Promise<string> => {
    return ipcRenderer.invoke('pet:get-mbti')
  },
  /**
   * M4 重测人格：订阅主进程广播的 sprite 切换事件（pet:sprite-change）。
   * 回调参数为新人格 MBTI（已通过 16 型白名单校验）。
   * 桌宠 App 收到后立即换 sprite 路径，无需重启应用。
   */
  onSpriteChange: (callback: (mbti: string) => void): void => {
    ipcRenderer.on('pet:sprite-change', (_event, mbti: string) => callback(mbti))
  },

  // ===== T3 工单：自绘标题栏需要 IPC（最小化 / 关闭窗口）=====
  /**
   * setup 窗标题栏"最小化"按钮：通知主进程 minimize 当前 setup 窗。
   * 仅 setup 窗可调（其他窗调无副作用，role 守卫过滤）。
   */
  minimizeSetup: (): void => {
    if (ROLE !== 'setup') return
    ipcRenderer.send('setup:minimize')
  },
  /**
   * panel 窗标题栏"最小化"按钮：通知主进程 minimize 当前 panel 窗。
   */
  minimizePanel: (): void => {
    if (ROLE !== 'panel') return
    ipcRenderer.send('panel:minimize')
  },

  // ===== M2 新增 API（setup 窗用） =====
  /** 读取本地 userData/profile.json；不存在时返回 { token: null, profile: null } */
  getProfile: (): Promise<StoredProfile> => {
    return ipcRenderer.invoke('profile:get')
  },
  /** 写入本地 userData/profile.json；主进程负责原子写入 */
  setProfile: (next: StoredProfile): Promise<{ ok: true }> => {
    return ipcRenderer.invoke('profile:set', next)
  },
  /** setup 流程完成，通知主进程关 setup 窗、开 pet 窗 */
  completeSetup: (): void => {
    ipcRenderer.send('setup:complete')
  },
  /**
   * M4 P2-025 Bug 2 修复：老用户登录完成 → pet + panel 双开。
   * 区别于 completeSetup 的仅 pet：老用户已熟悉产品，登录后桌面宠物应用的"常伴面板"
   * 姿态要求两窗一起出现。LoginPage 检测 user.mbti 已存在 → 走本接口。
   * 主进程 IPC: setup:complete-existing-user。
   */
  completeSetupForExistingUser: (): void => {
    ipcRenderer.send('setup:complete-existing-user')
  },
  /**
   * M4 工单 A3 访客模式：用户在 LoginPage 点"先逛逛" →
   * 通知主进程写 guest 标志 + 关 setup 窗、开 pet 窗（绕过完整初始化）。
   */
  enterGuest: (): void => {
    ipcRenderer.send('setup:enter-guest')
  },
  /** 用户主动取消初始化（保留接口，目前未在 UI 调用） */
  cancelSetup: (): void => {
    ipcRenderer.send('setup:cancel')
  },
  /**
   * 桌宠小图相对 URL：dev 下指向 vite publicDir，prod 下指向打包后的相对资源。
   * 不返回 file:// 硬编码路径，渲染进程 <img src> 直接用这个值。
   */
  spriteUrl: (type: string, frame: 'idle_0' | 'idle_1' = 'idle_0'): string => {
    return `sprites/${type.toLowerCase()}/${frame}.png`
  },

  // ===== M4 内嵌 server：同步取 server baseURL =====
  /**
   * 同步读取主进程注入的 server baseURL（--server-url=http://host:port）。
   * - 渲染进程 client.ts 顶层就能直接调用，无需 await；
   * - 兜底值 'http://127.0.0.1:8787'：当 VITE_USE_MOCK_API=true 时这个值不会被真接口用到；
   * - dev 模式（Vite dev server 渲染）：preload 仍由 Electron 主进程加载，additionalArguments
   *   一样生效；无需特殊处理。
   */
  getServerBaseUrl: (): string => SERVER_BASE_URL,

  /**
   * 异步读取 server info：返回 { host, port, baseURL }。
   * - 用于运行时重读，例如 dev 期间 server 重启 / 端口被顺延后重新确认；
   * - 主进程 IPC: server:get-info。
   */
  getServerInfo: (): Promise<{ host: string; port: number; baseURL: string }> => {
    return ipcRenderer.invoke('server:get-info')
  },
  /**
   * 读取人格形象图（512×512，闭源美术资产）并返回 base64 data URL。
   * M4 海报生成专用：portrait 不在 vite publicDir，渲染进程不能直读，
   * 经主进程 IPC 走 fs 读取后转 data URL 返回。
   * 文件不存在或人格非法时返回 null。
   */
  getPortraitDataUrl: (type: string): Promise<string | null> => {
    return ipcRenderer.invoke('portrait:read', type)
  },
  /**
   * 读取人格 sprite 帧（resources/sprites/<type>/<frame>.png）并返回 base64 data URL。
   * P0-A 修复：百科 Tab 渲染在 panel 窗（panel HTML 位于 out/renderer/panel/index.html），
   *   相对 URL `sprites/<type>/<frame>.png` 会解析到 out/renderer/panel/sprites/...（不存在），
   *   所以百科 / 详情页 / 重测结果页改用本接口走主进程读盘 → data URL，避免路径解析问题。
   * 桌宠窗（pet HTML 位于 out/renderer/index.html）继续用 spriteUrl（路径解析恰好对得上）。
   *  - type 白名单 16 型人格；frame 白名单在主进程侧校验（详见 ALLOWED_SPRITE_FRAMES）；
   *  - 文件不存在 / 人格非法 / 帧非法时返回 null，UI 走"跳过形象图"兜底。
   */
  getSpriteDataUrl: (
    type: string,
    frame: 'idle_0' | 'idle_1' | 'blink_0' | 'blink_1' | 'thinking_0' | 'thinking_1' = 'idle_0',
  ): Promise<string | null> => {
    return ipcRenderer.invoke('sprite:read', { type, frame })
  },
}

// 暴露给 window.panelApi 的方法集合（panel 窗专用）
const panelApi = {
  /** panel 启动期读取本地 profile（token + 人格等），不读 server */
  getInit: (): Promise<{ profile: StoredProfile['profile']; token: string | null }> => {
    return ipcRenderer.invoke('panel:get-init')
  },
  /**
   * M4 工单：把本地 profile.json 覆盖写入（panel 端在 token 失效时调用，
   * 把 token 置 null + 保留 profile 字段；setup 端登录成功后写入带真 token 的 profile）。
   * - 主进程 IPC: profile:set；
   * - 与 setup 端的 window.petApi.setProfile 同源：都是直接走 ipcRenderer.invoke('profile:set', next)；
   * - 返回 {ok:true} 便于上层 await。
   */
  setProfile: (next: StoredProfile): Promise<{ ok: true }> => {
    return ipcRenderer.invoke('profile:set', next)
  },
  /** panel 关闭按钮：通知主进程隐藏面板（不销毁，方便下次唤回更快） */
  hidePanel: (): void => {
    if (ROLE !== 'panel') return
    ipcRenderer.send('panel:hide')
  },
  /** panel 由外部（桌宠）唤起时收到通知，便于拉取最新配额或切回对话 Tab */
  onPanelShown: (callback: () => void): void => {
    ipcRenderer.on('panel:shown', () => callback())
  },
  /**
   * 切到指定 Tab（外部唤回 / 快捷菜单"跟我对话"用）。
   * 通过 IPC send 让主进程把事件转发给 panel 渲染进程；
   * 与 onPanelShown 不同的是携带 target 参数，决定切到哪个 Tab。
   */
  onPanelTabRequest: (callback: (target: 'chat' | 'baike' | 'community' | 'profile') => void): void => {
    ipcRenderer.on('panel:switch-tab', (_event, target) => callback(target))
  },
  /**
   * 主进程转发给 panel 渲染进程："切到对话 Tab"。
   * 快捷菜单 A4 实现：主进程在用户点"跟我对话"时把该信号转发给 panel。
   */
  onPanelSwitchToChat: (callback: () => void): void => {
    ipcRenderer.on('panel:switch-to-chat', () => callback())
  },
  /**
   * 主进程通知 panel："用户已被引导到登录页 / 初始化流程"。
   * guest 模式 A3 用：用户点"开始测试"/"登录"时由 setup 窗通知 panel 收起。
   */
  onPanelExitGuest: (callback: () => void): void => {
    ipcRenderer.on('panel:exit-guest', () => callback())
  },
  /**
   * M4 重测人格：主进程在用户完成重测写回 profile.json 后广播此事件，
   * panel 收到后应 refetch getMe（让「我的」Tab 的 mbti/subtype/animal 字段立即更新）。
   */
  onProfileChanged: (callback: () => void): void => {
    ipcRenderer.on('panel:profile-changed', () => callback())
  },
  /**
   * 读 16 人格百科数据：通过主进程读 data/encyclopedia/<type>.json，避免渲染进程直读。
   * 渲染进程不在 vite publicDir，无法 fetch 仓库根 data/。
   */
  readEncyclopedia: (type: string): Promise<unknown | null> => {
    return ipcRenderer.invoke('encyclopedia:read', type)
  },
  /** 读 data/encyclopedia/index.json（人格列表） */
  readEncyclopediaIndex: (): Promise<unknown | null> => {
    return ipcRenderer.invoke('encyclopedia:index')
  },
  /** 写入访客模式标记（userData/guest.json） */
  setGuestFlag: (value: boolean): Promise<{ ok: true }> => {
    return ipcRenderer.invoke('guest:set', value)
  },
  /** 读取访客模式标记 */
  getGuestFlag: (): Promise<{ isGuest: boolean }> => {
    return ipcRenderer.invoke('guest:get')
  },
  /**
   * M4 P2-025 登录门禁：「我的」Tab 点「退出登录」按钮 → 通知主进程执行退出链路：
   *   - 清本地 token（保留 profile 字段便于 UX）
   *   - 隐藏桌宠
   *   - 打开 setup 登录窗
   * 主进程 IPC: panel:logout。
   * 一次性动作，渲染进程不需要 await 返回值。
   */
  logout: (): void => {
    ipcRenderer.send('panel:logout')
  },
  /**
   * M4 P2-025 登录门禁：token 失效（任意接口 401）→ 通知主进程执行与 logout 等价的
   * "隐藏桌宠 + 打开登录页"动作。本地 token 清理由 panel 端 setAuthInvalidHandler
   * 负责（避免主进程与 panel 写竞态）。
   * 主进程 IPC: panel:auth-expired。
   */
  notifyAuthExpired: (): void => {
    ipcRenderer.send('panel:auth-expired')
  },
}

// 暴露给 window.role 供渲染进程自检（仅调试用，prod 可保留无害）
const roleMeta = { role: ROLE }

// 以 contextBridge 挂到 window 上：
//   window.petApi   — 桌宠 / setup 窗共用
//   window.panelApi — 主面板窗专用
//   window.roleMeta — 当前窗口角色
contextBridge.exposeInMainWorld('petApi', petApi)
contextBridge.exposeInMainWorld('panelApi', panelApi)
contextBridge.exposeInMainWorld('roleMeta', roleMeta)

// 导出类型供渲染进程 d.ts 引用
export type PetApi = typeof petApi
export type PanelApi = typeof panelApi
export type RoleMeta = typeof roleMeta