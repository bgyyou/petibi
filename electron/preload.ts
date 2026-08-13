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