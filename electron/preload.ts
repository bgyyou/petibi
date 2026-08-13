// 【文件说明】预加载脚本：通过 contextBridge 向渲染进程暴露最小安全 API（拖拽 / 右键菜单 / 状态切换订阅），渲染进程不直接接触 Node
import { contextBridge, ipcRenderer } from 'electron'

// 三状态动画的联合类型，与主进程、渲染进程共用同一约定
export type PetState = 'idle' | 'blink' | 'happy'

// 暴露给 window.petApi 的方法集合
const api = {
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
}

// 以 petApi 为名挂到渲染进程全局 window 上（类型声明见 src/pet-api.d.ts）
contextBridge.exposeInMainWorld('petApi', api)

// 导出类型供渲染进程 d.ts 引用
export type PetApi = typeof api
