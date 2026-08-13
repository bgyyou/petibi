// 【文件说明】预加载 API 的全局类型声明：让渲染进程代码里 window.petApi 有类型提示与编译检查
import type { PetApi } from '../electron/preload'

declare global {
  interface Window {
    /** 预加载脚本（electron/preload.ts）通过 contextBridge 暴露的桌宠 API */
    petApi: PetApi
  }
}

// 本文件是纯类型声明模块，需显式导出空对象使其成为模块而非全局脚本
export {}
