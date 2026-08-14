# M4 token 失效恢复 交付报告

> 工单：M4 token 失效恢复（owner 反馈"我的"Tab 卡死「token 无效或已过期」）
> 分支：`MBTIwilldo/`（与并行 M4 工单共享同一基线）
> 改动范围：`src/api/client.ts` / `src/api/types.ts` / `src/panel/App.tsx` / `src/setup/pages/LoginPage.tsx` / `electron/preload.ts` / `src/panel/styles.css` / `vitest.config.ts`
> 不动：`server/` 业务逻辑（除响应字段名一致化，仅 `devCode` 命名）、`data/`、`eval/`、`assets/`、`PRD/REVIEW/ISSUES/plan.md`

---

## 1. 背景与目标

M4 内嵌 server 工单把 Petibi 由"前端 + 独立后端"改为"Electron 主进程内嵌 127.0.0.1:8787"。
老用户从 mock 时代升级上来，userData/profile.json 里存的 `token` 是 mock 时代的假 token（`mock-token-1`），调 `/api/me` 直接返 **401 UNAUTHORIZED**。

旧前端的行为：
- `client.ts` 把 fetch 错误统一包成 `ApiCallError` 抛出；
- `panel App.tsx` 在 `userError` state 里写错误文案，但 token 真接口鉴权失败时永远显示「请确认后端服务（端口 8787）已启动后重新打开主面板」——这条文案与 401 实际语义不符；
- 用户视角："我的"Tab 显示「加载用户档案失败：token 无效或已过期。请确认后端服务（端口 8787）已启动后重新打开主面板。」，**没有重新登录入口**，等于卡死。

同时内嵌 server 在 dev 模式下 `/api/auth/email/code` 响应里有 `devCode` 字段（旧前端读 `dev_code` 不兼容），LoginPage 文案写死"mock 模式：验证码固定 123456"，没有显示内嵌 server 的真实验证码。

**目标**：

1. **401 自动恢复**：任何接口（real 或 mock）返 401 → 清本地 token + 主面板渲染「登录已过期」卡片（带跳转按钮）+ 主进程开 setup 窗；不允许卡死或只显示错误。
2. **错误文案区分**：「server 没起来（NetworkError）」与「token 无效（401）」分别渲染不同提示，避免误导用户重启服务。
3. **devCode 展示**：内嵌 server dev 模式把 `devCode` 直接显示在 LoginPage UI 上（取代固定 123456 提示）。
4. **全链路对齐**：老用户升级场景——token 无效 → 自动恢复 → 重新登录（devCode 可见）→ 直接进桌宠（不再重走 nickname/pick/test/result）。

---

## 2. 关键设计决策

### 2.1 401 处理放 client.ts，不放 UI 组件

考虑过三种方案：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 每个 API 调用方自己 catch 401 | 集中度低，调用方上下文敏感 | 4+ 个 Tab 都要写一遍，且 ChatTab 的 streamChat 需要在生成器 yield 里塞回调 |
| 全局 fetch 拦截器 | 一次实现，覆盖所有 fetch | 与 SSE 流式 / 401 body 解析耦合（生成器 yield 出来再判已经晚了） |
| **client.ts 模块级 handler + 模块顶层 fireAuthInvalid** ✅ | parseJson 抛错前 fire，streamChat 的非流式 401 也覆盖，UI 只需 setAuthInvalidHandler 一次 | 需保证 handler 重复注册时只触发一次（节流） |

最终选 **模块级 handler**：`fireAuthInvalid` 在 `parseJson`（401 status）和 `realStreamChat`（SSE 401）两条路径上都会调；`lastAuthInvalidAt` 1 秒节流，避免 mock 轮询或并发请求把本地 token 反复清掉。

### 2.2 NetworkError 与 ApiCallError 严格区分

旧实现：fetch 抛 TypeError（`ECONNREFUSED` / DNS 失败 / 超时）也被包成 `ApiCallError`，HTTP status 不存在 → 走兜底文案「请确认服务已启动」，**但**用户实际遇到 401 时也会显示同样内容。

新增 `NetworkError` 类（`extends Error`），专门表示"客户端 ↔ server 链路就断了"：

```ts
async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (e) {
    const msg = e instanceof TypeError
      ? `连接本地服务失败（${url}）：请确认应用已正常启动`
      : `请求失败：${e instanceof Error ? e.message : String(e)}`
    throw new NetworkError(msg, e)
  }
}
```

所有 `realXxx` 函数都改走 `safeFetch`，streamChat 也改走 `safeFetch`。

UI 层用 `instanceof NetworkError` 分流：

| 错误类型 | UI 提示 |
| --- | --- |
| `NetworkError` | "连接不到本地服务（端口 8787）" + 提示用户检查应用是否启动 |
| `ApiCallError` code=UNAUTHORIZED/UNAUTHENTICATED | "登录已过期，请重新登录" + 跳转按钮 |
| 其它 `ApiCallError` | 透传 message（配额耗尽 / 参数非法等） |

### 2.3 devCode 字段统一为 camelCase

旧 `SendCodeResponse.dev_code` / `expires_in`（snake_case）与 server 响应的 `devCode` / `expiresInSec`（camelCase）不一致，前端要在两个命名间切换。M4 工单直接统一为 camelCase：

- `src/api/types.ts`：`SendCodeResponse.dev_code` → `devCode`，`expires_in` → `expiresInSec`
- `src/api/client.ts`：`mockSendCode` 同步改返回 `{ devCode, expiresInSec }`
- LoginPage 用 `res.devCode` 直接读

旧字段名保留为 `optional & undefined`（类型移除）——`scripts/verify_panel.py` 已经做了 `get("devCode") or get("dev_code")` 兼容。

### 2.4 老用户登录直通

旧 setup 流程假设"每次登录 = 新用户"，固定走 login → nickname → pick → test → result。M4 内嵌 server 升级后老用户升级场景需要跳过 nickname（已有昵称）。

新增 LoginPage 分流：

```ts
const res = await verifyEmailCode(email, code)
if (res.user.mbti) {
  // 老用户：写本地 profile（含真 token + user.mbti/subtype/nickname）+ completeSetup
  await window.petApi.setProfile({ token: res.token, profile: { ... } })
  window.petApi.completeSetup()  // 主进程关 setup、开 pet 窗
  return
}
// 新用户：走原 5 步流程
dispatch({ type: 'LOGIN_SUCCESS', email: res.user.email, token: res.token })
```

reducer 不动（`LOGIN_SUCCESS` 仍是新用户分支，老用户走 `petApi.setProfile` + `petApi.completeSetup` 直通到桌宠），避免破坏 `setupReducer.test.ts` 现有契约。

---

## 3. 改动详情

### 3.1 `src/api/client.ts`

新增模块级：

```ts
export class NetworkError extends Error { /* ... */ }
type AuthInvalidHandler = (info: { code: string; message: string }) => void
let authInvalidHandler: AuthInvalidHandler | null = null
let lastAuthInvalidAt = 0

export function setAuthInvalidHandler(handler): void { /* ... */ }
export function isAuthError(err: unknown): err is ApiCallError { /* UNAUTHORIZED/UNAUTHENTICATED/HTTP_401 */ }
function fireAuthInvalid(err: ApiCallError): void { /* 1 秒节流 */ }
```

`parseJson` 在 401 时触发：

```ts
if (res.status === 401 || code === 'UNAUTHORIZED') {
  fireAuthInvalid(err)
}
```

`realStreamChat` 在 `!resp.ok` 时同样触发（SSE 401 也走同一通道）。

`mockGetMe` 在 token 不在 mockUsers 表里时也触发（mock 时代假 token 升级场景）：

```ts
function mockGetMe(token: string): User {
  for (const { user, token: t } of mockUsers.values()) {
    if (t === token) return user
  }
  const err = new ApiCallError({ code: 'UNAUTHENTICATED', message: 'token 无效或已过期' })
  fireAuthInvalid(err)
  throw err
}
```

`mockSendCode` 返回字段名统一：

```ts
return { devCode: code, expiresInSec: 300 }
```

新增 `safeFetch` 工具函数，所有 `realXxx` + `realStreamChat` 改走 `safeFetch`。

### 3.2 `src/api/types.ts`

```ts
export interface SendCodeResponse {
  devCode?: string
  expiresInSec: number
}
```

### 3.3 `electron/preload.ts`

panelApi 新增 `setProfile`：

```ts
setProfile: (next: StoredProfile): Promise<{ ok: true }> => {
  return ipcRenderer.invoke('profile:set', next)
}
```

主进程 `profile:set` IPC handler 已在 `electron/main.ts` 存在（沿用 M2），可直接走。

### 3.4 `src/panel/App.tsx`

- 新增 `authExpired` / `userErrorKind` 状态
- 注册 `setAuthInvalidHandler`（useEffect mount / unmount 自动注销）：
  - setAuthExpired(true) + setToken(null) + setUser(null) + setIsGuest(true)
  - 写本地 profile.json（保留 profile 字段，token=null）
- `renderTabBody` 的 profile 分支按 `userErrorKind` 分流：
  - 'auth' → 渲染「登录已过期」卡片 + 「重新登录」按钮（调 `requireLogin`）
  - 'network' → "请确认后端服务（端口 8787）已启动后重新打开主面板"
  - 'other' → "请稍后重试，或重新打开主面板"

### 3.5 `src/setup/pages/LoginPage.tsx`

- mock-banner 文案改为显示 devCode（来自 `res.devCode`）：
  - 旧：`mock 模式：验证码固定 123456`
  - 新：`本地模式验证码：517754`（真接口 dev 模式显示真实验证码；mock 模式显示固定 123456）
- mock 模式且 devCode 还没回填时，仍保留旧的"mock 模式：验证码固定 123456"提示（让 dev 联调时知道可以填 123456）
- 登录成功后分流：
  - `res.user.mbti` 存在 → 写本地 profile + `completeSetup`（直通桌宠）
  - 不存在 → `dispatch LOGIN_SUCCESS`（走 5 步流程）

### 3.6 `src/panel/styles.css`

新增 `.profile-auth-expired` 系列样式（与 `.guest-lock` 共享纸白底 + 墨边框 + 硬阴影，但文案更聚焦）。

### 3.7 `vitest.config.ts`

`include` 新增 `src/api/__tests__/**/*.test.ts`（新增 13 个测试用例）。

---

## 4. 测试覆盖

### 4.1 新增 `src/api/__tests__/client-auth-recovery.test.ts`（13 用例）

| describe | it | 验证点 |
| --- | --- | --- |
| setAuthInvalidHandler + isAuthError | mock 假 token 调 getMe 立即触发 handler | 老用户升级场景契约 |
|  | 未注册 handler 时仍抛错（不静默） | 失败不能被吞 |
|  | isAuthError: UNAUTHORIZED/UNAUTHENTICATED/HTTP_401 → true；BAD_REQUEST → false | 判定边界 |
| 真接口 parseJson 401 | 401 + UNAUTHORIZED body → handler 触发 + message/code 透传 | parseJson 路径 |
|  | 400 BAD_REQUEST → handler 不触发 | 业务错误分流 |
|  | 403 QUOTA_EXCEEDED → handler 不触发 | 配额错误分流 |
| NetworkError 区分 | safeFetch 把 TypeError 转 NetworkError，不触发 handler | server 没起 ≠ 鉴权失效 |
|  | NetworkError 不是 ApiCallError 子类 | 类型边界 |
| 401 节流 | 同一 handler 在 1s 内连发两次只触发一次 | 避免反复清 token |
| devCode 字段 | mockSendCode 返回 `devCode`（无 `dev_code`）+ `expiresInSec` | 字段命名统一 |
|  | LoginPage 从 `res.devCode` 读取的契约 | UI 集成 |
| 老用户直通 | mock 模式 verifyEmailCode 返回 user 结构合法；老用户判定字段 | 升级场景字段对齐 |
|  | 新用户首次登录 user.mbti 为 null | 走 LOGIN_SUCCESS 路径 |

### 4.2 回归

- 全量测试 25 文件 / 331 用例 **全部通过**（含 `setupReducer.test.ts` / `chat-reducer.test.ts` / `chat-stream-e2e.test.ts` / `chat-tab-session.test.ts` / `main-menu.test.ts` 等所有既有套件）
- typecheck: 0 错
- check_comments: 136/136 通过

---

## 5. 自验清单

| 项 | 结果 |
| --- | --- |
| typecheck (`tsc --noEmit`) | ✅ 0 错 |
| test (`vitest run`) | ✅ 25 文件 / 331 用例通过 |
| check_comments | ✅ 136/136 文件中文头注释覆盖 |
| build:server | ✅ dist/server/server.cjs (1921 KiB) |
| electron-vite build | ✅ out/main + out/preload + out/renderer |
| electron-builder | ✅ release/Petibi Setup 0.1.0.exe |
| 新安装包生成 | ✅ `Petibi Setup 0.1.0.exe` |
| 全链路自验（理论路径） | token 无效 → handler 清本地 token + 跳登录 → devCode 显示 → 老用户登录后 completeSetup → 进桌宠 |

---

## 6. 不动 / 边界

按工单硬性约束：

- ✅ **server/ 业务逻辑不动**：只把响应字段名 `devCode` / `expiresInSec`（已在 server 实现）与前端对齐；不动任何路由、中间件、错误码、SQL。
- ✅ **data/ 不动**：百科 / 人格 / 题库 / intent-filter / sensitive-words / refusals 全部原样。
- ✅ **eval/ 不动**
- ✅ **assets/ 不动**
- ✅ **PRD / REVIEW / ISSUES / plan.md 不动**：本工单是新工单，不修改既有交付文档。
- ✅ **不 git commit**：由 owner 在合并时打 commit；本报告交付。

---

## 7. 老用户升级 UX 流程图

```
[启动应用]
  ↓
[Electron 主进程启动 → startServerInMain 监听 127.0.0.1:8787]
  ↓
[panel 启动 → getInit → 读 profile.json 拿到 mock-token-1]
  ↓
[getMe(mock-token-1) → server 返 401 UNAUTHORIZED]
  ↓
[client.ts: parseJson 检测 401 → fireAuthInvalid]
  ↓
[App.tsx setAuthInvalidHandler: setAuthExpired(true) + 清本地 token + 写 profile.json {token:null}]
  ↓
[「我的」Tab 渲染「登录已过期」卡片 + 「重新登录」按钮]
  ↓
[用户点按钮 → requireLogin → 主进程 panel:open-setup → 关 panel、开 setup 窗]
  ↓
[setup 窗 LoginPage → 用户填邮箱 → 发验证码 → server dev 模式响应里 devCode='517754']
  ↓
[UI 渲染「本地模式验证码：517754」]
  ↓
[用户填 517754 → verifyEmailCode → 拿到 token + user（user.mbti 存在）]
  ↓
[LoginPage: 老用户分流 → petApi.setProfile({token, profile:{...}}) + petApi.completeSetup()]
  ↓
[主进程: 关 setup 窗、开 pet 窗]
  ↓
[桌宠正常显示 + panel 重新 refetch getMe 拿到真 user]
  ↓
[「我的」Tab 正常显示用户档案]
```

整链路不卡死、不重走 nickname、不要求用户重启应用。

---

## 8. 后续可优化（不在本工单范围）

- 401 触发时通过 IPC 通知主进程在 UI 层弹 toast 提示（目前只渲染在「我的」Tab 内部）
- token 失效后 ChatTab 流式对话如果正在进行，能优雅 abort + 提示用户重新登录
- dev 模式让用户可一键复制 devCode 到剪贴板（与桌面端普通用户习惯更贴）
- 后端给 /api/me 等鉴权接口加 ETag，减少升级后的 401 触发频次

---

**交付完成时间**：2026-08-14
**改动文件**：`src/api/client.ts` / `src/api/types.ts` / `src/panel/App.tsx` / `src/setup/pages/LoginPage.tsx` / `electron/preload.ts` / `src/panel/styles.css` / `vitest.config.ts` / `src/api/__tests__/client-auth-recovery.test.ts`（新增）
**新增安装包**：`release/Petibi Setup 0.1.0.exe`
**不交付 git commit**：由 owner 合并时打 commit（按惯例）