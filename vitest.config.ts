// 【文件说明】vitest 配置：M2 计分引擎测试 + 合并后 server 测试 + M3 桌宠交互层面板 reducer 测试 +
// M4 海报纯函数测试（distillDeepAnswer / wrapText / familyMainFor 等纯逻辑）。
// 限定只跑 src/scoring/** / src/panel/__tests__/** / src/share/__tests__/** / server/tests/**，
// 不在 src/ 顶层扫 *.test.ts 避免命中 React/渲染进程入口。
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // 计分引擎 + 合并后 server 测试 + M3 面板 chat-reducer 纯函数测试 + M4 海报纯函数测试
    include: [
      "src/scoring/**/*.test.ts",
      "src/panel/__tests__/**/*.test.ts",
      "src/share/__tests__/**/*.test.ts",
      "server/tests/**/*.test.ts",
    ],
    // 纯函数计分引擎与后端集成测试都不需要 DOM；用 node 最稳
    environment: "node",
    // 串行跑后端测试，避免多个 suite 共享 node:sqlite handle 时偶发卡顿
    fileParallelism: false,
  },
})