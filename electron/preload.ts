// 【文件说明】预加载脚本：通过 contextBridge 向渲染进程暴露最小安全 API。
// 三种窗口共用一份 preload，按当前窗口角色（pet / panel / setup）暴露对应方法：
//   - 桌宠窗（pet）    ：drag / showMenu / onSetState / notifyState（M1 沿用）
//                          + openPanel / hidePet（M3 桌宠交互层新增）
//   - 主面板窗（panel） ：getInit / openChatWithQuestion（panel 启动期读取本地 profile）
//                          + onPanelHidden（关闭按钮回调）
//   - 系统托盘桥（仅主进程消费，无渲染端 API）
//   - setup 窗沿用 M2 的 getProfile / setProfile / completeSetup / cancelSetup / spriteUrl
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
  /** 订阅主进程右键菜单选中的新状态（回调参数为 idle / blink / happy） */
  onSetState: (callback: (state: PetState) => void): void => {
    ipcRenderer.on('pet:set-state', (_event, state: PetState) => callback(state))
  },
  /** 把渲染进程当前状态回告主进程（键盘切换等途径），保证右键菜单单选勾选与实际一致 */
  notifyState: (state: PetState): void => {
    ipcRenderer.send('pet:state-changed', state)
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
  /**
   * 读取人格形象图（512×512，闭源美术资产）并返回 base64 data URL。
   * M4 海报生成专用：portrait 不在 vite publicDir，渲染进程不能直读，
   * 经主进程 IPC 走 fs 读取后转 data URL 返回。
   * 文件不存在或人格非法时返回 null。
   */
  getPortraitDataUrl: (type: string): Promise<string | null> => {
    return ipcRenderer.invoke('portrait:read', type)
  },
}

// 暴露给 window.panelApi 的方法集合（panel 窗专用）
const panelApi = {
  /** panel 启动期读取本地 profile（token + 人格等），不读 server */
  getInit: (): Promise<{ profile: StoredProfile['profile']; token: string | null }> => {
    return ipcRenderer.invoke('panel:get-init')
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