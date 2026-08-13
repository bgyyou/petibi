// 【文件说明】服务器端 vitest 配置：仅跑 server/tests/ 下的用例，使用 node 环境，纯逻辑无 DOM 依赖
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    server: {
      deps: {
        external: ["node:sqlite", "sqlite"],
      },
    },
  },
})