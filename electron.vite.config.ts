// 【文件说明】electron-vite 构建配置：
//   主进程 / 预加载 / 渲染进程三个子工程，渲染进程含三个 HTML 入口（桌宠 + setup + 主面板）
//   resources/ 作为 publicDir：sprite 在 dev 下以 /sprites/... 访问，
//   打包时原样拷贝进 out/renderer/sprites/...
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * M5 修复（P0-A 根因加固）：渲染端 bundle 不能包含任何 vitest 测试代码。
 *
 * 之前 src/App.tsx 反向 import 了 `__tests__/decideClickSequence.test.ts`，
 * 导致 vite/rollup 把整条 vitest 依赖链打进 `index-*.js`，安装版运行时
 * React mount 阶段直接抛 "Vitest failed to access its internal state"，
 * 根容器永远空着，pet 窗 BrowserWindow 存在但全透明不可见。
 *
 * 双重保护：
 *   1. 主修复：纯函数搬到 `src/decideClickSequence.ts`（非 __tests__/），
 *      App.tsx 改为从这里 import，避免反向 import __tests__；
 *   2. 本 plugin（兜底）：拦截 rollup 在生产 build 时拿到任何「__tests__/ 或 *.test.ts」
 *      模块路径立刻抛错——CI 立刻发现误用，而不是默默把 vitest 打进生产 bundle。
 *      dev 模式（vite dev server）不装此 plugin，避免开发体验被破坏（vitest 测试可照常跑）。
 */
const TEST_FILE_PATTERN = /[\\/]__tests__[\\/]|\.test\.(ts|tsx)$/

function noTestInBundlePlugin(): Plugin {
  return {
    name: 'petibi:no-test-in-renderer-bundle',
    apply: 'build' as const,
    enforce: 'pre' as const,
    resolveId(source: string): string | null {
      if (TEST_FILE_PATTERN.test(source)) {
        throw new Error(
          `[electron-vite] 测试文件 ${source} 被反向 import 到渲染端代码！` +
            `测试代码只能由 vitest 进程加载，生产 bundle 不允许包含。` +
            `请把纯函数搬到非 __tests__ 目录（如 src/<name>.ts），再让测试 re-import。`,
        )
      }
      return null
    },
  }
}

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
    // 兜底 plugin：拦截反向 import __tests__ 的情况（仅 build 时启用）。
    // dev 模式下不装，避免开发体验被破坏。
    plugins: [react(), noTestInBundlePlugin()],
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