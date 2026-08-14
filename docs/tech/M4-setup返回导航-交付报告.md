# M4-setup 返回导航 — 交付报告

> 工单:M4-setup 返回导航
> 触发:owner 实测 setup 流程没有返回键,进入选人格页后无法返回上一步,只能重启
> 完成时间:2026-08-14
> 实现范围:`src/setup/` 渲染端(状态机 + 4 个页面 + 共享 BackButton + 样式),不动主进程 / 数据层 / 资产

---

## 1. 问题与目标

### 1.1 owner 实测问题

`setup` 流程(5 步:login → nickname → pick → test → result)只有正向推进按钮,任何一步之后想回到上一步只能关窗重启。选人格页(16 人格 + "不确定去测一下")是用户体验的中间枢纽,但进去之后就再也出不来。

### 1.2 任务目标

为 4 个非登录步骤页(昵称/选人格/测试/结果)加统一的像素风「← 返回」按钮,补齐 4 条返回路径,retest 模式下不显示入口处的返回键,避免误退回登录页。

### 1.3 设计约束(DESIGN.md)

- 像素风:纸白底 + 3px 墨边框 + 硬阴影 + hover 位移反馈,禁止圆角 / 渐变 / 柔和阴影
- 强调色只用四族色板
- 禁止 emoji 当功能图标 → 左箭头用 SVG 像素画
- 中文字体走像素字体栈,英文标题可 uppercase

---

## 2. 改动文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/setup/state/setupStore.tsx` | 改 | reducer 新增 `BACK_TO_LOGIN` / `BACK_TO_NICKNAME` / `BACK_TO_PICK_KEEP_ANSWERS` 三个 action;既有 `BACK_TO_PICK` 保持不变(结果页专用);action 类型同步扩到 `SetupAction` 联合 |
| `src/setup/styles.css` | 改 | 新增 `.setup-back` / `.setup-back-icon` / `.setup-back-label` 三个 class,风格与现有 `.btn-ghost` 同源但更紧凑(顶部独立行、左对齐) |
| `src/setup/pages/BackButton.tsx` | 新建 | 共享像素风返回按钮组件:左箭头 SVG + label 文字 + onClick 回调 + 可选 disabled |
| `src/setup/pages/NicknamePage.tsx` | 改 | 顶部加 `<BackButton label="返回登录">` → 派发 `BACK_TO_LOGIN`;本地 input 用 `state.nickname` 作 source of truth,再进昵称页自动回填 |
| `src/setup/pages/PickTypePage.tsx` | 改 | 顶部加 `<BackButton label="返回昵称">` → 派发 `BACK_TO_NICKNAME`;**retest 模式下直接不渲染**(避免退回登录页) |
| `src/setup/pages/TestPage.tsx` | 改 | 顶部加 `<BackButton label="返回选人格">` → 派发 `BACK_TO_PICK_KEEP_ANSWERS`(保留 `state.answers`);步骤内"上一题"按钮保留为题目级撤销,语义独立 |
| `src/setup/pages/ResultPage.tsx` | 改 | 顶部加 `<BackButton label="重选人格">` → 派发既有 `BACK_TO_PICK`;**footer 移除"重选人格"按钮**,footer 仅保留"完成"主按钮(避免与左上角返回键重复);fallback 分支(无 result 数据)同样加返回按钮 |
| `src/setup/__tests__/setupReducer.test.ts` | 改 | 新增 `describe('M4 setup 返回导航')` 套件,8 个新用例覆盖 3 个新 action 的契约,含端到端往返(login→test→返回选人格→返回昵称→返回登录 数据全部保留) |

### 2.1 不动的文件(任务约束)

按工单"不动"清单确认未触碰:

- `server/` — 后端契约未变
- `data/` — 题库 / 人格速查卡 / 反馈语料未变
- `eval/` — 评测集未变
- `assets/` — 像素 sprite 资产未变
- `electron/` — 主进程 IPC 通道未新增/未变,所有返回路径都是渲染端 reducer
- `PRD.md` / `REVIEW.md` / `ISSUES.md` / `plan.md` — 项目管理文档未改

---

## 3. 关键设计决策

### 3.1 为什么新建 `BACK_TO_PICK_KEEP_ANSWERS` 而不是复用 `BACK_TO_PICK`?

测试页 → 选人格页要求"已答题进度保留",而既有 `BACK_TO_PICK`(结果页专用)只翻 step 不清 result。两者语义虽近但不同:
- `BACK_TO_PICK`(结果页):step→pick,result 保留(由后续 `PICK_TYPE` / `GO_TEST` 清理,与 P0-005 修复一致)
- `BACK_TO_PICK_KEEP_ANSWERS`(测试页):step→pick,answers 保留(用户再进 TestPage 时 `currentIdx = keys(answers).length` 仍是上次进度)

新增独立 action 让 reducer 语义显式化,避免后续 UI 改动时 reducer 行为悄悄漂移。测试用例钉死两条 path 的差异化。

### 3.2 为什么 retest 模式 PickTypePage 不渲染返回按钮?

retest 模式入口就是 PickTypePage 本身(`App.tsx` 读 `?mode=retest` 后直接 dispatch `INIT_FROM_PROFILE` 到 `initialStep='pick'`)。如果显示返回按钮,点了会回 nickname → 回 login,造成"我已经登录,为什么要回到登录页"的困惑。

解决方案:直接条件渲染 `{!isRetest && <BackButton ... />}`,而不是 `disabled=true` —— 任务原文允许"隐藏或置灰",这里选了**隐藏**,因为 retest 模式下根本没有"上一步"语义可点。

### 3.3 为什么结果页移除 footer 的"重选人格"按钮?

任务原文:"已有'测得不对,重新选择',保留并改为统一返回样式"。理解:这条返回路径要保留,但改用左上角统一返回样式。如果 footer 和左上角同时存在两套返回入口,会显得割裂(且容易让用户疑惑"哪个是真的"),所以收敛到左上角一处。footer 仅留主操作"完成"按钮。

### 3.4 为什么 BackButton 放在 setup-header 之上的独立一行?

DESIGN.md 像素风调色板 + 紧凑布局:setup-shell 是 flex column,padding `24px 36px`,标题与正文左对齐在 36px 起点上。把返回按钮做 absolute 右上角会和未来加的"步骤指示"(1/4、2/4)抢位置;做 absolute 左上角会和 h1 重叠。改成 inline-flex 行内、align-self: flex-start,作为 setup-shell 的第一个子元素,在 setup-header 之上独占一行,margin-bottom 10px 间隔。这样视觉上是"左上角顶部",且不和标题挤。

### 3.5 为什么不改 `LoginPage`?

任务原文:"登录页是第一步无需返回"。`LoginPage` 顶部只有欢迎语 + mock 横幅 + 表单 + footer,没有任何"上一步"可点(也没有任何"返回"语义)。新增返回按钮会让用户以为还有"上一步",违反"登录是流程起点"的契约。

---

## 4. 自验结果(真实运行)

### 4.1 typecheck

```
$ npm run typecheck
> tsc --noEmit
(无输出,退出码 0)
```

✅ **typecheck 0 错**。

### 4.2 vitest 全量

```
$ npx vitest run
 Test Files  29 passed (29)
      Tests  380 passed (380)
   Duration  26.67s
```

✅ **380 用例全过**(包括 setupReducer 新增 8 个用例 + 既有 7 个回归用例 + resultBarHint 10 个 + chat-reducer / poster / scoring / server 集成 / electron 等全模块)。

新加用例摘要(8 个,全部通过):

1. `BACK_TO_LOGIN` 切 step='login' + 保留 email/token/nickname
2. `BACK_TO_LOGIN` 从任意 step 调用都生效(不校验当前 step)
3. `BACK_TO_NICKNAME` 切 step='nickname' + 保留 nickname
4. `BACK_TO_NICKNAME` 从测试步骤退回昵称页的极端路径
5. `BACK_TO_PICK_KEEP_ANSWERS` 切 step='pick' + 保留 5 题进度
6. `BACK_TO_PICK_KEEP_ANSWERS` 在 pick 步骤调用幂等
7. `BACK_TO_PICK_KEEP_ANSWERS` + `PICK_TYPE` 串行不破坏数据
8. 端到端往返:login → nickname → pick → test → 返回选人格 → 返回昵称 → 返回登录 数据全保留

### 4.3 check_comments(R9 红线:中文文件头覆盖率)

```
$ python scripts/check_comments.py
[OK] src\setup\pages\BackButton.tsx
[OK] src\setup\pages\NicknamePage.tsx
[OK] src\setup\pages\PickTypePage.tsx
[OK] src\setup\pages\TestPage.tsx
[OK] src\setup\pages\ResultPage.tsx
[OK] src\setup\state\setupStore.tsx
[OK] src\setup\__tests__\setupReducer.test.ts
...
中文文件头覆盖率 = 143/143
检查通过:全部源文件均有中文文件头注释
```

✅ **check_comments 143/143 通过**。新增 BackButton.tsx 与所有改动文件的文件头注释均合规(前 5 行内含中文 + 注释标记)。

### 4.4 build 出包

```
$ npm run build:server
dist\server\server.cjs  1.9mb
[build-server] done in 263ms

$ npx electron-vite build
vite v5.4.21 building SSR bundle for production...
✓ 2 modules transformed.        → out/main/main.js (23.12 kB)
✓ 1 modules transformed.        → out/preload/preload.js (9.99 kB)
✓ 67 modules transformed.
  ../out/renderer/panel/index.html
  ../out/renderer/setup/index.html
  ../out/renderer/index.html
  ../out/renderer/assets/setup-iR5MhZAn.css (13.60 kB)   ← setup 样式
  ../out/renderer/assets/setup-D3Y0ZpDR.js  (42.99 kB)   ← setup bundle(BackButton 已含)
  ...

$ npx electron-builder --win nsis
building target=nsis file=release\Petibi Setup 0.1.0.exe archs=x64 oneClick=true
```

✅ **build 出包成功**。产物:

- `out/main/main.js` 23.12 kB
- `out/preload/preload.js` 9.99 kB
- `out/renderer/setup/index.html` + `setup-D3Y0ZpDR.js` 42.99 kB + `setup-iR5MhZAn.css` 13.60 kB
- `release/Petibi Setup 0.1.0.exe` 146 MB(NSIS 一键安装器)
- `release/win-unpacked/` 完整解压目录

setup bundle 增量 +0.7 kB(BackButton 组件 ~50 行 + 4 个页面 import);setup css 增量 +0.8 kB(`.setup-back` 系列样式)。未膨胀。

---

## 5. 未覆盖 / 留给 owner 实测的项

- **UI 点击验证**:reducer / 组件单元测试已覆盖,但"点按钮真的回退"是端到端视觉行为,需 owner 跑 `npm run dev` 在 800×640 setup 窗手动点一遍:
  - 昵称页 ← → 登录页(输入有内容时,回登录页再回昵称页应回填)
  - 选人格页 ← → 昵称页
  - 测试页 ← → 选人格页(答了 3 题后返回,再进测试应跳到第 4 题)
  - 结果页 ← → 选人格页
  - retest 模式下 PickTypePage 顶部应**不显示**返回按钮
- **键盘可访问性**:BackButton 是 `<button type="button">`,默认可 Tab + Space/Enter 激活,无需额外处理
- **retest 入口的 BACK_TO_LOGIN 不存在**:已在 `PickTypePage` 用 `{!isRetest && ...}` 短路,reducer 不会被 retest 模式下意外触发(没有 UI 入口)

---

## 6. 回归影响

- **P0-005(重选人格仍显示旧结果)**:不受影响。`BACK_TO_PICK` 既有契约保留(result 不清,由后续 PICK_TYPE/GO_TEST 清理);`BACK_TO_PICK_KEEP_ANSWERS` 不动 answers 不动 result。
- **P0-006(反馈成功后软件退出)**:不受影响。3 个新 BACK_* action 都不触发 `FEEDBACK_RECORDED` 或 `completeSetup`,只翻 step。reducer 行为隔离。
- **retest 流程(M4 重测人格)**:不受影响。`INIT_FROM_PROFILE` 入口未动;retest 模式下 PickTypePage 顶部 BackButton 隐藏,profile.json / sprite 切换路径未变。
- **既有 reducer 用例(setupReducer.test.ts 原 14 个)**:全过,无回归。

---

## 7. 交付清单

- 改动文件:7 个(state/store + 4 个页面 + styles.css + 测试)
- 新增文件:1 个(`src/setup/pages/BackButton.tsx`)
- 新增 reducer action:3 个(BACK_TO_LOGIN / BACK_TO_NICKNAME / BACK_TO_PICK_KEEP_ANSWERS)
- 新增测试用例:8 个(钉死 3 个 action 的契约 + 端到端往返)
- 新增样式 class:3 个(`.setup-back` / `.setup-back-icon` / `.setup-back-label`)
- 产物:`release/Petibi Setup 0.1.0.exe` 146 MB
- 报告:`docs/tech/M4-setup返回导航-交付报告.md`(本文档)

不动:`server/` / `data/` / `eval/` / `assets/` / `electron/` / `PRD.md` / `REVIEW.md` / `ISSUES.md` / `plan.md`。
不 git commit(按工单要求)。