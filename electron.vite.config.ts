// 【文件说明】electron-vite 构建配置：声明主进程 / 预加载 / 渲染进程三个子工程的入口与输出（M1 工单）
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  // 主进程：入口 electron/main.ts，产物 out/main/main.js（对应 package.json 的 main 字段）
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
    },
  },
  // 预加载脚本：入口 electron/preload.ts，产物 out/preload/preload.js（contextBridge 安全桥）
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
    },
  },
  // 渲染进程（React）：根目录 src/，入口页面 src/index.html
  renderer: {
    root: resolve(__dirname, 'src'),
    // 把 resources/ 作为静态资源目录：sprite 在 dev 下以 /sprites/... 访问，
    // 打包时原样拷贝进 out/renderer/sprites/...，渲染进程用相对路径引用即可
    publicDir: resolve(__dirname, 'resources'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
})
