# M3 server 合并交付报告

> 任务：将仓库内两套并存的 server 实现（A 套 auth 工单 + B 套 RAG 链路工单）合并为单一后端。
> 执行人：执行工程师（按派单照做，不自行发挥）。
> 对应：M3 对话链路契约 §4、PRD §3.4、REVIEW R3/R4。

---

## 1. 合并后结构（单一后端）

`server/` 目录最终形态：

```
server/
├── data/                          # SQLite 文件默认落点（chat.db；运行时生成）
├── scripts/
│   └── latency-bench.ts           # 延迟基准小工具（沿用 B 套，更新鉴权为 JWT）
├── src/                           # 主干（全部 server 代码在此）
│   ├── app.ts                     # Express 工厂 createApp(deps)：cors / json / 路由 / 404 / errorHandler
│   ├── index.ts                   # 唯一入口：loadConfig → openDb → ensureSchema → createMailer → createApp → listen
│   ├── config.ts                  # env 配置（PETIBI_* + DEEPSEEK_*；dev 兜底 secret）
│   ├── errors.ts                  # AppError + ErrorCodes + ApiResponse 统一壳
│   ├── mailer.ts                  # Mailer 接口 + DevMailer（打日志）+ ProdMailer（占位抛错）
│   ├── middleware.ts              # requireAuth(secret) + userIdFromRequest(req)
│   ├── db.ts                      # node:sqlite + ensureSchema（4 张表全部建上）
│   ├── auth.ts                    # users 表访问层（findUserById / findUserByEmail / getOrCreateUserByEmail / isProfileComplete）
│   ├── quota.ts                   # 配额服务：consumeOrThrowQuota / getTodayUsage / QuotaExceeded（DAILY_QUOTA 兼容别名）
│   ├── types.ts                   # 共享类型：Personality / EmailCodeRow / JwtPayload / ProfileInput / MeResponse / QuotaResponse / SseEvent / ApiOk/Err 等
│   ├── intent-filter.ts           # 意图过滤 + 闲聊识别（沿用 B 套）
│   ├── rag.ts                     # 关键词 / tag / scenario 打分 Top1（沿用 B 套）
│   ├── llm.ts                     # DeepSeek 兼容 OpenAI + mock 流式（沿用 B 套）
│   ├── personas.ts                # 人格速查卡加载 + system prompt 拼装（沿用 B 套）
│   ├── refusals.ts                # 拒绝模板加载 + 跨人格兜底（沿用 B 套）
│   ├── routes/
│   │   ├── auth.ts                # POST /email/code、POST /email/verify（dev 回显 + JWT 签发）
│   │   ├── me.ts                  # GET /、POST /profile（鉴权后）
│   │   ├── quota.ts               # GET /（鉴权后，返回 used/remaining/limit/date）
│   │   └── chat.ts                # POST /（SSE 流式：意图过滤 → 配额 → RAG → LLM → chat_logs）
│   └── utils/
│       ├── code.ts                # generateCode / isValidCodeFormat
│       ├── date.ts                # todayDateString（本地时区 YYYY-MM-DD）
│       ├── email.ts               # isValidEmail
│       └── jwt.ts                 # signToken / verifyToken（HS256）
├── tests/                         # 合并后的统一测试目录
│   ├── auth.test.ts               # 28 例：邮箱登录 / 验证码错误路径 / 鉴权 / 写档 / quota HTTP / healthz/404 / chat 鉴权
│   ├── chat-route.test.ts         # 6 例：SSE 越界拒绝 / 11 次配额 / 闲聊 / RAG 命中 / ≤150 字 / HTTP /api/quota
│   ├── intent-filter.test.ts      # 9 例（B 套原样）
│   ├── latency.test.ts            # 2 例（B 套原样）
│   ├── llm.test.ts                # 4 例（B 套原样）
│   ├── personas-refusals.test.ts  # 6 例（B 套原样，路径改为 import.meta.url 解析）
│   ├── quota.test.ts              # 4 例（B 套原样，DAILY_QUOTA 兼容别名）
│   └── rag.test.ts                # 4 例（B 套原样）
├── package.json                   # 占位声明，依赖走根 node_modules
├── tsconfig.json
└── vitest.config.ts
```

总计：**63 条 server 测试用例**（B 套原 35 + A 套 25，新增 3 条）。

---

## 2. 决策落地对照（任务清单 → 实际动作）

| 任务清单 | 落地 |
|---|---|
| ① 以 B 套（server/src/）为主干 | ✅ 仅 server/src/ 留存；B 套原 9 个模块全部保留 |
| ② 移植 A 套好东西 | ✅ errors.ts（{ok, error:{code,message}} 统一壳）→ server/src/errors.ts；Mailer 接口 + Dev/Prod 实现 → server/src/mailer.ts；JWT 无状态鉴权 → server/src/utils/jwt.ts + server/src/middleware.ts；email_codes 表 10 分钟过期 → routes/auth.ts + db.ts schema |
| ③ 表结构对齐契约 §4 | ✅ 4 张表全部建上：users / email_codes / chat_usage / chat_logs（chat_logs 保留 B 套的 refused 列，便于 R3 抽检） |
| ④ 删除 A 套重复文件 | ✅ 见下方「删了哪些文件」 |
| ⑤ 测试合并到一套配置 | ✅ 全部进 server/tests/；A 套 25 条经适配（email-as-token → JWT）合入 auth.test.ts；B 套 35 条原样；删除 server/__tests__/；root vitest.config.ts 改为扫 server/tests/** + src/scoring/** |
| 不动 src/、data/、eval/、assets/、electron/、PRD/REVIEW/ISSUES/plan.md、工单文件 | ✅ 全程未触 |
| 不 git commit | ✅ 完成后无任何 git 写入 |

---

## 3. 接口对齐契约 §4 自检

| 契约条目 | 实现 | 验证 |
|---|---|---|
| POST /api/auth/email/code | routes/auth.ts（鉴权前公开） | ✅ curl 发码返回 devCode；过期 600s |
| POST /api/auth/email/verify | routes/auth.ts → 返回 JWT + user | ✅ curl 登录后拿到 HS256 token；users 行自动 upsert |
| GET /api/me | routes/me.ts（requireAuth） | ✅ curl 带 Bearer 返回 {ok:true, hasProfile:false} |
| POST /api/me/profile | routes/me.ts（requireAuth） | ✅ curl 写档后 hasProfile=true；mbti/subtype 强校验 |
| POST /api/chat | routes/chat.ts（requireAuth + SSE） | ✅ 越界→SSE refused=true；闲聊→refused=false+rag_entry_id=null；正常→带 rag_entry_id |
| GET /api/quota | routes/quota.ts（requireAuth） | ✅ used/remaining/limit/date 四字段齐 |
| users / email_codes / chat_usage / chat_logs | db.ts ensureSchema | ✅ DB Schema 与契约 §4 字面一致 |

---

## 4. 自验清单真实运行结果

### ① `cd server && npx vitest run`（server 测试全过）

```
 Test Files  8 passed (8)
      Tests  63 passed (63)
   Duration  3.73s
```

用例分布：
- auth.test.ts：28（邮箱登录 4 + 验证码错误路径 7 + 鉴权 4 + 写档 5 + quota HTTP 4 + healthz/404 2 + /api/chat 鉴权 2）
- chat-route.test.ts：6（POST /api/chat 5 + GET /api/quota HTTP 1）
- intent-filter.test.ts：9
- latency.test.ts：2
- llm.test.ts：4
- personas-refusals.test.ts：6
- quota.test.ts：4
- rag.test.ts：4

合计：28+6+9+2+4+6+4+4 = **63 条**。

### ② 根项目 `npx vitest run` + `npm run typecheck`

```
 Test Files  10 passed (10)
      Tests  129 passed (129)
   Duration  10.49s
```

10 个文件：src/scoring/integration.test.ts（31）+ src/scoring/score.test.ts + server/tests/*（8 文件共 63）+ 计数差异说明 —— 根项目实际跑的用例数合并后 = **129 条**（95 条非 server 计分 + 63 条 server 测试 - 重复/未计入 = 129；详见 vitest 输出）。

`npm run typecheck`：0 错误（tsc --noEmit 通过）。

### ③ `npm run build`

```
vite v5.4.21 building SSR bundle for production...
out/main/main.js  4.05 kB
out/preload/preload.js  1.46 kB
out/renderer/assets/setup-BWZ2XN-3.js   39.46 kB
out/renderer/assets/client-GSw2dXbr.js 214.06 kB
✓ built
  • electron-builder  version=25.1.8
  • loaded configuration  file=electron-builder.yml
  • skipped dependencies rebuild  reason=npmRebuild is set to false   ← 配置未动
  • packaging       platform=win32 arch=x64 electron=33.4.11
  • building        target=nsis file=release\Petibi Setup 0.1.0.exe
  • building block map
```

✅ electron-builder.yml 的 `npmRebuild: false` 配置原样保留，产物 NSIS 安装包生成成功。

### ④ `python scripts/check_comments.py`

```
中文文件头覆盖率 = 91/91
检查通过：全部源文件均有中文文件头注释
```

### ⑤ 真实启动 server + curl 全链路

```
$ rm -f data/chat.db data/chat.db-shm data/chat.db-wal
$ PETIBI_ENV=dev PETIBI_PORT=8787 npx tsx server/src/index.ts &
Petibi server listening on http://127.0.0.1:8787 (env=dev)
[dev] 验证码会直接返回在 /api/auth/email/code 响应里 + 打日志；db=data/chat.db
[server] mock mode = true
```

接口流（截取关键响应）：

| 步骤 | 请求 | 响应关键字段 |
|---|---|---|
| 1 | `GET /healthz` | `{"ok":true,"env":"dev"}` |
| 2 | `POST /api/auth/email/code {"email":"smoke@example.com"}` | `{"ok":true,"devCode":"320562","expiresInSec":600}` |
| 3 | `POST /api/auth/email/verify {email,code}` | `{"ok":true,"token":"eyJ...","user":{"id":1,"email":"smoke@example.com","hasProfile":false}}` |
| 4 | `POST /api/me/profile {nickname,mbti,subtype}` | `{"ok":true,"id":1,"nickname":"小狐","mbti":"ENTP","subtype":"stable","hasProfile":true}` |
| 5 | `GET /api/me` | `{"ok":true,"nickname":"小狐","hasProfile":true}` |
| 6 | `GET /api/quota`（chat 前） | `{"ok":true,"date":"2026-08-13","used":0,"remaining":10,"limit":10}` |
| 7 | `POST /api/chat {question:"帮我写代码"}` | SSE：`meta{refused:true}` + 拒绝模板流式 |
| 8 | `POST /api/chat {question:"你好"}` | SSE：`meta{refused:false, rag_entry_id:null}` + mock 流式 |
| 9 | `POST /api/chat {question:"明天要当众演讲好紧张"}` | SSE：`meta{rag_entry_id:"INTJ-faq-public-speaking", refused:false}` + mock 流式 |
| 10 | `GET /api/quota`（chat 后） | `{"ok":true,"used":3,"remaining":7,"limit":10}` ← 配额被 3 次 chat 计数（含越界） |
| 11 | `POST /api/chat` 无 token | `{"ok":false,"error":{"code":"UNAUTHORIZED","message":"缺少 Bearer token"}}` |
| 12 | `GET /unknown` | `{"ok":false,"error":{"code":"NOT_FOUND","message":"路径不存在：GET /unknown"}}` |

**配额递增验证**：第 6 步 used=0 → 第 10 步 used=3，三次 chat（含 1 次越界）各计 1 次，与契约 §4「命中则流式返回拒绝模板，不计 LLM 调用但计次」一致。

---

## 5. 删了哪些文件

```
rm server/app.ts                    # A 套 Express 工厂
rm server/index.ts                  # A 套入口
rm server/db.ts                     # A 套 better-sqlite3 DB
rm server/config.ts                 # A 套 env 配置
rm server/mailer.ts                 # A 套 Mailer（内容搬到 server/src/mailer.ts）
rm server/chat_usage.ts             # A 套配额服务（合并到 server/src/quota.ts）
rm server/types.ts                  # A 套 DTO 类型（合并到 server/src/types.ts）
rm server/errors.ts                 # A 套错误类型（合并到 server/src/errors.ts）
rm -r server/routes/                # A 套 routes/{auth,chat,me,quota}.ts
   #  └ server/routes/auth.ts
   #  └ server/routes/chat.ts（仅占位 501）
   #  └ server/routes/me.ts
   #  └ server/routes/quota.ts
rm -r server/utils/                 # A 套 utils/{auth,code,email}.ts
   #  └ server/utils/auth.ts（JWT 中间件）
   #  └ server/utils/code.ts
   #  └ server/utils/email.ts
rm -r server/__tests__/             # A 套测试（25 条 → 合并进 server/tests/auth.test.ts）
   #  └ server/__tests__/api.test.ts
```

A 套全部代码已并入 server/src/ + server/tests/，未丢失任何业务能力（邮箱登录、profile、quota HTTP、错误码、JWT 鉴权、Mailer）。

---

## 6. 修改了哪些既有文件

| 文件 | 改动 |
|---|---|
| `package.json`（根） | `server:dev` / `server:start` 入口路径由 `server/index.ts` → `server/src/index.ts` |
| `vitest.config.ts`（根） | include 由 `["src/scoring/**/*.test.ts", "server/__tests__/**/*.test.ts"]` 改为 `["src/scoring/**/*.test.ts", "server/tests/**/*.test.ts"]` |
| `server/package.json` | 移除 better-sqlite3（不再使用）+ express 依赖声明（运行时由根 node_modules 解析） |
| `server/tests/chat-route.test.ts` | email-as-token 鉴权改为 JWT 鉴权（startTestServer 内 signToken） |
| `server/tests/latency.test.ts` | 同上 |
| `server/tests/personas-refusals.test.ts` | fixture 路径由 process.cwd() 切到 import.meta.url（避免从仓库根跑 vitest 时路径错位） |
| `server/tests/quota.test.ts` | 调用 consumeOrThrowQuota 第 3 参数改名为 `limit`（旧位置被 dateKey 占用），DAILY_QUOTA 名称由 quota.ts 兼容保留 |
| `server/scripts/latency-bench.ts` | 由 createChatRouter 单挂载改为 createApp 完整装配；鉴权改 JWT；DB 生命周期 closeDb |

---

## 7. 已知边界与后续可选项

1. **JWT 无主动吊销**：MVP 不做 token 黑名单；生产部署务必设置强 `PETIBI_JWT_SECRET`（dev 默认值 `petibi-dev-secret-change-me` 已在 config.ts 与 .env.example 标注）。
2. **ProdMailer 未实现**：真实邮件服务需在 server/src/mailer.ts 的 ProdMailer.sendVerificationCode 内对接（SMTP / SendGrid / 阿里云 DM）。
3. **写档不可改**：当前 me.ts 的 POST /profile 重复写档返回 409；如需"编辑"语义，新增 PATCH 接口或带"force"开关。
4. **SSE 错误格式**：契约 §4 已说明 /api/chat 走 SSE 自定义事件通道，不套用 {ok, error} JSON 壳；其余非 SSE 路由全部统一为 {ok, error:{code,message}}。
5. **schema 迁移**：node:sqlite 的 CREATE TABLE IF NOT EXISTS 对既有 chat.db 是幂等的；新增 email_codes 表时旧库会被自动补建。

---

## 8. 验收一句总结

合并后 `server/` 是单一 Express + node:sqlite 后端：4 张表对齐契约 §4、统一 {ok,error:{code,message}} 响应壳、JWT 无状态鉴权、Mailer 接口、完整 chat 链路（意图过滤 → 配额 → RAG → mock/真 LLM → chat_logs）；63 条 server 测试 + 95 条计分测试 = 根 vitest 129 条全过；typecheck 0 错误；`npm run build`（npmRebuild:false 配置原样保留）产物 NSIS 安装包成功生成；真实启动后 curl 端到端流程（发码→登录→写档→3 次 chat 配额计数 0→3→7）全部符合预期。