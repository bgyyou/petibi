// 【文件说明】后端服务统一入口：组合 config + db + mailer + app，监听端口（合并 M2/M3 工单）
//
// 启动流程：
//   1. loadConfig 从 env 读所有可调项（PETIBI_* + DEEPSEEK_*）
//   2. openDb 建 SQLite 连接 + ensureSchema 跑 Schema（含 email_codes / chat_usage / chat_logs）
//   3. createMailer 按 env 选择 dev / prod 实现
//   4. createApp 装配 Express（cors / json / 路由 / 404 / errorHandler）
//   5. app.listen 启动；优雅关停处理 SIGINT / SIGTERM
//
// dev 启动（项目根）：npm run server:dev（tsx watch 自动重载）
// prod 启动（项目根）：npm run server:start（tsx 单次）

import type { Server } from "node:http"
import { fileURLToPath } from "node:url"
import { loadProjectEnv } from "./env.js"
import { loadConfig } from "./config.js"
import { openDb, ensureSchema } from "./db.js"
import { createMailer } from "./mailer.js"
import { createApp } from "./app.js"

// 【M5】CLI 入口第一件事：加载仓库根 .env，把 DEEPSEEK_* / PETIBI_DISABLE_QUOTA 等
// 注入 process.env，让下方 loadConfig() 能读到真实 key（详见 env.ts 头部说明）。
loadProjectEnv()

function main(): void {
  const config = loadConfig()
  const db = openDb(config.dbPath)
  ensureSchema(db)
  const mailer = createMailer(config)
  const app = createApp({ db, config, mailer })

  // 显式声明 host / port，避免 IPv6 vs IPv4 不一致
  const server: Server = app.listen(config.port, config.host, () => {
    console.log(
      `Petibi server listening on http://${config.host}:${config.port} (env=${config.env})`,
    )
    if (config.env === "dev") {
      console.log(
        `[dev] 验证码会直接返回在 /api/auth/email/code 响应里 + 打日志；db=${config.dbPath}`,
      )
    }
    console.log(
      `[server] mock mode = ${!config.llm.apiKey || config.llm.forceMock}`,
    )
  })

  // 优雅关停：先停 HTTP 接收新连接，再关 DB（避免在请求处理中关 DB）
  function shutdown(signal: string): void {
    console.log(`[server] 收到 ${signal}，开始关停...`)
    server.close(() => {
      try {
        db.close()
      } catch (e) {
        console.error("[server] 关闭 db 失败：", e)
      }
      console.log("[server] 已退出")
      process.exit(0)
    })
    // 兜底：5 秒后强退
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

// 仅在作为入口文件执行时跑 main；被 import 时不跑（测试场景）
// 用 require.main === module 在 CJS/ESM 互通上不够稳，这里直接判断 import.meta.url
// 注意：fileURLToPath 在 Windows 上返回带反斜杠的路径，与 process.argv[1]（tsx 透传）做归一化比较
function normalizePath(p: string): string {
  // 去掉 Windows 长前缀 \\?\ 与盘符大小写差异；统一用正斜杠
  return p.replace(/\\/g, "/").replace(/^\/\//, "").toLowerCase()
}
const isEntry =
  process.argv[1] !== undefined &&
  normalizePath(fileURLToPath(import.meta.url)) ===
    normalizePath(process.argv[1])
if (isEntry) {
  main()
}