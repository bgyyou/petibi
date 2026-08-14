// 【文件说明】vitest 配置：M2 计分引擎测试 + 合并后 server 测试 + M3 桌宠交互层面板 reducer 测试 +
// M4 海报纯函数测试（distillDeepAnswer / wrapText / familyMainFor 等纯逻辑）+ M4 初始化
// 流程状态机测试（setupReducer 覆盖 P0-005/P0-006 重选 / 反馈回归）+ M4 右键菜单与重测
// 菜单结构测试（buildPetContextMenuItems / buildTrayMenuItems 纯函数断言） +
// M4 token 失效恢复（src/api/__tests__/client-auth-recovery.test.ts 覆盖 401 钩子 +
// devCode 字段统一 + NetworkError 区分 + 老用户直通 mock）+ M4 收尾修复
// （4 页返回键存在性 + TitleBar 回调链契约）。
// 限定只跑 src/scoring/** / src/setup/__tests__/** / src/components/__tests__/**
// / src/panel/__tests__/** / src/share/__tests__/** / src/api/__tests__/**
// / server/tests/** / electron/__tests__/**，不在 src/ 顶层扫 *.test.ts 避免命中 React/渲染进程入口。
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // 计分引擎 + 合并后 server 测试 + M3 面板 chat-reducer 纯函数测试 + M4 海报纯函数测试 +
    // M4 初始化流程 reducer 状态机测试 + M4 主进程菜单结构测试 + M4 token 失效恢复
    include: [
      "src/scoring/**/*.test.ts",
      "src/setup/__tests__/**/*.test.ts",
      "src/components/__tests__/**/*.test.ts",
      "src/__tests__/**/*.test.ts",
      "src/panel/__tests__/**/*.test.ts",
      "src/share/__tests__/**/*.test.ts",
      "src/api/__tests__/**/*.test.ts",
      "server/tests/**/*.test.ts",
      "electron/__tests__/**/*.test.ts",
    ],
    // 纯函数计分引擎与后端集成测试都不需要 DOM；用 node 最稳
    environment: "node",
    // 串行跑后端测试，避免多个 suite 共享 node:sqlite handle 时偶发卡顿
    fileParallelism: false,
  },
})