# 工单：16 人格桌宠 sprite 设计与生成（兽首人身版）

> 里程碑：M1 补充 | 执行：子 agent（MiniMax M3） | 验收：主 agent + owner 目检
> 对应：PRD §8（美术方案）、红线 R2（1-bit alpha）、R9（注释）

## 背景（设计方向已变更，以此为准）

旧占位 sprite（紫色圆角怪兽）owner 不满意，已废弃。新设计方向：

- **兽首人身**：身体是人类小人（Q 版 2.5 头身，穿该人格风格的衣服），头是对应人格的动物头——参考动物森友会 NPC 的感觉
- **画布改为 32×32**（旧规范 48×48 作废），显示 ×4 = 128px（比旧版 192px 缩小三分之一）
- **每人格一个专属主色调**：读 `assets/style/palette.json` 的 `personalities` 映射（人格 → 动物 → 主色），描边统一 `outline: #2B2320`
- 风格统一抓手：同一副人类身体骨架（16 只共用，只换衣服配色），只换动物头 + 主色调

## 任务分解

### 第 1 步：写设计文档 `assets/style/character-design.md`

为 16 只各写一段设计说明：动物头特征（像素级怎么表现，比如猫头鹰=大圆眼+耳羽）、衣服款式、主色调用法、性格气质关键词。全篇中文，这是后续所有美术生产的依据。

### 第 2 步：尝试用 MiniMax 图像生成 API 出图

项目可用的 API：key 与 Claude Code 共用（见下），先探测图像生成能力：
- 尝试 `POST https://api.minimaxi.com/v1/image_generation`（MiniMax 开放平台的图像接口，model 可能叫 `image-01`），key 用环境变量或向主 agent 询问（key 见 ~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN）
- 如果该 key 有图像生成权限：用第 1 步的设计说明写 prompt，生成 16 只的概念图，存 `assets/art/concepts/`（该目录已 gitignore，不进公开仓库）
- 如果没有权限：**如实报告，不要硬编**，然后用第 3 步保底方案

### 第 3 步（保底）：程序化像素绘制

如果图像 API 不可用，用 PIL 写一个 `scripts/make_characters.py`：定义一副 32×32 人类身体骨架模板（头身比、四肢位置），16 只共用；为每只动物头写绘制函数（耳朵/眼睛/嘴的像素差异），身体衣服用该人格主色调填充，描边 #2B2320。宁可简洁可爱，不要强行复杂。
每只先出 idle 2 帧（身体整体上下 1px 呼吸差）。

### 第 4 步：合规化处理与验证（必须真实运行）

- 所有产出 sprite 过 `python scripts/pixelate.py`（注意：pixelate 目前是 48×48，给它加一个 `--size 32` 参数支持 32×32 画布，默认改为 32）
- 过 `python scripts/check_alpha.py`：半透明像素必须为 0
- 逐只检查：所有颜色在色板内、动物头辨识度高、16 只并排看风格统一
- 产出放 `resources/sprites/<人格小写>/idle_0.png, idle_1.png`（如 `resources/sprites/intj/`）

### 第 5 步：桌宠窗尺寸适配

- 改 `electron/main.ts`：窗口 192→128；改 `src/App.tsx`：sprite 显示 32×32 ×4 = 128px（`image-rendering: pixelated` 保持）
- 默认加载人格改为从 `resources/sprites/` 里任选一只（如 intj）演示
- `npm run build` 重新构建通过

## 验收标准

1. `assets/style/character-design.md` 16 只设计说明完整
2. `resources/sprites/` 下 16 人格各有 idle 2 帧，check_alpha 全过、颜色全在色板内
3. pixelate.py 支持 --size 参数，原测试不回归
4. 桌宠窗 128×128，`npm run build` 成功
5. 中文注释覆盖（check_comments.py 通过）
6. 交付报告 `docs/tech/M1-16人格sprite-交付报告.md`：MiniMax 图像 API 是否可用（如实）、每只动物的实现方式、并排效果图的生成方式（用 PIL 拼一张 16 宫格 `assets/art/sprite-sheet.png` 供 owner 目检）

## 约束

- 不动 PRD.md / REVIEW.md / ISSUES.md / plan.md / 工单文件本身
- 不做 git commit
- 诚实第一：图像 API 不可用就明说，保底方案做出来不好看也如实标注，owner 会用即梦补概念稿
