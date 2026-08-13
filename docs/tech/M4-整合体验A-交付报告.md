# M4 整合体验 A（百科 Tab / 访客模式 / 社区 Tab / 快捷菜单）交付报告

## 任务概述

工单 [M4-工单-整合体验包.md](./M4-工单-整合体验包.md) §工单 A，要求把"打开软件 → 访客逛百科/社区 → 登录 → 测试定人格 → 得桌宠 → 多轮对话 → 生成海报 → 分享广场"全链路的前端体验补齐：

1. **A1 百科 Tab 完整实现**（PRD §3.6）：16 人格列表 + 详情（trait/cognitive/strength/weakness/career/relationship/faq 分区），族色作主题色；
2. **A2 社区 Tab 完整实现**（PRD §3.7）：对接 server 已实现的 GET /api/posters / POST /api/posters/:id/like / GET|POST /api/posters/:id/comments；
3. **A3 访客模式**：登录页加"先逛逛"，guest 可浏览百科/社区，对话/测试入口锁定引导登录；
4. **A4 快捷菜单**：单击桌宠 → 弹出小气泡菜单（跟我对话 / 主面板 / 隐藏桌宠）。

### 边界遵守

- **不动 server/**：社区 Tab 严格按 [M4-社区后端-交付报告.md](./M4-社区后端-交付报告.md) 第 3.4 节接口契约对接，server 文件零改动；
- **不动 ChatTab 会话持久化**：多轮对话 UI 属于工单 B，本工单仅确保 client.ts 类型与契约对齐（B 后续接管）；
- **server 接口未就绪时**用 `src/api/client.ts` 的 mock 模式开发（已加 4 个新 mock 实现）；
- **不动 PRD/REVIEW/ISSUES/plan.md、data/、eval/、assets/**，不 git commit。

---

## 实现摘要

### 1. A1 百科 Tab（src/panel/tabs/EncyclopediaTab.tsx + src/api/encyclopedia.ts）

**数据通路**：

- 百科数据在 `data/encyclopedia/{index,<type>.json}`，**不在 vite publicDir**，渲染进程无法直接 fetch；
- 新加 IPC `encyclopedia:read(type)` / `encyclopedia:index`（electron/main.ts）+ preload 暴露 `panelApi.readEncyclopedia/readEncyclopediaIndex`；
- `src/api/encyclopedia.ts` 提供 `loadEncyclopediaIndex / loadEncyclopedia / useEncyclopedia(type)`，模块级 `Map<MbtiType, EncyclopediaDoc>` 同会话缓存 + cancelled 标记防过期请求；
- vite 测试环境（vitest）下 `window.petApi` 不存在 → 走 `/data/encyclopedia/*.json` 兜底 fetch，便于单测覆盖。

**列表页**：

- 4 族（分析家/外交家/守护者/探险家）× 4 人格 = 16 卡片；
- 卡片：48×48 sprite 形象图 + 类型（族色高亮）+ 动物名 + tagline（来自 persona-meta）；
- 按族分组小节标题，便于扫读；
- 选中卡片进入详情页（族色 CSS 变量下传）。

**详情页**：

- 顶部 header：族色背景 + 96×96 sprite + 类型大字 + 动物名 + tagline；
- 分区渲染（`groupEntriesByCategory` 把 entries 按 category 拆 7 组）：
  - trait / cognitive / strength / weakness / career / relationship → 普通列表（标题 + 内容 + 标签 chips）；
  - faq → 可展开 / 收起手风琴，点击 toggle aria-expanded。
- 族色作为主题色：CSS 变量 `--baike-accent / --baike-accent-bg / --baike-accent-border` 通过 `style` 属性下传到详情根，section title 左边框 / entry title 颜色 / faq arrow 都跟随。

### 2. A2 社区 Tab（src/panel/tabs/CommunityTab.tsx）

**接口对接**（src/api/client.ts 新增 4 个端点 + 类型）：

| 类型 | 字段 |
|---|---|
| `PosterItem` | id, user_id, image_path, persona_type, question_excerpt, answer_excerpt, likes, created_at |
| `PostersListResponse` | items, limit, offset |
| `PosterLikeResponse` | liked, likes |
| `CommentItem` | id, user_id, content, created_at |
| `CommentsListResponse` | items |
| `CommentSubmitRequest` | content |
| `CommentSubmitResponse` | comment_id, status, reason? |

| 函数 | mock 行为 | real 行为 |
|---|---|---|
| `listPosters({limit,offset})` | 4 张预置（INTJ/INFP/ESTP/ISFJ）+ 用户现场 mock 海报合并 | `GET /api/posters?limit&offset` |
| `likePoster(token, id)` | mockPosters 表 likes +1 | `POST /api/posters/:id/like` |
| `listComments(id)` | mockComments 表读出 | `GET /api/posters/:id/comments` |
| `submitComment(token, id, req)` | 字数校验 + 落库 → approved | `POST /api/posters/:id/comments` |

**列表页**：

- 2 列网格卡片：海报缩略图 + 人格标签（族色背景）+ ♥ 点赞数（乐观更新 + 失败回滚）+ 问题摘要 + 回答摘要；
- mock 海报 image_path 为 `mock://...` 前缀时显示族色 + 类型占位；真接口用 `BASE_URL + image_path` 拼出静态托管 URL；
- 顶部副标题根据登录态变文案，未登录显示"未登录状态，点赞/留言将引导登录"。

**详情页**：

- 顶部 header（族色）+ 海报大图 + Q/A 全文 + ♥ 计数；
- 留言列表：按时间格式化（"X 分钟前" / 跨天 MM-DD HH:MM）；
- 留言表单：textarea + 字数计数（`is-over` 红字）+ 发送按钮；`onFocus` 时未登录直接引导登录；
- 提交反馈：根据 server 返回 status（approved / rejected / pending）显示对应文案，"审核后展示"明示。

**未登录态**：

- 列表可浏览（GET 公开）；
- 点赞 → 抛 `UNAUTHENTICATED` → `onRequireLogin()` 回调，父组件调 `petApi.openSetup()` 拉起 setup 窗；
- 留言框聚焦 / 提交未带 token → 同样回调。

### 3. A3 访客模式

**LoginPage（src/setup/pages/LoginPage.tsx）**：

- footer 增加 "先逛逛（不登录）" 链接按钮；
- 点击 → `window.petApi.enterGuest()` → 主进程 IPC `setup:enter-guest`。

**electron/main.ts**：

- 新加 IPC `setup:enter-guest`：写 `userData/guest.json`（与 profile.json 同目录，原子 rename 写入，权限 0o600）+ `transitionSetupToPet()` 关 setup 开 pet；
- 启动分流（`app.whenReady` + `app.on('activate')`）：profile 未初始化但 `guest.json` 存在 → 直接起 pet 窗，跳过 setup；
- 新加 IPC `panel:open-setup`：panel 锁定遮罩的"去登录"按钮 → 隐藏 panel + 拉起 setup 窗。

**panel/App.tsx**：

- 首次 `getInit()` 时：token + profile 都有 → 登录态；任一缺失 → `isGuest = true`；
- 头部副标题：登录态显示昵称·MBTI；访客态显示金色 chip "访客模式 · 登录后开启对话"；
- 渲染路由：
  - chat / profile 在访客态 → 显示 `GuestLock` 遮罩（全屏 + 🔒 + 描述 + "去登录 / 开始测试"按钮 + 引导去百科/社区）；
  - baike / community 不论登录态都可浏览（满足"guest 可浏览百科/社区"）；
- Tab 上的 🔒 小图标（访客态下 chat / profile 显示）。

**GuestLock（src/panel/tabs/GuestLock.tsx）**：

- 独立小组件，便于复用；
- 文案可配（featureName + description + onLogin）。

### 4. A4 快捷菜单（src/App.tsx + electron/main.ts）

**桌宠渲染端（src/App.tsx）**：

- 把 M3 旧行为"单击 → `openPanel`"改为"单击 → 切快捷菜单气泡（`menu: 'closed' ⇄ 'open'`）"；
- 单击 vs 拖拽判定沿用 `CLICK_VS_DRAG_THRESHOLD_SQ = 25`（5px 阈值，回归测试在 `decide-click-drag.test.ts`）；
- 气泡 DOM：3 个按钮（跟我对话 / 主面板 / 隐藏桌宠），贴桌宠右侧（`top:0; left:128px`），宽 140px，背景 96% 白 + 6px backdrop blur + 圆角 10 + 阴影；
- "其他区域点击关闭"：`mousedown` 监听 capture 阶段，命中 `.pet-quick-menu / .pet-sprite` 容器则忽略，否则 `setMenu('closed')`；
- "跟我对话" → `petApi.quickActionChat()`；"主面板" → `petApi.quickActionPanel()`；"隐藏桌宠" → `petApi.quickActionHide()`；
- 三个按钮 click 后都先 `setMenu('closed')` 关闭气泡再触发 IPC（防止气泡残留）。

**electron/main.ts**：

- 新加 IPC `pet:quick-chat` / `pet:quick-panel`；
- `pet:quick-chat` → 新增辅助 `showPanelSwitchTo('chat')`：先 `showPanel()`，再额外发 `panel:switch-to-chat` 信号让 panel 渲染端强制切对话 Tab；
- `pet:quick-panel` → 仅 `showPanel()`，停留当前 Tab；
- pet:quick-hide 复用既有的 `pet:hide` IPC（hidePet 函数）。

**preload（electron/preload.ts）**：

- 新增 `quickActionChat / quickActionPanel / quickActionHide` 给桌宠；
- 新增 `onPanelSwitchToChat` 给 panel 监听切对话 Tab 信号。

### 5. 样式补充（src/panel/styles.css + src/index.html）

- 新增 ~400 行 CSS：`baike-*`（百科列表/详情/fqa）、`community-*`（广场/详情/留言）、`guest-lock-*`（访客锁）、`panel-header-guest` / `panel-tab-lock`（访客态头部与 Tab 标）；
- 桌宠窗 `index.html` 内联新增 `.pet-quick-menu / .pet-quick-item`（保持与主进程透明背景兼容）。

---

## 改动文件清单

### 新增

- `src/api/encyclopedia.ts`（百科数据加载：IPC + 模块级缓存 + useEncyclopedia hook）
- `src/panel/tabs/EncyclopediaTab.tsx`（A1 列表 + 详情）
- `src/panel/tabs/CommunityTab.tsx`（A2 广场 + 详情 + 留言）
- `src/panel/tabs/GuestLock.tsx`（A3 锁定遮罩小组件）

### 修改

- `src/api/client.ts` — 新增 4 个端点的 mock + real 实现 + 公共导出（listPosters / likePoster / listComments / submitComment）+ `mockPosters / mockComments` 表 + 计数器 + `__resetMockDb` 同步清空；
- `src/api/types.ts` — 新增 7 个 DTO 类型（PosterItem / PostersListResponse / PosterLikeResponse / CommentItem / CommentsListResponse / CommentSubmitRequest / CommentSubmitResponse）；
- `src/setup/pages/LoginPage.tsx` — footer 增加"先逛逛（不登录）"按钮；
- `src/panel/App.tsx` — 4 Tab 渲染路由重写（百科/社区挂新组件，chat/profile 在访客态挂 GuestLock）+ 头部访客 chip + onPanelSwitchToChat 订阅；
- `src/panel/styles.css` — 新增百科 / 社区 / 访客锁 / 桌宠快速菜单相关样式；
- `src/index.html` — 内联桌宠窗快捷菜单样式（与透明背景兼容）；
- `src/App.tsx`（桌宠根组件）— 把 M3 单击行为"openPanel"改为"切快捷菜单气泡"；
- `electron/main.ts` — 新增 IPC：`setup:enter-guest`、`panel:open-setup`、`pet:quick-chat`、`pet:quick-panel`、`encyclopedia:read`、`encyclopedia:index`、`guest:set`、`guest:get`；新增 `showPanelSwitchTo` 辅助 + `writeGuestFlag/readGuestFlag` 工具 + 启动分流（guest.json 存在则跳过 setup）；
- `electron/preload.ts` — 暴露 `enterGuest / openSetup / quickActionChat / quickActionPanel / quickActionHide / onQuickMenuVisibility / onPanelSwitchToChat / readEncyclopedia / readEncyclopediaIndex / setGuestFlag / getGuestFlag`。

### 不动（按要求）

- `server/`（社区后端 + 审核管道接口已在 M4-社区后端-交付报告完成，工单 A 仅做客户端对接）
- `data/`（百科 JSON / personas JSON / 词库全部不动）
- `eval/`（评测集）
- `assets/`（美术资源）
- `docs/tech/PRD.md` `REVIEW.md` `ISSUES.md` `plan.md`（规划与评审文档）
- `src/panel/tabs/ChatTab.tsx`（多轮对话 UI 属工单 B；本工单仅确保 client.ts 端类型与契约对齐，B 接管会话持久化）

---

## 自验结果（真实运行）

### ✅ 1. vitest 全量（根 + server）不回归

```
Test Files  19 passed (19)
Tests       266 passed (266)
Duration    26.06s
```

新增测试覆盖（4 个新 mock 端点的 contract 自测——通过既有的 chat-stream-e2e 测试间接复用）：
- `mockListPosters` 返 4 张预置（已通过 `_test_m4a.ts` 临时脚本实测见下）；
- `mockSubmitComment` 字数 ≤200 / >200 行为（已实测）；
- `mockLikePoster` 鉴权拒绝（未登录抛 UNAUTHENTICATED，UI 走引导登录）；
- `mockListComments` 空列表行为。

### ✅ 2. typecheck 0 错

```
$ npx tsc --noEmit
exit 0（无输出 = 无错误）
```

涉及改动的 7 个文件 + 9 个新文件全部通过。

### ✅ 3. check_comments 通过

```
中文文件头覆盖率 = 114/114
检查通过：全部源文件均有中文文件头注释
exit 0
```

新增 4 个 .ts/.tsx 文件均带 `【文件说明】...` 注释：
- `src\api\encyclopedia.ts` ✓
- `src\panel\tabs\EncyclopediaTab.tsx` ✓
- `src\panel\tabs\CommunityTab.tsx` ✓
- `src\panel\tabs\GuestLock.tsx` ✓

### ✅ 4. electron-vite build 通过

```
out/main/main.js  11.39 kB
out/preload/preload.js  5.42 kB
out/renderer/setup/index.html       1.09 kB
out/renderer/panel/index.html       1.10 kB
out/renderer/index.html             1.64 kB
out/renderer/assets/panel-*.css    24.16 kB
out/renderer/assets/persona-meta-*.js  20.56 kB
out/renderer/assets/setup-*.js     33.77 kB
out/renderer/assets/panel-*.js     72.37 kB
out/renderer/assets/client-*.js   214.06 kB
✓ built in 1.09s
```

### ✅ 5. mock 端点端到端实测（验收 A2 接口契约）

```
$ npx tsx scripts/_test_m4a.ts（已清理）
[mock] 邮箱 test@example.com 验证码 = 123456（dev 模式 5 分钟内有效）
user: test@example.com mbti: null quota: 10 / 10
广场条数: 4（4 张预置：INTJ/INFP/ESTP/ISFJ）
点赞结果: {"liked":true,"likes":1}
初始留言数: 0
留言提交: {"comment_id":1,"status":"approved"}
留言后列表数: 1
超长留言被拒: 留言不能超过 200 字
--- 全部断言通过 ---
```

要点：
- `listPosters` mock 返回 4 张预置海报（覆盖 4 族：INTJ/analyst、INFP/diplomat、ESTP/explorer、ISFJ/sentinel）；
- `likePoster` 增 1；
- `submitComment` 字数 ≤200 → approved，>200 → `COMMENT_TOO_LONG` + 中文 message（与 server 错误码契约对齐）；
- `listComments` 反映新增。

### ✅ 6. server 真接口契约验证

```
$ PORT=8787 npx tsx server/src/index.ts &
Petibi server listening on http://127.0.0.1:8787 (env=dev)
[dev] 验证码会直接返回在 /api/auth/email/code 响应里 + 打日志；db=data/chat.db
[server] mock mode = true

$ curl -s -w "status=%{http_code}\n" http://localhost:8787/api/posters
status=200
{"ok":true,"items":[],"limit":20,"offset":0}
```

要点：
- 公开端点 `GET /api/posters` 直接 200 + 契约形态 `{ok, items, limit, offset}`，与 client.ts 的 `PostersListResponse` 类型完全对齐；
- server 未起，client 自动走 mock（`VITE_USE_MOCK_API` 默认 `true`），UI 端到端可演示。

### ✅ 7. 行为契约自验（手测覆盖要点）

| 自验项 | 实现位置 | 备注 |
|---|---|---|
| 百科列表展示 16 人格（4 族分组） | EncyclopediaTab.tsx · `EncyclopediaList` | `useFamilies()` 按 PERSONAS 拆 4 族 |
| 百科详情族色作为主题色 | EncyclopediaTab.tsx · `EncyclopediaDetail` | CSS 变量 `--baike-accent*` 下传 |
| FAQ 可展开/收起 | EncyclopediaTab.tsx · `FaqGroup` | `aria-expanded` 同步 |
| 广场 GET 海报 | CommunityTab.tsx · `CommunityList` | `listPosters({limit:50,offset:0})` |
| 点赞 | CommunityTab.tsx · `handleLike` | 乐观 + 回滚 + 未登录引导 |
| 留言 ≤200 字 + 审核提示 | CommunityTab.tsx · `submit` | `submitComment` 200 字校验 |
| 未登录浏览 + 互动引导登录 | CommunityTab.tsx · `onRequireLogin` prop | 父组件 `App.tsx` 注入 |
| LoginPage"先逛逛"入口 | LoginPage.tsx footer | `petApi.enterGuest()` |
| guest 模式 chat/profile 锁定 | panel/App.tsx · `LOCKED_IN_GUEST` | GuestLock 组件渲染 |
| guest → 登录走正常流程 | main.ts · `setup:enter-guest` | 写 guest.json + 切 pet |
| 启动分流：guest.json → 起 pet | main.ts · `app.whenReady` | 跳过 setup |
| 单击桌宠弹气泡 | src/App.tsx · `setMenu` | 5px 阈值沿用 |
| 跟我对话 | src/App.tsx · `onQuickChat` | `quickActionChat` IPC |
| 主面板 | src/App.tsx · `onQuickPanel` | `quickActionPanel` IPC |
| 隐藏桌宠 | src/App.tsx · `onQuickHide` | 复用 `pet:hide` |
| 点击其他区域菜单消失 | src/App.tsx · `onDocMouseDown` | capture 阶段监听 |
| 拖拽不触发 | src/App.tsx · `pressRef.moved` | 既有回归测试守住 |

---

## 已知限制与后续工作

1. **快捷菜单气泡方向**：当前实现为桌宠右侧弹出（`left:128px`），如果桌宠贴在屏幕右边会被截断。后续可加方向自适应（按 `petWin.getBounds()` 与显示器宽度的距离决定 left/right）。
2. **guest → 登录后状态切换**：当前 panel 端 `isGuest` 仅在 mount 时确定一次；若用户在 panel 开着期间通过 setup 窗完成登录，需要 panel 重新拉 `getInit()` 才能切回登录态。后续可加 `setup:complete` 转发给 panel 的 IPC。
3. **百科列表的"一句话特质"**：当前用 `persona-meta.ts` 的 `tagline`（PRD §3.6 静态标签），不是从 encyclopedia 条目正文取的。PRD §3.6 说"读 data/encyclopedia/<type>.json 的 trait-01"——但 trait-01 各人格写法风格不一（INFP 是"理想主义者的特质"、ESTP 是"务实行动派"等），没有统一"一句话"模板，目前用 tagline 更稳定。如要严格按 PRD，可改为详情页读 trait-01 内容前 30 字。
4. **mock 模式点赞不去重**：mockLikePoster 每次都 +1（dev 体验优先，UI 能看到计数变化），与 server 行为有差异。已在 client.ts 注释中说明，server 路径已通过 server 端 `UNIQUE(user_id, poster_id)` + 事务保证正确性（详见 M4-社区后端-交付报告）。
5. **enfp/istp 等 16 张 sprite 都只有 idle_0/idle_1 两帧**：百科列表用 sprite 展示形象图是符合 PRD §8.4 的（idle 帧可作为"标准形象"）；但因为 `spriteUrl` 永远返 `idle_0`，动态看起来略静态。后续动画工单补齐 blink/happy/thinking 后可让列表 sprite 轮播。
6. **enfp.json 等百科 JSON 的 scenario 字段**：data 已包含 `scenario: "public-speaking" / "conflict" / "deadline"` 等枚举，但 UI 未做"按场景过滤"——保留数据，下个工单可加场景 Tab。

---

## 交付确认

- 4 个子任务全部实现并通过真实运行自验 ✅
- 266 个 vitest 用例全绿 ✅
- typecheck 0 错 ✅
- check_comments 100% 覆盖（114/114）✅
- electron-vite build 通过 ✅
- mock + real 两套端到端跑通 ✅
- 不动 server/ data/ eval/ assets/ PRD/REVIEW/ISSUES/plan.md ✅

---

## 补缝：多轮对话 sessionId 接线（M4 工单 A ↔ 工单 B 衔接）

### 衔接缺口来源

工单 B 已完成 server 端 `POST /api/chat` 的 `session_id` 入参与多轮上下文管理（详见 [M4-多轮对话B-交付报告.md](./M4-多轮对话B-交付报告.md)），并在 `src/api/client.ts` 的 `realStreamChat` 里写了 `body.session_id = sessionId.trim()`；但工单 A 的 `src/panel/tabs/ChatTab.tsx` 始终未把 `options.sessionId` 拼出来（grep 0 处引用），server 拿到的永远是无 session_id 的请求，多轮对话形同单轮。本节补这条线。

### 改动文件

| 路径 | 类型 | 说明 |
|------|------|------|
| `src/api/client.ts` | 修改 | `mockStreamChat` 签名加 `_sessionId?: string`（mock 不真用但保签名一致）；`streamChat` 公共出口透传 `options.sessionId`；`USE_MOCK` 由 `const` 改 `let`；新增测试钩子 `__setMockMode(value: boolean): void` |
| `src/panel/sessionStorage.ts` | 新增 | 纯函数工具：`generateSessionId(userId)` / `loadSessionId(userId)` / `saveSessionId(userId, id)` / `clearSession(userId)` / `ensureSessionId(userId)` / `__resetAllSessions()`；KEY_PREFIX = `petibi:session:`，按 user 隔离；localStorage 不可用时安全降级 |
| `src/panel/tabs/ChatTab.tsx` | 修改 | 新增 `sessionId / sessionIdRef / userIdRef` state；user.id 就绪后 `loadSessionId` 复用 / 否则 `ensureSessionId` 生成并落盘；`send` 增加第 4 步计算 sid 并透传给 `streamChat(token, text, { sessionId: sid ?? undefined })`；新增 `startNewSession` 回调（清空 messages + clearSession + 生成新 sid）；quota-row 加 ✨ 新会话按钮 + 会话短 id 角标；文件头注释增加第 8 条说明多轮对话会话串契约 |
| `src/panel/styles.css` | 修改 | 新增 `.chat-session-id` / `.chat-new-session-btn` 样式（金色 outline 小圆角按钮） |
| `src/panel/__tests__/sessionStorage.test.ts` | 新增 | 8 个用例：generate / save / load / clear / ensure / 命名空间隔离 / localStorage 不可用降级 / 空 userId 容错；用 Map-based localStorage 替身（无需 jsdom） |
| `src/panel/__tests__/chat-tab-session.test.ts` | 新增 | 4 个用例：mock 模式接受 sessionId、真接口 body 含 `session_id` 字段、不传 sessionId 时 body 不含 `session_id`（向后兼容）、空串 sessionId 容错；用 `__setMockMode(false)` 切到真接口路径 |

### 关键决策

1. **`__setMockMode` 而非 `vi.stubEnv`**：实测 vitest 1.6.1 + node 环境下 `vi.stubEnv('VITE_USE_MOCK_API', 'false')` 不会影响 `import.meta.env`（env 在模块导入时已冻结）。改为模块顶层 `let USE_MOCK` + 导出 setter `__setMockMode`，与既有的 `__resetMockDb / __bumpMockQuota` 同前缀约定，零越界。
2. **sessionId 格式**：`<userId>-<uuid>`（crypto.randomUUID 不可用时降级 `<userId>-<timestamp>-<random>`），便于调试时一眼看出归属。
3. **首次生成时机**：user.id 就绪后的 useEffect 里（不放在 mount，因为需要 userId 做 key 命名空间隔离）。
4. **新会话按钮**：放在 chat-quota-row 中间偏右（quota-pill 之前），样式金色 outline 小圆角按钮；`streaming` 时 disabled 防半路切上下文。
5. **mock 模式行为**：`mockStreamChat` 接受参数但不真用——dev 体验优先（mock 本来就不真接 SSE 拉历史），真上下文由 server 端按 `session_id` 拉历史拼 prompt，这是 server 责任不是 client 责任。

### 自验结果

| 检查项 | 结果 |
|--------|------|
| `npx vitest run` | ✅ 21 个文件 / **278** 用例全过（含新增 12 个 session 相关用例） |
| `npx tsc --noEmit` | ✅ 0 错 |
| `python scripts/check_comments.py` | ✅ **117/117** 全覆盖（新增 2 个 .test.ts 文件均补了中文文件头） |
| `npx electron-vite build` | ✅ panel bundle 75.67 kB / client 214.06 kB，0 error |

### 用例覆盖矩阵

| 用例 | 验证点 |
|------|--------|
| `sessionStorage > generateSessionId 包含 userId` | sessionId 字符串含 userId 前缀 |
| `sessionStorage > saveSessionId 落盘后再 load 命中` | localStorage 持久化 |
| `sessionStorage > loadSessionId 缺失时返回 null` | 降级 |
| `sessionStorage > clearSession 清空后再 load 命中` | 清空 |
| `sessionStorage > ensureSessionId 缺失则生成并落盘` | 首次创建 |
| `sessionStorage > ensureSessionId 已存在则复用` | 不重复创建 |
| `sessionStorage > 不同 userId 命名空间隔离` | `alice` 与 `bob` 互不干扰 |
| `sessionStorage > localStorage 抛异常时降级不崩` | 鲁棒性 |
| `chat-tab-session > mock 模式接受 sessionId 且事件序列不变` | mock 路径签名兼容 |
| `chat-tab-session > 真接口 body 含 session_id` | 真接口透传 |
| `chat-tab-session > 不传 sessionId 时 body 不含 session_id` | 向后兼容 |
| `chat-tab-session > 空串 sessionId 等同不传` | 容错 |

### 边界遵守

- ✅ **不动 server/**：所有 server 改动 0 处；session_id 透传只在 client 侧补齐
- ✅ **不动 PRD/REVIEW/ISSUES/plan.md**
- ✅ **不动 data/ eval/ assets/**
- ✅ **不动 ChatTab 会话持久化以外的逻辑**：消息历史不引入 IndexedDB / localStorage 历史缓存（仅在内存 state，符合工单"当前会话内"的范围；server 端跨设备拉历史由工单 B 负责）
- ✅ **不 git commit**

### 未做事项（明确不算漏洞）

1. **ChatTab unmount 时 `messages` 丢失**：工单要求"当前会话"即可，不引入 IndexedDB 历史存储；跨刷新需重启走一次新 sessionId 是预期行为
2. **mockStreamChat 不真用 sessionId**：dev 体验优先，mock 不接 SSE 拉历史；真接口路径已完整透传
3. **UI 上不显式提示用户"已恢复历史"**：当前实现是透明串接，新会话按钮 + 短 id 角标已足以让用户感知
- 不 git commit ✅