# M4 多轮对话 B 工单交付报告

> 里程碑：M4 收尾（工单 B）
> 工单：`docs/tech/M4-工单-整合体验包.md` §B
> 执行：子 agent（独立会话）
> 完成时间：2026-08-13
> 状态：完成（自验通过）

---

## 1. 目标回顾（来自工单）

- POST /api/chat 接收 `session_id`；server 从 `chat_logs` 拉取该会话**最近 6 轮**历史拼接进 prompt（基础层之后、用户问题之前）。
- 上下文总长 ≤2000 字做"摘要式截断"。
- 前端 ChatTab 的 UI 持久化归并行工单 A；本工单只做 **api 层 `src/api/client.ts` 加 `session_id` 参数透传**。
- 三档长度、意图过滤、输出守卫、配额等既有行为**不许回归**。

---

## 2. 改动清单

### 2.1 server 端

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `server/src/db.ts` | 修改 | `chat_logs` 表加 `session_id TEXT` 列（**幂等 ALTER**，沿用 `ensureColumn` 模式）；新增联合索引 `idx_chat_logs_user_session_time (user_id, session_id, created_at)` |
| `server/src/session.ts` | **新增** | 多轮上下文模块：<br>• `loadRecentHistory(db, userId, sessionId, limit?)` 从 `chat_logs` 取最近 N 轮（默认 6）<br>• `formatHistoryForPrompt(turns)` 拼接并"摘要式截断"（≤2000 字）<br>• 排除 `refused=1` / `guard_hit=1` 的行<br>• 排除 `session_id IS NULL` 的行（M3 之前历史） |
| `server/src/types.ts` | 修改 | `ChatRequestBody.session_id?: string`（入参）；`ChatLogRow.session_id: string \| null`（DB 行类型） |
| `server/src/routes/chat.ts` | 修改 | (a) 解析 body.session_id，空串/null 视为单轮（向后兼容）<br>(b) 拼 prompt 时：`system = 基础层 + 人格层 + 档位指令 + 多轮历史 + RAG`，历史位于"基础层之后、用户问题之前"<br>(c) 两处 `INSERT INTO chat_logs` 都增加 `session_id` 列写入 |
| `server/tests/chat-session.test.ts` | **新增** | 16 条用例：含多轮 prompt 注入、超长截断、单轮兼容、chat_logs 落库、refused 行不入历史、既有行为不回归 |

### 2.2 前端

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/api/types.ts` | 修改 | `ChatRequestBody.session_id?: string` 透传类型 |
| `src/api/client.ts` | 修改 | `streamChat` 增加 `options.sessionId?: string`；`realStreamChat` 把 `session_id` 拼到 fetch body（mock 模式仍按原链路） |

### 2.3 未触碰

- `src/panel/` 全部文件（含 `tabs/ChatTab.tsx` UI 持久化）—— **归并行工单 A**。
- `data/`、`eval/`、`assets/`、`PRD.md` / `REVIEW.md` / `ISSUES.md` / `plan.md`。
- 未执行 `git commit`（按工单要求）。

---

## 3. 设计要点

### 3.1 为什么把历史拼进 `system` 而不是 `user` 角色

`personas.ts` 的基础层 + 人格层 + 档位指令已经全部写在 `system`。M3 链路里 LLM 通过 `[系统] → [用户]` 两段式判断上下文。

把多轮历史追加到 `system` 末尾（"基础层之后、用户问题之前"），模型会把它当成"对话设定"而非"用户的新指令"，避免注入攻击或用户-上下文混淆（用户的历史问题里若出现 `python` / `忽略之前指令` 之类，不会被当成本轮要求）。

### 3.2 摘要式截断规则（`session.ts`）

- 历史块按"轮 N｜用户：…\n助手：…"格式拼接。
- 总长（`blocks.join('\n\n').length + header.length + 1`）超 2000 时，从**最旧**轮次开始整轮丢弃（不切到词中间）。
- 至少保留 1 轮（单轮过长也保留，避免上下文断流）。
- 发生过丢弃时尾部追加"（更早的对话轮次已省略）"。
- 极端情况（单轮本身就 >2000）硬上限保护：用 `slice(0, MAX-1) + "…"` 兜底，绝不破 2000。

### 3.3 排除 `refused=1` / `guard_hit=1`

- `refused=1`：意图过滤命中的"拒绝模板"，不是真实对话。
- `guard_hit=1`：M3 输出守卫拦截后改用拒绝模板，同样不是真实对话。

把"用户问写代码 → 被拒 → 用户道歉"作为历史会让 LLM 误以为这是有效上下文，污染人格对话体验。

### 3.4 `session_id` 兼容写法

- 不传 / 传 `""` / 传 `null` → 路由层统一归一为 `null`，`loadRecentHistory` 直接返回 `[]`，行为等同于 M3 单轮。
- 落库：`session_id` 为 `null` 时写 NULL 列（与 M3 之前数据兼容）；非 null 时落字符串。

### 3.5 既有三档 / 守卫 / 配额 / 意图过滤不回归

- 历史拼接点位于 prompt 拼接阶段，**在档位判定之后**；档位判定 `decideReplyTier` / 流式守卫 `createStreamGuard` / 终检 `applyOutputGuard` 均无改动。
- 配额 `consumeOrThrowQuota` 调用时机不变。
- 意图过滤 `checkIntent` 命中 → 流式返回拒绝模板 → 落库 `refused=1`，与 M3 一致。
- chat-stream.test.ts 24 条用例全部继续通过（自验 §4）。

---

## 4. 自验（真实运行输出）

### 4.1 `npx vitest run`（server 端，新写的多轮测试）

```
 RUN  v1.6.1 C:/Users/19802/Desktop/ClaudeCodeTest/MBTIwilldo/server

(node:32484) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/chat-session.test.ts  (16 tests) 276ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Duration  2.11s
```

**16/16 通过**：
- `formatHistoryForPrompt` 单元 5 条（空轮次、单轮、多轮顺序、不超阈值不追加提示、超长做摘要式截断、硬上限保护）。
- `loadRecentHistory` 单元 2 条（空 sessionId 防御、SQL 排除规则）。
- POST /api/chat 集成 9 条（第二轮 prompt 含第一轮、单轮兼容、空串兼容、落库 session_id=非 null、落库 session_id=NULL、超长历史截断、refused 行不入历史、既有行为不回归）。

### 4.2 `npx vitest run tests/chat-stream.test.ts`（既有回归）

```
 ✓ tests/chat-stream.test.ts  (24 tests) 327ms

 Test Files  1 passed (1)
      Tests  24 passed (24)
```

**24/24 通过**——M3 流式守卫与三档工单行为完全不回归。

### 4.3 `cd server && npx vitest run`（server 全量）

```
 Test Files  13 passed (13)
      Tests  155 passed (155)
   Duration  4.69s
```

**155/155 通过**（含本次新增的 16 条）。既有 139 条全过。

### 4.4 `cd 根 && npx vitest run`（根 vitest，含 server + scoring + panel + share）

```
 Test Files  19 passed (19)
      Tests  266 passed (266)
   Duration  25.65s
```

**266/266 通过**。

### 4.5 `npm run typecheck`（根 typecheck）

```
> petibi@0.1.0 typecheck
> tsc --noEmit
```

0 错误。

### 4.6 `cd server && npx tsc --noEmit`（server 子项目 typecheck）

0 错误。

### 4.7 `python scripts/check_comments.py`

```
中文文件头覆盖率 = 115/115
检查通过：全部源文件均有中文文件头注释
exit=0
```

红线 R9 通过：本次新增的 `server/src/session.ts`（开头"【文件说明】多轮对话 session 模块…"）和 `server/tests/chat-session.test.ts`（开头"【文件说明】M4 多轮对话 session 集成测试…"）均带中文头注释。

### 4.8 多轮对话行为真实验证（集成用例 `第二轮对话时 prompt 包含第一轮 question + answer`）

测试逻辑：
1. 第一轮用独特关键字"独创词XYZ-123"作为 question，session_id=`multi-1`，mock 给一段 `"（第一轮回答）"`。
2. 第二轮同 session_id，mock 给 `"（第二轮回答）"`，断言传给 LLM 的 `system` 包含：
   - `"对话历史"`（拼接头）
   - `"用户：第一轮问题独创词XYZ-123"`
   - `"助手：（第一轮回答）"`
3. 同时 `lastUser` 包含 `"第二轮问题"`（验证本轮 question 没被历史覆盖）。

实测输出（节选）：
```
✓ POST /api/chat 多轮对话（M4 多轮对话 B §B1） > 第二轮对话时 prompt 包含第一轮的 question + answer（mock 验证 lastSystem 含历史）
```

### 4.9 超长截断真实验证（集成用例 `超长历史做摘要式截断`）

测试逻辑：
1. 准备 6 轮历史，每轮 600 字（拼接后 ≈3600+，远超 2000 阈值），session_id=`long-sess`。
2. 触发新一轮对话。
3. 断言截取的 `system` 中历史段落包含 `"已省略"`，且总长 ≤ 2000 字。

实测输出（节选）：
```
✓ POST /api/chat 多轮对话（M4 多轮对话 B §B1） > 超长历史做摘要式截断：总长 ≤ 2000 字 + 含'已省略'提示
```

---

## 5. 契约对齐

- 入参：`POST /api/chat` body 新增可选 `session_id: string`；不携带时行为与 M3 完全一致。
- 出参：`SSE` 事件序列不变（meta / delta / guard / done / error），未引入新事件。
- DB：`chat_logs` 表新增 `session_id TEXT` 列（可空，旧库兼容），新增联合索引 `idx_chat_logs_user_session_time`。
- 类型：`server/src/types.ts` 与 `src/api/types.ts` 同步新增 `session_id?` 字段，前后端类型一致。

---

## 6. 风险与后续

- **session_id 是客户端生成的字符串**，未做格式校验（UUID/任意字符串皆可）。M5 之前可考虑：(a) 限制长度（如 ≤64 字）；(b) 仅接受字母数字+连字符，避免 SQL 注入或日志污染。本工单按工单要求仅做"基础层"接入，未做这些限制。
- **历史不含被拒 / 被守卫拦截的轮次**——若产品希望"用户尝试越界 → 桌宠拒绝 → 用户道歉 → 桌宠改话题"也作为上下文保留下来，需调整 `loadRecentHistory` 的 WHERE 条件。本工单按工单 §B1 的"上下文摘要式截断"语义保守选择排除。
- **未做服务端主动清理**：旧的 `session_id` 会一直占用 `chat_logs` 行；M5 之前可加按 `(user_id, session_id, created_at)` 的归档/清理策略。
- **前端 UI 持久化（localStorage / IndexedDB）归并行工单 A**。本次只做 API 层透传。

---

## 7. 交付结论

✅ 工单 B §B1（多轮会话记忆）：完成
✅ 工单 B §B2（自验清单）：完成（多轮用例 + 超长截断 + server/根 vitest 全过 + typecheck 0 错 + check_comments 通过）

未执行 `git commit`（按工单要求）。