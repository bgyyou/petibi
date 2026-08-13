// 【文件说明】electron-vite 构建配置：
//   主进程 / 预加载 / 渲染进程三个子工程，渲染进程含三个 HTML 入口（桌宠 + setup + 主面板）
//   resources/ 作为 publicDir：sprite 在 dev 下以 /sprites/... 访问，
//   打包时原样拷贝进 out/renderer/sprites/...
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  // 主进程：入口 electron/main.ts，产物 out/main/main.js（对应 package.json 的 main 字段）
  main: {
    build: {
      // 把 electron/storage.ts 一并打入主进程 bundle
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
    },
  },
  // 预加载脚本：入口 electron/preload.ts，产物 out/preload/preload.js（contextBridge 安全桥）
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
    },
  },
  // 渲染进程（React）：根目录 src/
  renderer: {
    root: resolve(__dirname, 'src'),
    // 把 resources/ 作为静态资源目录：sprite 在 dev 下以 /sprites/... 访问，
    // 打包时原样拷贝进 out/renderer/sprites/...，渲染进程用相对路径引用即可
    publicDir: resolve(__dirname, 'resources'),
    plugins: [react()],
    build: {
      rollupOptions: {
        // 多入口：M1 桌宠窗 + M2 setup 流程窗 + M3 主面板窗，三个 HTML 文件各自独立打 bundle
        input: {
          // 主桌宠（128×128 悬浮窗）
          index: resolve(__dirname, 'src/index.html'),
          // 初始化流程（800×640 普通窗口）
          setup: resolve(__dirname, 'src/setup/index.html'),
          // 主面板（400×600 普通窗口，4 Tab + 对话流式）
          panel: resolve(__dirname, 'src/panel/index.html'),
        },
      },
    },
  },
})