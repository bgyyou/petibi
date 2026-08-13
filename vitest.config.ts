// 【文件说明】vitest 配置：M2 计分引擎测试用，限定只跑 src/scoring/**。
// 独立于 electron.vite.config.ts，不引入 React/electron plugin，避免被 React JSX / Electron main 模块污染
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // 只跑 src/scoring/ 下的测试文件；不在 src/ 顶层扫 *.test.ts 避免命中 React/渲染进程入口
    include: ["src/scoring/**/*.test.ts"],
    // 纯函数计分引擎不需要 DOM、jsdom、happy-dom；用 node 最稳
    environment: "node",
  },
})
