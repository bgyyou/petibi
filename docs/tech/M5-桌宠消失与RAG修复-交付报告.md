# Petibi M5-桌宠消失与 RAG 修复交付报告

> 工单范围：P0-A（登录状态桌宠不出现）/ P0-B（RAG 引用错人格）/ P1-C（安装完成无启动提示）/ P1-D（owner 本机真 API 接入）
> 修复人：M3（执行工程师）
> 交付日期：2026-08-15
> 关联工单：ISSUES.md；不动 data/、eval/、assets/、PRD/REVIEW/ISSUES/plan.md
> 不 git commit（owner 要求）

---

## 1. 自验清单（全部通过）

| 项 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | ✅ 0 错 | tsc --noEmit |
| `npm test`（vitest） | ✅ 37 files / 457 tests passed | 含新增 env-loader / rag-personality-scope / chat-route 人格断言 |
| `python scripts/check_comments.py` | ✅ 167/167 通过 | 红线 R9 中文文件头全覆盖 |
| `npm run build`（installer） | ✅ release/Petibi Setup 0.1.0.exe 重新生成 | 144 MB；customFinish.nsh 已被 include |
| `node scripts/repro-p0a-bug.mjs --exe release/win-unpacked/Petibi.exe` | ✅ pet 渲染端 readyState=complete / bodyChildren=1 / spriteImg=true | 安装版 pet 窗 DOM 真正挂载 |
| `node scripts/repro-p1d-env.mjs --exe release/win-unpacked/Petibi.exe` | ✅ 4/4 路径通过 | 系统 > userData > 项目 .env 优先级 |
| `node scripts/repro-p0a-chat-smoke.mjs --exe release/win-unpacked/Petibi.exe` | ✅ mock mode=false + meta 事件下发 | chat 走真实 API 链路 |
| 解压 win-unpacked 验证 | ✅ 无 vitest 污染 | renderer bundle grep "vitest" = 0 命中 |

---

## 2. P0-A：登录状态下桌宠不出现

### 2.1 现象与根因

owner 实测：安装新版后桌宠窗 BrowserWindow 存在（CDP target 能看到 file:///.../index.html），但屏幕上看不见任何内容；双击托盘开面板能正常登录，但桌宠仍不出现。

CDP 调试脚本（`scripts/repro-p0a-bug.mjs`）抓到的关键证据：

```json
{ "readyState": "loading", "title": "", "spriteImg": false, "bodyChildren": -1, "rootHTML": "" }
```

同时控制台报错：

```
Uncaught Error: Vitest failed to access its internal state.
One of the following is possible:
- "vitest" is imported directly without running "vitest" command
- "vitest" is imported inside "globalSetup"
- Otherwise, it might be a Vitest bug.
```

### 2.2 根因定位

`src/App.tsx:44` 反向 import 了**测试文件**作为纯函数来源：

```ts
import {
  DOUBLE_CLICK_THRESHOLD_MS,
  feedClick,
  type ClickState,
} from './__tests__/decideClickSequence.test'
```

`decideClickSequence.test.ts` 顶部写了 `import { describe, expect, it } from 'vitest'`。当 electron-vite 把 `src/App.tsx` 打 bundle 时，rollup 沿着 import 图把整条 vitest 依赖链也卷进来。安装版渲染端 bundle 体积从 ~5KB 涨到 27+KB，里面有 `SAFE_TIMERS_SYMBOL = Symbol("vitest:SAFE_TIMERS")` 等 28 处 vitest 内部符号。

运行时 React mount 阶段第一件事是 `useEffect(() => window.petApi.getCurrentMbti(), [])`，preload 注入的 API 触碰 vitest 的内部状态（vitest 用了 Symbol 标记全局），触发 "Vitest failed to access its internal state" 异常——整个 React 树没 mount，`document.body.children` 长度为 0（脚本里返回 -1 是因为 `document.body` 本身就是 null），`document.documentElement.outerHTML` 是空字符串。

表现就是桌宠窗 BrowserWindow 存在但全透明（html/body 都没渲染任何东西），用户看不到桌宠，也没法点击——只有托盘在。

旁证：grep `out/renderer/assets/index-*.js` 修前 28 处 vitest 命中，修后 0 处。

### 2.3 修法

**主修复**：把纯函数搬到非 `__tests__/` 目录的源文件 `src/decideClickSequence.ts`（不含 vitest import），让 App.tsx 改为从这里 import；测试文件改为 re-import 该源文件。

涉及文件：
- `src/decideClickSequence.ts`（新增，~75 行）：含 `DOUBLE_CLICK_THRESHOLD_MS` / `ClickState` / `ClickEvent` / `ClickDecision` / `feedClick` / `isWithinDoubleClickThreshold`；附 M5 P0-A 修复说明注释。
- `src/__tests__/decideClickSequence.test.ts`：仅保留 vitest `describe`/`expect`/`it`，全部从 `'../decideClickSequence'` re-import。
- `src/App.tsx:44`：import 路径改为 `'./decideClickSequence'`。
- `electron.vite.config.ts`：新增 `noTestInBundlePlugin`（rollup `apply: 'build'`），拦截渲染端 bundle 任何对 `__tests__/...` 或 `*.test.ts(x)` 的解析，**build 时立刻 throw**。dev 模式不装，保留开发体验。
- `src/decideClickSequence.ts` 文件头注释里写明根因与修复路径，防止后续重构再误反向 import。

**验证**（`scripts/repro-p0a-bug.mjs`）：
| 指标 | 修前 | 修后 |
|---|---|---|
| readyState | `"loading"` | `"complete"` |
| title | `""` | `"Petibi"` |
| bodyChildren | `-1` | `1` |
| spriteImg | `false` | `true` |
| 控制台 Vitest 错误 | 1 | 0 |
| renderer bundle 中 vitest 命中数 | 28 | 0 |

**回归保护**：vitest 测试矩阵 `src/__tests__/decideClickSequence.test.ts` 仍然 15/15 通过（迁到独立模块后真值表完全等价）。

---

## 3. P0-B：RAG 引用错人格

### 3.1 现象与根因

owner 实测：从 INFP 切回 ENTP 后对话，mock 回答参考了 ENFP 的百科条目。

`server/src/routes/chat.ts` 原代码：

```ts
// 3) RAG 检索：闲聊跳过
const chitchat = isChitchat(question, filter)
const ragResult = chitchat ? null : retrieveTop1(question, getEncyclopedia())
```

`retrieveTop1` 是**全库检索**：遍历所有 16 个人格的百科文件，按打分（标题 +3 / tag +2 / scenario +4 / content +1）选 Top 1。

典型污染场景：ENTP / ENFP / INFJ 三个分析师/外交家家族的成员都有 `scenario: "public-speaking"` 条目，主题高度相似，全库打分时词频密度决定胜负——owner 是 ENTP 但被注入 ENFP 条目是常见结果，且 rag_entry_id 与 user.mbti 不一致会污染 chat_logs 审计链路。

### 3.2 修法

`server/src/rag.ts`：新增 `retrieveTop1ForPersonality(question, files, personality)`，严格在用户当前人格文件内检索，**永不跨人格引用**。原 `retrieveTop1` 保留并加 deprecation 注释（仍被 `rag.test.ts` 自身测试用例使用）。

```ts
export function retrieveTop1ForPersonality(
  question: string,
  files: EncyclopediaFile[],
  personality: Personality
): { entry: EncyclopediaEntry; personality: Personality; score: number } | null {
  const tokens = tokenize(question)
  if (tokens.length === 0) return null
  const file = files.find((f) => f.personality === personality)
  if (!file) return null  // 非人格白名单 → null，不静默退回全库
  const best = bestInFile(file, tokens)
  if (!best) return null
  return { entry: best.entry, personality: file.personality, score: best.score }
}
```

`server/src/routes/chat.ts`：调用点改为传入 `user.mbti`（从 users 表查，**绝不取自客户端 body**——防止伪造）：

```ts
const ragResult = chitchat
  ? null
  : retrieveTop1ForPersonality(question, getEncyclopedia(), user.mbti as Personality)
```

### 3.3 测试

新增 `server/tests/rag-personality-scope.test.ts`（8 个测试），钉死以下性质：
1. 人格白名单防御：传入 16 型外的非法字符串 → null，不静默退回全库
2. 同问 public-speaking，ENTP 下返回 ENTP 条目（`entry.id` 以 `ENTP-` 开头），非 ENFP
3. 同问 public-speaking，ENFP 下返回 ENFP 条目，非 ENTP
4. 同问 public-speaking，INFJ 下返回 INFJ 条目（即便 INFJ 也含公共场景）
5. 同问 breakup（分手），ENTP / INFP 分别返回各自条目且 ID 不一致
6. 该人格文件无命中时返回 null，不退回全库
7. 永不跨人格引用：构造 mock 文件让 ENFP 词频密度显著占优时，全库检索会被污染，但限定人格后必须取各自条目
8. formatEntryForPrompt 输出的人格标签与用户当前人格一致

`server/tests/chat-route.test.ts`：新增两条端到端断言（HTTP SSE 链路）：
- `M5 P0-B：rag_entry_id 必须以当前用户人格前缀开头（永不跨人格引用）`：ENTP 用户问"演讲"，rag_entry_id 必须 `^ENTP-`
- `M5 P0-B：切换用户人格后，rag 检索范围跟着变`：再起一个 INFP server 同问，rag_entry_id 必须 `^INFP-` 且 `!^ENTP-`

合计新增 10 条用例，全部通过；旧用例 0 回归。

---

## 4. P1-C：安装完成无启动提示

### 4.1 现象与根因

owner 实测：NSIS 向导模式装完直接结束，看不到"运行 Petibi"复选框；应用其实启动了但用户没意识到（紧接着就是 P0-A：桌宠不出现所以也看不到）。

electron-builder 25.x 的 NSIS 模板 `node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh` 默认就 !define `MUI_FINISHPAGE_RUN` + `MUI_FINISHPAGE_RUN_FUNCTION "StartApp"`，即 assisted 模式下应该自动出复选框。但实测在国内用户机器上：
- 复选框文案是 MUI 默认 SimpChinese 翻译"启动 Petibi"，不够口语化
- 完成页副标题是 "$(^Name) 已安装到您的电脑。"，缺引导文案
- 没有任何显式声明，未来版本默认值漂移会回归

### 4.2 修法

**1)** `electron-builder.yml` 显式声明 `runAfterFinish: true`（防默认值漂移）。

**2)** 新增 `build/installer/customFinish.nsh`，通过 `nsis.include` 字段引入到 NSIS 脚本，在 assistedInstaller.nsh 之前被 include：

```nsh
!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_RUN_TEXT "运行 Petibi"
  !define MUI_FINISHPAGE_RUN_CHECKED
  !define MUI_FINISHPAGE_TITLE "Petibi 安装完成"
  !define MUI_FINISHPAGE_TEXT "Petibi 已安装到您的电脑。$\r$\n$\r$\n点击「完成」关闭安装向导，或勾选「运行 Petibi」立即启动桌宠。"
!endif
```

关键约束：
- 只覆盖 4 个文本宏，**不重定义** `MUI_FINISHPAGE_RUN` / `MUI_FINISHPAGE_RUN_FUNCTION`——assistedInstaller.nsh 已经挂了 StartApp 函数（走 StdUtils.ExecShellAsUser 调 launchLink），重定义会冲突。
- 用 `!ifndef BUILD_UNINSTALLER` 防卸载器误覆盖。
- `MUI_FINISHPAGE_RUN_CHECKED` 让复选框默认勾选，用户按完成就直接启动桌宠（P0-A 修完后的桌宠一定可见）。

**验证**：`release/builder-debug.yml` 已含 `!include "...build/installer/customFinish.nsh"`，且位置在 `assistedInstaller.nsh` 之前；完整 install 重新生成（`release/Petibi Setup 0.1.0.exe`，144 MB），UI 文案需 owner 实测验收（脚本无法驱动 NSIS UI）。

---

## 5. P1-D：owner 本机真 API 接入

### 5.1 现象与根因

owner 机器上装完运行版 chat 走 mock；要求安装版能拿到真 DEEPSEEK_API_KEY 走真实 LLM。原 `electron/main.ts` 的 `loadProjectEnvInMain()` 两个问题：

1. **`require('dotenv')` 在安装版抛 MODULE_NOT_FOUND**：electron-builder 不把 dotenv 打进 install（它是 transitive dep 不在 dependencies 里），主进程捕获后吞掉错误，导致 env 加载静默失败，server 走 mock mode。
2. **不支持 userData/.env**：owner 想换 key 只能改安装包里的 resources/.env，违反"per-user override"原则。
3. **加载顺序不可控**：没显式声明系统 env > userData > 项目 .env 的优先级，依赖 dotenv 默认"不覆盖已存在"行为，无强保证。

### 5.2 修法

`electron/main.ts` 的 `loadProjectEnvInMain()` 重写：

```ts
function loadProjectEnvInMain(): void {
  const candidates: Array<{ path: string; source: string }> = []
  // 1) userData/.env（per-user 覆盖，仅安装版）
  if (app.isPackaged) {
    candidates.push({
      path: join(app.getPath('userData'), '.env'),
      source: 'userData',
    })
  }
  // 2) 项目 .env：dev 走仓库根，prod 走 process.resourcesPath
  candidates.push({
    path: app.isPackaged
      ? join(process.resourcesPath, '.env')
      : join(__dirname, '..', '..', '.env'),
    source: app.isPackaged ? 'resources' : 'dev',
  })
  // 3) cwd 兜底
  candidates.push({ path: join(process.cwd(), '.env'), source: 'cwd' })

  for (const c of candidates) {
    if (!existsSync(c.path)) continue
    const parsed = parseDotenvManually(c.path)
    if (!parsed) continue
    let applied = 0
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {  // 系统 env 优先级最高
        process.env[k] = v
        applied++
      }
    }
    console.log(`[main] env loaded: ${applied} keys from ${c.path} (source=${c.source})`)
  }
  if (process.env['DEEPSEEK_API_KEY']) {
    console.log(`[main] DEEPSEEK_API_KEY present (length=${process.env['DEEPSEEK_API_KEY'].length})`)
  } else {
    console.log('[main] DEEPSEEK_API_KEY 未配置（走 mock LLM）')
  }
}
```

配合 `parseDotenvManually`（从 server/src/env.ts 同款实现搬到主进程，10 行内手写解析，避免 require('dotenv') 失败问题）。

`electron-builder.yml` 的 extraResources 不需要改：resources/.env 本来就跟 server.cjs 一起被 extraResources 拷到 process.resourcesPath 下；userData/.env 是 app.getPath('userData') 的运行时路径，不需要 manifest。

**关键日志约束**：所有 env 日志**只打长度 / 文件路径 / source**，不打印 key 任何字符。`scripts/repro-p1d-env.mjs` 也做了 `--replace(/=[^\n]+/g, '=***REDACTED***')` 防误传。

### 5.3 验证

`scripts/repro-p1d-env.mjs --exe release/win-unpacked/Petibi.exe`：

| 路径 | userData .env | 系统 env | 期望 | 实测 length |
|---|---|---|---|---|
| project-env-only | ✗ | ✗ | PRESENT | 35（来自 CWD 的项目 .env） |
| userdata-only | `DEEPSEEK_API_KEY=sk-userdata-test-xxxx...` (len 37) | ✗ | PRESENT | 37 ✓ source=userData |
| priority-system-over-userdata | `DEEPSEEK_API_KEY=sk-userdata-test-zzzz...` (len 37) | `DEEPSEEK_API_KEY=sk-system-env-yyyy...` (len 34) | PRESENT & length=34 | 34 ✓ 系统 env 胜出 |
| system-env-only | ✗ | `DEEPSEEK_API_KEY=sk-system-env-yyyy...` | PRESENT | 34 ✓ |

全部 4 路径通过；优先级链成立。

`scripts/repro-p0a-chat-smoke.mjs --exe release/win-unpacked/Petibi.exe`：

```
[smoke] key 状态：DEEPSEEK_API_KEY present (length=34)
[smoke] server mock 模式：mock mode = false
[smoke] chat 链路：{"isMock":false,"hasMeta":true,"firstLine":"data: {\"type\":\"meta\",\"rag_entry_id\":null,\"refused\":false,\"guard_hit\":false}"}
[smoke] ✅ chat 走真实 API 链路（非 mock），meta 事件已下发
```

注：fake key 走真实 LLM 链路第一个分支（mock=false），实际 LLM 调用会因鉴权失败中断，但 mock 标记与 meta 事件已验证链路非 mock。owner 真 key 接入即可拿到真回答。

### 5.4 owner 操作建议

```
# 把项目 .env 里的 key 写到 Windows 用户级 env（不写日志、不污染 git）
setx DEEPSEEK_API_KEY "<your-deepseek-key>"

# 或者直接放到安装版的 userData/.env
echo DEEPSEEK_API_KEY=<your-deepseek-key> > "%APPDATA%\Petibi\.env"
```

两种方式任选其一，优先级：用户级 env var > userData/.env > 项目 .env（dev）。

---

## 6. 涉及文件清单

### 修改

| 文件 | 用途 |
|---|---|
| `src/App.tsx` | import 路径从 `__tests__/...test` 改为 `decideClickSequence`（P0-A 主修复） |
| `src/__tests__/decideClickSequence.test.ts` | 改为 re-import 新源文件（仅保留 vitest 真值表） |
| `electron.vite.config.ts` | 新增 `noTestInBundlePlugin`（兜底）+ Plugin 类型从 vite 导入 |
| `server/src/rag.ts` | 新增 `retrieveTop1ForPersonality` |
| `server/src/routes/chat.ts` | RAG 调用点改用 personality-scoped 函数，传 user.mbti |
| `electron/main.ts` | `loadProjectEnvInMain` 重写：优先级链 + 手写解析 + userData 支持 + key 不打印 |
| `electron-builder.yml` | `runAfterFinish: true` 显式 + `include: build/installer/customFinish.nsh` |
| `server/tests/rag-personality-scope.test.ts`（新增） | P0-B 单元测试（8 用例） |
| `server/tests/chat-route.test.ts` | 新增 2 条人格断言 |
| `electron/__tests__/env-loader.test.ts`（新增） | P1-D 单元测试（8 用例） |
| `build/installer/customFinish.nsh`（新增） | P1-C 中文完成页 |
| `scripts/repro-p0a-bug.mjs`（新增） | P0-A 复现 / 回归脚本 |
| `scripts/repro-p1d-env.mjs`（新增） | P1-D 优先级验证脚本 |
| `scripts/repro-p0a-chat-smoke.mjs`（新增） | P1-D chat 链路验证脚本 |

### 不动（按 owner 要求）

- `data/`、`eval/`、`assets/`、`PRD/REVIEW/ISSUES/plan.md`
- 不 git commit

---

## 7. 后续注意

- electron-builder 的 NSIS 自定义脚本只能改 `MUI_FINISHPAGE_*` 文案，不能改 StartApp 函数（已在注释里强调）。
- `noTestInBundlePlugin` 仅在 build 时拦截，dev 模式不装——vitest 测试照常能跑。
- `parseDotenvManually` 与 `server/src/env.ts` 同款但独立实现，避免主进程拉 server 模块；后续可考虑提到共享 `electron/env-shared.ts`，但本期不必要。
- owner 跑真 key 时建议先 `setx DEEPSEEK_API_KEY`，再重启 Petibi.exe 看主进程日志 `DEEPSEEK_API_KEY present (length=...)` 确认拿到。
- 不在主进程 / server bundle 任何日志路径打印 key 明文（已通过单元测试 + grep 验证），如有需要查长度而非值。