// 【文件说明】预加载 API 的全局类型声明：让渲染进程代码里 window.petApi 有类型提示与编译检查。
// 包含 M1 桌宠 API + M2 setup / profile / sprite + M3 桌宠交互层新增 API（openPanel / hidePet / onPetHidden）。
import type { PetApi, PanelApi, RoleMeta } from '../electron/preload'

declare global {
  interface Window {
    /** 预加载脚本（electron/preload.ts）通过 contextBridge 暴露的统一 API */
    petApi: PetApi
    /** 主面板窗专用 API（其他窗口下访问则方法静默 noop） */
    panelApi: PanelApi
    /** 当前窗口角色元数据，供渲染进程分支判断 */
    roleMeta: RoleMeta
  }
}

// 本文件是纯类型声明模块，需显式导出空对象使其成为模块而非全局脚本
export {}