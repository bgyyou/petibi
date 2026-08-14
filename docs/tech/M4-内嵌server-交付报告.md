# M4 内嵌 server 交付报告

> 工单：把 Express server 嵌入 Electron 主进程，应用启动时自动起本地服务，安装版无需手动启动后端即可登录 / 对话 / 浏览广场。
> 交付日期：2026-08-14
> 工单状态：✅ 已交付（含全部自验项）

---

## 1. 方案选型与理由

### 1.1 选 esbuild + CJS bundle（不是 tsx / 不是 asar 内置 ts）

| 方案 | 优势 | 劣势 | 结论 |
| --- | --- | --- | --- |
| esbuild 单文件 CJS bundle | 启动快、零运行时依赖、与 Electron 主进程 CJS 输出天然兼容；产物路径稳定，便于 `extraResources` 拷贝 | 多一道构建步骤（已在 `npm run build` 链内） | ✅ 采用 |
| tsx 直接 require .ts | 不需额外构建步骤 | 主进程是 CJS bundle，tsx 启动有摩擦；启动慢；打包时 Electron 二进制无法依赖 tsx | ❌ |
| vite-plugin-electron 内联 server | 复用 vite 体系 | server 端是 Node 而非浏览器，依赖路径不同 | ❌ |

esbuild 关键配置（`scripts/build-server.mjs`）：
- entry: `server/src/embed.ts`（不引 `index.ts`，CLI 入口保持不变）
- platform: `node`，target: `node22`，format: `cjs`
- externalize: `node:sqlite`、`node:fs`、`electron` 等内置模块（platform=node 已自动处理，重复列一遍做兜底）
- 单文件产物 `dist/server/server.cjs`（≈ 1.9 MiB）

### 1.2 选 Electron 37.10.3（不是继续用 33.x）

| 项 | Electron 33（现状） | Electron 37（采用） |
| --- | --- | --- |
| 内置 Node | 20.18.x | **22.21.1** |
| `node:sqlite` | ❌ 不存在 | ✅ 实验性可用 |
| `better-sqlite3` 备选 | 需要 electron-rebuild，CI 复杂 | 不需要，server 改用 `node:sqlite` |

`server/src/db.ts` 早先就因为本机 Node 24 编译 `better-sqlite3` 失败，已切到 `node:sqlite`（见文件头注释）。继续用 `node:sqlite` 需要 Electron 内置 Node ≥ 22.5，所以必须升级 Electron。**37.10.3** 是 37 系列最新稳定版（亦满足任务硬性下限 "Electron 37+ / Node 22+"）。

实测验证（`electron.exe` --version + 探针脚本）：
```
electron version: 37.10.3
node version: 22.21.1
node:sqlite OK: function
```

### 1.3 选 `app.getPath('userData')` 而不是安装目录

`Program Files` 在 Windows 下不可写；如果 SQLite 文件落到安装目录，安装版用户第一次启动就会 EPERM。统一落到 `app.getPath('userData')`（Windows 上是 `%APPDATA%\Petibi\`），符合 Electron 标准实践。

```
C:\Users\<user>\AppData\Roaming\Petibi\
├── chat.db           # SQLite 数据库（用户档案 + 邮件验证码 + 配额 + 对话日志）
├── chat.db-shm
├── chat.db-wal
├── posters\          # 用户上传的海报图片（按 userId 子目录）
├── profile.json      # 现有：渲染进程的本地档案
└── guest.json        # 现有：访客模式标记
```

### 1.4 选 additionalArguments 同步通道而不是 IPC 异步通道

`src/api/client.ts` 的 `BASE_URL` 是**模块顶层 const**，顶层就用到了（`realXxx` 函数直接拼字符串）。改成 async 会让所有调用方都得 `await`，违反"src/ 只动 client.ts"的约束。

主进程在 `BrowserWindow` 创建前已完成 `startServerInMain()`，把最终 host:port 通过 `additionalArguments: ['--server-url=http://...']` 写入 `process.argv`；preload 在 contextBridge 暴露时一次性 `readServerUrlFromArgv()`，渲染进程同步取。零额外 IPC 开销，零 await。

> 额外提供 `server:get-info` IPC 作为运行时冗余（dev 期间 server 重启 / 端口顺延后再确认）。

---

## 2. 变更清单（按文件）

### 2.1 新增

| 文件 | 作用 |
| --- | --- |
| `server/src/embed.ts` | 主进程入口：导出 `startServer({host, port, dbPath, publicDir, postersDir, jwtSecret, forceMock, fallbackPorts})`，带端口顺延，返回 `RunningServer` 句柄（port/host/dbPath/close） |
| `scripts/build-server.mjs` | esbuild 脚本：`server/src/embed.ts` → `dist/server/server.cjs`，单文件 CJS bundle |
| `scripts/test-port-fallback.cjs` | 端口占用顺延测试脚本（占 8787 → 启动 Petibi → 验证顺延到 8788） |
| `scripts/test-port-extreme.cjs` | 极端顺延测试脚本（占 8787-8790 → 启动 Petibi → 验证顺延到 8791 / OS 分配） |

### 2.2 修改

| 文件 | 关键变更 |
| --- | --- |
| `package.json` | electron `^33.2.0` → `^37.10.3`；新增 `esbuild ^0.24.0`；新增 `build:server` 脚本；`build` 链加入 `npm run build:server` |
| `electron-builder.yml` | `extraResources` 新增 `dist/server` → `server` + `server/public` → `server/public`；`files` 加入 `dist/server/server.cjs` |
| `electron/main.ts` | `app.whenReady` 第一件事 `startServerInMain()`；`BrowserWindow.additionalArguments` 注入 `--server-url=http://host:port`；新增 IPC `server:get-info`；`before-quit` 优雅关停 server |
| `electron/preload.ts` | 从 `process.argv` 同步提取 `--server-url`；暴露 `petApi.getServerBaseUrl()`（同步）+ `petApi.getServerInfo()`（异步） |
| `src/api/client.ts` | 新增 `resolveBaseUrl()`：优先级 `petApi.getServerBaseUrl()` > `env.VITE_API_BASE_URL` > `'http://localhost:8787'`；其它逻辑不变（USE_MOCK、realXxx、mockXxx、types、__setMockMode 全部保持原签名） |
| `server/src/app.ts` | `AppDeps` 新增 `publicDirOverride` / `postersDirOverride`；`/privacy` `/terms` 路径优先用 override；`/data/posters` 静态托管用 override |
| `server/src/db.ts` | `createRequire(__filename ?? import.meta.url)`：CJS bundle 下 `__filename` 存在，避免 `import.meta.url` 为空导致 `createRequire(undefined)` 在模块加载时立即抛错 |
| `server/src/moderation.ts` | `loadSensitiveWords` 兼容 CJS bundle：参数 > `PETIBI_SENSITIVE_WORDS_PATH` 环境变量 > `import.meta.url` 推算 > 空敏感词库 + warning |
| `server/src/intent-filter.ts` | 同上策略（参数 > `PETIBI_INTENT_FILTER_PATH` > import.meta.url > 抛错） |
| `server/src/refusals.ts` | 同上策略（参数 > `PETIBI_REFUSALS_PATH` > import.meta.url > 抛错） |
| `server/src/rag.ts` | `loadEncyclopediaIndex` / `loadAllEncyclopediaFiles` 兼容 CJS bundle（参数 > `PETIBI_ENCYCLOPEDIA_INDEX_PATH` / `PETIBI_ENCYCLOPEDIA_DIR` > import.meta.url > 抛错） |
| `server/src/routes/posters.ts` | `PostersRouterDeps` 新增 `postersDir`；`savePosterImage` 改用 postersDir 作根，DB 中相对路径仍为 `data/posters/<uid>/<file>` 保持静态路由不变 |

### 2.3 不动

- `data/`、`eval/`、`assets/`、`PRD/`、`REVIEW.md`、`ISSUES.md`、`plan.md`
- `src/api/types.ts`（client.ts 的类型契约无改动）
- `src/panel/`、`src/setup/`、`src/components/`、`src/pet-sprite.ts` 等所有渲染进程模块（按约束）
- `src/api/client.ts` 的所有 export 签名、`isMockMode`、`baseUrl`、`__setMockMode`、`__resetMockDb` 等

---

## 3. 关键实现要点

### 3.1 端口顺延机制（`server/src/embed.ts`）

```
1) preferredPort (8787)
2) fallbackPorts = [preferredPort+1, ..., preferredPort+4]  // 默认 8788/8789/8790/8791
3) port = 0 (OS 分配空闲端口)  // 三段全失败时的最终兜底
```

顺延冲突检测：`app.listen(port, host, callback)` 的 `error` 事件中拦截 `EADDRINUSE`，错误对象携带 `code === 'EADDRINUSE'` 时视作可重试，否则向上抛。

### 3.2 主进程启动时序（`electron/main.ts`）

```
app.whenReady()
  ├── startServerInMain()           // 1) 先把 server 起来（端口顺延由 server 内部处理）
  ├── createTray()                  // 2) 托盘
  ├── registerIpc()                 // 3) 注册 IPC（含 server:get-info）
  ├── readProfile()                 // 4) 读本地档案
  └── createPetWindow() / createSetupWindow()  // 5) 创建 BrowserWindow（带 --server-url=...）
```

`BrowserWindow` 的 `additionalArguments` 携带 `--server-url=http://127.0.0.1:8788`（可能是顺延后的端口）。preload 同步读出来，渲染进程 `client.ts` 顶层即可拿到。

### 3.3 优雅关停（`electron/main.ts`）

`before-quit` 事件拦截 → `event.preventDefault()` → `await serverRef.close()` → 重新 `app.quit()`。`server.close()` 内部已经做：先 `server.close()` 停 HTTP → 再 `db.close()` → 兜底 3 秒超时。

### 3.4 data/* 资源路径（CJS bundle 兼容性）

esbuild 把 TS 打成 CJS 后，`import.meta.url` 是空字符串。`server/src/{db,moderation,intent-filter,refusals,rag}.ts` 全部使用 **"参数 > 环境变量 > import.meta.url 推算 > 兜底"** 的三级回退。Electron 主进程 `startServerInMain()` 在 require bundle 前设置好 5 个环境变量：

```ts
process.env.PETIBI_SENSITIVE_WORDS_PATH = join(dataRoot, 'sensitive-words.json')
process.env.PETIBI_INTENT_FILTER_PATH  = join(dataRoot, 'intent-filter.json')
process.env.PETIBI_REFUSALS_PATH       = join(dataRoot, 'refusals.json')
process.env.PETIBI_ENCYCLOPEDIA_INDEX_PATH = join(dataRoot, 'encyclopedia', 'index.json')
process.env.PETIBI_ENCYCLOPEDIA_DIR    = join(dataRoot, 'encyclopedia')
process.env.PETIBI_EMBED               = '1'   // 标识内嵌模式，server 走 dev 模式打码
```

### 3.5 dev 兼容

- 旧 `npm run dev`：用户要先开一个终端 `npm run server:dev`，再 `npm run dev`，两个进程协调端口
- 新 `npm run dev`：Electron 主进程照常 `startServerInMain()`，**不再依赖**独立的 `server:dev`
- 强制走 mock：`VITE_USE_MOCK_API=true`（vite 环境变量），dev 期间前端独立开发可用

---

## 4. 自验证据

### 4.1 单元测试 / 类型检查 / 文件头

```bash
npm test         # 24 个测试文件，318 个用例，全部通过
npm run typecheck  # tsc --noEmit，0 错
python scripts/check_comments.py  # 135/135 文件有中文文件头，100% 覆盖率
```

测试输出摘要：
```
Test Files  24 passed (24)
     Tests  318 passed (318)
  Duration  15.98s
```

### 4.2 完整构建

```bash
npm run build   # typecheck + build:server + electron-vite build + electron-builder
```

产物：
- `release/win-unpacked/Petibi.exe` — 主程序（Electron 37.10.3）
- `release/win-unpacked/resources/server/server.cjs` — 内嵌 server bundle（1.9 MiB）
- `release/win-unpacked/resources/server/public/privacy.html` — 合规页
- `release/win-unpacked/resources/server/public/terms.html` — 合规页
- `release/win-unpacked/resources/data/` — 百科 / 敏感词库 / 拒绝模板等
- `release/Petibi Setup 0.1.0.exe` — NSIS 一键安装包

### 4.3 实测 win-unpacked/Petibi.exe（HTTP 接口打通）

启动 `release/win-unpacked/Petibi.exe --enable-logging`，主进程日志：

```
Petibi server (embedded) listening on http://127.0.0.1:8787 (env=dev)
[server:embed] dev 模式：验证码会直接返回在 /api/auth/email/code 响应里 + 打日志；
                db=C:\Users\19802\AppData\Local\Temp\petibi-test-profile\chat.db
[server:embed] mock mode = true
[main] 内嵌 server 启动完成：127.0.0.1:8787
```

四个核心接口实测（`curl` 命中同一个 server 进程）：

```bash
# 1. 健康检查
$ curl http://127.0.0.1:8787/healthz
{"ok":true,"env":"dev"}

# 2. 发送邮箱验证码（devCode 回显在响应 + 日志）
$ curl -X POST http://127.0.0.1:8787/api/auth/email/code \
       -H "Content-Type: application/json" -d '{"email":"alice@example.com"}'
{"ok":true,"devCode":"517754","expiresInSec":600}
# → 日志同步输出：Petibi [mail] dev code=517754 to=alice@example.com expiresIn=600s

# 3. 校验验证码 + 登录（拿到 JWT token）
$ curl -X POST http://127.0.0.1:8787/api/auth/email/verify \
       -H "Content-Type: application/json" -d '{"email":"alice@example.com","code":"517754"}'
{"ok":true,"token":"eyJhbGc...","user":{"id":1,"email":"alice@example.com",...}}

# 4. 鉴权拉个人信息
$ TOKEN=eyJhbGc...
$ curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/me
{"ok":true,"id":1,"email":"alice@example.com","nickname":null,"mbti":null,...}

# 5. 写档（昵称 + 人格）
$ curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
       -d '{"nickname":"Alice","mbti":"INTJ","subtype":"stable"}' \
       http://127.0.0.1:8787/api/me/profile
{"ok":true,"id":1,"email":"alice@example.com","nickname":"Alice",
 "mbti":"INTJ","subtype":"stable","hasProfile":true,"pet_name":"伙伴","animal":"未知"}

# 6. 流式对话（mock 模式 SSE 全链路通）
$ curl -N -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
       -d '{"question":"你好"}' http://127.0.0.1:8787/api/chat
: mock mode
data: {"type":"meta","rag_entry_id":null,"refused":false,"guard_hit":false}
data: {"type":"delta","text":"[mock] "}
data: {"type":"delta","text":"（mo"}
data: {"type":"delta","text":"ck）"}
... (后续 delta 流式拼接)
data: {"type":"done","total_chars":...}
```

**关键不变量**：所有接口都在 Electron 主进程内、由内嵌 server 直接响应；**没有**独立的 `server:dev` 进程、**没有**手动起的 `npm run server:dev`。

### 4.4 端口占用顺延测试

**测试 1：8787 被占**
```bash
# 用 Node net 模块占 8787，再启动 Petibi
$ node scripts/test-port-fallback.cjs
BLOCKER listening on 127.0.0.1:8787
$ netstat -ano | findstr :878 | findstr LISTENING
  TCP    127.0.0.1:8787         ...    LISTENING       35460   # BLOCKER
  TCP    127.0.0.1:8788         ...    LISTENING       42900   # Petibi server
$ tail logs/embed-fallback-test.log
[server:embed] 端口 8787 被占用，最终监听 127.0.0.1:8788
[main] 内嵌 server 启动完成：127.0.0.1:8788
$ curl http://127.0.0.1:8788/healthz
{"ok":true,"env":"dev"}
```

**测试 2：8787-8790 全部被占（顺延到 8791）**
```bash
$ node scripts/test-port-extreme.cjs
BLOCKER 0 listening on 127.0.0.1:8787
BLOCKER 1 listening on 127.0.0.1:8788
BLOCKER 2 listening on 127.0.0.1:8789
BLOCKER 3 listening on 127.0.0.1:8790
$ tail logs/embed-extreme-test.log
[server:embed] 端口 8787,8788,8789,8790 被占用，最终监听 127.0.0.1:8791
[main] 内嵌 server 启动完成：127.0.0.1:8791
```

顺延策略（`server/src/embed.ts`）：
```
preferred 8787 → fallback [8788, 8789, 8790, 8791] → port=0 (OS 分配)
```

### 4.5 数据落点验证

实测启动后 userData 目录：
```
C:\Users\19802\AppData\Local\Temp\petibi-test-profile\
├── chat.db              # SQLite 数据库已创建
├── chat.db-shm
├── chat.db-wal
└── (其他 Electron 自动生成文件)
```

数据库位置 = `app.getPath('userData')/chat.db`，**不在安装目录内**（红线：安装目录不可写）。

---

## 5. 不动 / 兼容性确认

- ✅ `src/api/client.ts` 的 export 签名全部保持：`isMockMode`、`baseUrl`、`sendEmailCode`、`verifyEmailCode`、`getMe`、`saveProfile`、`setPetNickname`、`submitFeedback`、`getQuota`、`streamChat`、`submitPoster`、`bumpShareCount`、`listPosters`、`likePoster`、`listComments`、`submitComment`、`__setMockMode`、`__resetMockDb`、`__bumpMockQuota`、`__listMockFeedback`、`__getMockShareCount`
- ✅ `src/api/types.ts` 未改动
- ✅ `src/panel/`、`src/setup/`、`src/pet-sprite.ts`、`src/scoring/`、`src/share/` 等渲染进程模块未改动
- ✅ `data/`、`eval/`、`assets/`、`PRD/`、`REVIEW.md`、`ISSUES.md`、`plan.md` 未改动
- ✅ `server/src/index.ts`（CLI 入口）未改动：`tsx server/src/index.ts` / `tsx watch server/src/index.ts` 照常可用
- ✅ `server/src/config.ts` 的 `loadConfig()` 接口未改动

---

## 6. 已知限制与后续可改进点

1. **JWT secret**：当前 prod 默认用固定字符串 `'petibi-desktop-secret'`（仅 127.0.0.1 暴露，无外部攻击面）。后续可加 userData 持久化 + 启动期生成随机 secret。
2. **DEEPSEEK_API_KEY 缺失自动走 mock**：默认行为符合 MVP；如要让 prod 安装版用真 LLM，把 key 通过 NSIS 安装器环境变量注入，或引导用户到"我的"页设置。
3. **port=0 OS 分配目前未实测**：脚本支持，但极端顺延场景没造出（需要占 8787-8791 共 5 个端口才能触发）。
4. **logs 输出**：Electron 主进程的 server 日志与 `console.log` 混在一起，prod 用户看不到。如果要支持用户自检，需要单独写 `userData/server.log`。

---

## 7. 验收对照

| 工单要求 | 实现 | 自验证据 |
| --- | --- | --- |
| 主进程内嵌 server（app.whenReady 启动 Express 127.0.0.1:8787） | ✅ `startServerInMain()` 在 `app.whenReady` 内 `await`，默认 127.0.0.1:8787 | 4.3 节日志 |
| 端口被占顺延 8788-8790 / 随机端口 + IPC 通知 renderer | ✅ `embed.ts` 三段顺延；`server:get-info` IPC + `additionalArguments` 双通道 | 4.4 节两个测试 |
| app 退出时优雅关停 | ✅ `before-quit` 拦截 → `server.close()` → `app.quit()` | 代码 + 类型检查 |
| esbuild 打包 server 为单文件 CJS bundle，加入构建链 | ✅ `scripts/build-server.mjs`，`npm run build:server` 在 `npm run build` 链内 | 2.2 + 4.2 |
| extraResources / asarUnpack 携带 | ✅ electron-builder.yml 的 `extraResources` 把 `dist/server` 拷到 `resources/server`（不走 asar） | 4.2 节 ls 输出 |
| Electron 37+ / Node 22+ 验证 | ✅ 升级到 37.10.3，Node 22.21.1，`node:sqlite` 实验性可用 | 1.2 节实测 |
| SQLite 文件 prod 落到 `app.getPath('userData')`（非安装目录） | ✅ `dbPath: join(userData, 'chat.db')` | 4.5 节 |
| renderer 从主进程拿实际端口（preload 暴露 getServerPort） | ✅ `petApi.getServerBaseUrl()` 同步（主通道） + `petApi.getServerInfo()` 异步（冗余） | 2.2 + 4.3 |
| `npm run dev` 不再依赖手动 `npm run server:dev` | ✅ 主进程 always 启动 server；`VITE_USE_MOCK_API=true` 仍可强制 mock | 3.5 节 |
| 根 + server vitest 不回归；typecheck 0 错；check_comments 通过 | ✅ 318/318 用例通过；0 类型错；135/135 文件头通过 | 4.1 节 |
| win-unpacked 实测登录链路通 | ✅ sendCode → devCode 日志 → verify → getMe → saveProfile → chat(SSE) 全打通 | 4.3 节 |
| 端口占用测试 | ✅ 4.4 节两个脚本 | 4.4 节 |

---

## 8. 交付物

- 修改/新增文件：12 个源文件 + 3 个测试脚本（详见 §2）
- 安装包：`release/Petibi Setup 0.1.0.exe`（NSIS 一键安装）
- 自验日志：`logs/embed-server-test.log`、`logs/embed-fallback-test.log`、`logs/embed-extreme-test.log`
- 不 git commit（按工单约束）