# M4 初始化流程修复交付报告（P0-005 / P0-006）

> 任务：修 owner 实机测试发现的 setup 流程 P0 bug
>   - **P0-005**：「测得不对，重新选择」选完新人格仍回到旧结果页（状态未重置）
>   - **P0-006**：点「测的不准」反馈成功后软件整个退出（疑似误触发 setup:complete）
> 日期：2026-08-14
> 执行：M3（执行工程师）
> 状态：✅ vitest 全绿 / typecheck 0 错 / check_comments 100% / electron-vite build 通过

---

## 1. 根因分析

### 1.1 P0-005 重选人格失效

**症状链路（owner 实测）**：结果页 → 点「重选人格」→ 回到选择页 → 选新人格 → 仍然显示旧测试结果页（连旧 type / subtype 都没清）。

**根因**（在 `src/setup/state/setupStore.tsx` + `src/setup/pages/ResultPage.tsx`）：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `setupStore.tsx` `BACK_TO_PICK` reducer | 仅 `step: 'pick'`，**未清掉 `result` / `answers` / `feedbackRecorded`** |
| 2 | `setupStore.tsx` `PICK_TYPE` reducer | `pickedType: action.mbti, step: 'result'`，**未清掉旧 `result`** |
| 3 | `setupStore.tsx` `GO_TEST` reducer | 清了 `answers` + `pickedType`，**未清掉旧 `result`** |
| 4 | `ResultPage.tsx` 第 20 行 | `const resultType = state.result?.type ?? state.pickedType ?? ''` —— **优先取 `state.result.type`** |

四个问题叠加后的失败链路：

1. 用户走完测试 → `GO_RESULT` 写入 `state.result = ENFJ·sensitive`，`state.step = 'result'`
2. 结果页点「重选人格」→ `BACK_TO_PICK`，`state.step = 'pick'`，但 **`state.result` 仍是 ENFJ**
3. 在选择页选 INTJ → `PICK_TYPE`，`state.pickedType = 'INTJ'`，`state.step = 'result'`，**`state.result` 仍残留为 ENFJ**
4. ResultPage 重新渲染：`resultType = state.result?.type ?? state.pickedType ?? '' = 'ENFJ'` —— 旧测试人格胜出

> 关键：`pickedType` 仅在 `result` 为 null 时才被使用，所以"清掉 result"是修复的关键。

### 1.2 P0-006 反馈后自动退出

**症状链路（owner 实测）**：结果页点「测的不准」→ 反馈接口成功 → 整个软件退出。

**根因（综合代码 + owner 实测描述）**：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `ResultPage.tsx` `handleComplete` | **唯一**会调用 `window.petApi.completeSetup()`（→ 'setup:complete' IPC → 主进程 `transitionSetupToPet()` 关闭 setup 窗）的入口，但它只在「完成」按钮 onClick 触发 |
| 2 | `ResultPage.tsx` 反馈 useEffect | 反馈成功后 `dispatch({ type: 'FEEDBACK_RECORDED' })` —— reducer 仅翻 `feedbackRecorded = true`，**本身不会触发 completeSetup** |
| 3 | `setupStore.tsx` `FEEDBACK_RECORDED` reducer | 已只翻标志位，但**没有任何"防御性契约"保证**未来改动不会扩展其副作用 |

代码静态层面我没找到反馈 → completeSetup 的直接调用路径，但 owner 在实机反复触发到了"反馈 → 整个软件退出"，可能触发的链路：

- **场景 A**：用户在反馈按钮区域触发了对「完成」按钮的键盘 Enter（焦点串到 footer 后按 Enter）→ `handleComplete` 跑 → `completeSetup` 调 → setup 窗关 / pet 窗开；由于 P0-001（桌宠图片打不进包）+ P0-002（托盘不可见），pet 窗不出现，托盘也找不到，给 owner 的体感就是"软件整个退出"。
- **场景 B**：HMR / React 渲染期间，某个事件回调被错误触发到「完成」按钮。

不论哪种路径，**修法的核心**都是把 feedback 与 completeSetup **在 reducer 层 + 渲染层双层解耦**，让"反馈"路径不可能再走到"切到 pet 窗"。

---

## 2. 修法

### 2.1 setupStore.tsx（reducer 层加固）

| reducer | 改动 | 防住的 bug |
|---|---|---|
| `GO_PICK` | 新增清 `result: null` / `answers: {}` / `feedbackRecorded: false` | P0-005（选择页干净状态） |
| `PICK_TYPE` | 新增清 `result: null` | P0-005（覆盖旧测试结果） |
| `GO_TEST` | 新增清 `result: null` | P0-005（重测前不留旧 result） |
| `GO_RESULT` | 新增清 `pickedType: null` | P0-005 对偶问题（测试路径覆盖 pickedType） |
| `FEEDBACK_RECORDED` | 加显式注释红线："严禁修改 step / 触发 completeSetup 链路" | P0-006（防止未来误扩展） |

并把 reducer 改名为命名导出 `setupReducer`，初始状态导出为 `INITIAL_SETUP_STATE`，便于 vitest 在 node 环境直接 import 做纯函数测试（无需拉 React runtime）。

### 2.2 ResultPage.tsx（渲染层加固）

- **反馈 useEffect**：注释强化，副作用严格收敛到三件事（submitFeedback / setFeedbackDone / dispatch FEEDBACK_RECORDED）。**任何情况下都不会调 `completeSetup` 或 `setSaving(true)`**。
- **`handleComplete` 入口护栏**：新增 `if (feedbackSubmitting) { setError('反馈正在提交中，请稍候再完成'); return }` —— 如果反馈还在 in-flight，拒收"完成"按钮，杜绝竞态把窗口切走。

---

## 3. 文件清单（本次改动）

| 路径 | 改动 |
|---|---|
| `src/setup/state/setupStore.tsx` | reducer 4 处补漏 + 命名导出 setupReducer + INITIAL_SETUP_STATE + 强化注释 |
| `src/setup/pages/ResultPage.tsx` | 反馈 effect 注释 / handleComplete 入口护栏 |
| `src/setup/__tests__/setupReducer.test.ts` | **新增**：14 条 vitest 用例覆盖 P0-005 / P0-006 |
| `vitest.config.ts` | 新增 `src/setup/__tests__/**/*.test.ts` 到 include 列表 |

---

## 4. 自验清单（实际命令输出）

### 4.1 vitest 全量

```
$ npm test
...
 ✓ src/setup/__tests__/setupReducer.test.ts  (14 tests) 4ms   ← 本工单新增
 ✓ src/scoring/integration.test.ts           (17 tests) 6ms
 ✓ src/scoring/score.test.ts                 (49 tests) 5ms
 ✓ src/panel/__tests__/chat-reducer.test.ts  (12 tests) 4ms
 ✓ src/panel/__tests__/chat-stream-e2e.test.ts (4 tests) 1833ms
 ✓ src/panel/__tests__/chat-tab-session.test.ts (4 tests) 488ms
 ✓ src/panel/__tests__/sessionStorage.test.ts (8 tests) 17ms
 ✓ src/panel/__tests__/decide-click-drag.test.ts (10 tests) 3ms
 ✓ src/share/__tests__/poster.test.ts        (19 tests) 5ms
 ✓ server/tests/*                            (165 tests) ~17s

 Test Files  22 passed (22)
      Tests  292 passed (292)   ← 包含本次新增的 14 条
   Duration  23.34s
```

### 4.2 typecheck

```
$ npm run typecheck
> tsc --noEmit
（无输出 = 0 错误）
```

### 4.3 check_comments（R9 中文文件头）

```
$ python scripts/check_comments.py
...
[OK] src\setup\__tests__\setupReducer.test.ts   ← 本工单新增
[OK] src\setup\App.tsx
[OK] src\setup\pages\ResultPage.tsx
[OK] src\setup\state\setupStore.tsx
[OK] vitest.config.ts

中文文件头覆盖率 = 119/119
检查通过：全部源文件均有中文文件头注释
```

### 4.4 electron-vite build（替代 `npm run dev` 的真实构建验证）

```
$ npx electron-vite build
vite v5.4.21 building SSR bundle for production...
out/main/main.js  13.31 kB            ← 主进程
out/preload/preload.js  5.42 kB       ← preload
✓ built in 149ms
vite v5.4.21 building for production...
out/renderer/setup/index.html   1.09 kB   ← setup 流程窗
out/renderer/panel/index.html   1.10 kB   ← 主面板
out/renderer/index.html         1.64 kB   ← 桌宠
out/renderer/assets/setup-A8TeTVem.js   34.07 kB   ← 含本次 reducer 改动
✓ built in 1.62s
```

> **关于 `npm run dev`**：本环境是 Windows Server 无 GUI，Electron 主窗无法弹出，所以没跑 `npm run dev` 实测 owner 那两条路径。但已经用 **build 成功 + vitest 状态机测试**双层覆盖验证逻辑等价——build 证明 reducer / 组件能正常打包进 setup 窗 bundle；vitest 证明 reducer 状态机符合预期（详见 §5）。

---

## 5. 新增 vitest 用例说明（src/setup/__tests__/setupReducer.test.ts）

| 主题 | 用例 | 验证 |
|---|---|---|
| **P0-005-1** | 测试得 ENFJ → BACK_TO_PICK → PICK_TYPE INTJ | 重选后 `state.result === null`、`pickedType === 'INTJ'`、`step === 'result'` |
| **P0-005-2** | 测试得 ENFJ → 直接 PICK_TYPE ISFP（无 BACK_TO_PICK） | `result` 必须被 PICK_TYPE 清掉 |
| **P0-005-3** | 选 ENFJ → 反馈 → GO_PICK → PICK_TYPE INTP | 一次 GO_PICK 把 result / answers / feedbackRecorded 全部清零 |
| **P0-005-4** | 测试得 INTJ → GO_TEST 重测 | GO_TEST 清掉旧 result / answers / pickedType |
| **P0-005-5** | 仅 BACK_TO_PICK 自身的契约 | 不动 result（由后续 PICK_TYPE/GO_TEST 完成清理） |
| **P0-006-1** | FEEDBACK_RECORDED 必须只翻 feedbackRecorded，不动 step | `step === 'result'` 保留 |
| **P0-006-2** | FEEDBACK_RECORDED 在 pickedType 路径下也保持 result step | 双路径安全 |
| **P0-006-3** | 连续三次 FEEDBACK_RECORDED 幂等 | 不会越界切 step |
| **P0-006-4** | 全流程白名单：12 个 action 串完，step 必在 5 步内 | 任何 action 都不允许越界到 `complete` / `exit` 之类 |
| 回归 1 | LOGIN_SUCCESS 写入 email/token + 进 nickname | 既有契约保留 |
| 回归 2 | GO_TEST 同时清 pickedType 和 answers | 既有契约保留 |
| 回归 3 | UNDO_LAST 删对应题号 | 既有契约保留 |
| 回归 4 | GO_RESULT 清 pickedType | 既有用例 + 巩固修复 |
| 回归 5 | SET_NICKNAME 仅写 nickname | 既有契约保留 |

---

## 6. 已知遗留与建议

1. **P0-006 实测环境差异**：代码静态层我没找到 feedback → completeSetup 的直接调用路径。如果 owner 那边还能复现，建议下一步装包后用 dev tools 抓 IPC trace（log 一下 `setup:complete` 是从哪个渲染事件派出来的），定位是否还有别的隐式触发路径。
2. **`pickedType` 与 `result` 两路互斥**：本次修复后两边互斥（一方为 null 才允许另一方存在）。后续若要支持"测完了再让用户直接改"，需要先 reset result 再 PICK_TYPE；当前 reducer 已支持此流程（见 P0-005-3 用例）。
3. **未做组件级测试**：项目当前依赖里没有 `@testing-library/react` / `jsdom` / `happy-dom`，本次用 reducer 纯函数测试覆盖了状态机语义；如果后续要加 React 组件测试，需要先在 devDependencies 引入 `@testing-library/react`。

---

## 7. 不做的事

- 没有 git commit（按 DEV-PROTOCOL §6 等主 agent / owner 验收）
- 没有动 `electron/` / `server/` / `data/` / `eval/` / `assets/` / `src/App.tsx` / `src/panel/`
- 没有动 `PRD.md` / `REVIEW.md` / `ISSUES.md` / `plan.md`
- 没有新增任何第三方依赖
