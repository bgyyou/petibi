# 工单：16 人格 sprite 重做（AI 生成 + 像素化管线版）

> 里程碑：M1 补充 v2 | 执行：子 agent（MiniMax M3） | 验收：主 agent + owner 目检
> 上一版问题：程序化绘制的 sprite 与 MiniMax concepts 观感差距大，owner 更喜欢 concepts 的质感。本工单改为"AI 直接生成接近合规的图 → pixelate 量化"的管线。

## 设计规范（owner 定，严格执行）

- 形态：兽首人身——Q 版人类身体（2.5 头身）+ 动物头，正面站立，全身居中
- **颜色分工**：动物头用自然毛色（读 `assets/style/palette.json` 的 neutrals 组）；**人格色系只体现在服装和配饰上**（读 personalities 映射的主色调）
- 画布 32×32，最终 sprite 严格 1-bit alpha、颜色全在色板（families 16 色 + neutrals 8 色 + outline）
- 风格统一：所有 16 只用同一套 prompt 模板，只替换动物名/主色调/服装描述

## 执行步骤

### 1. 设计 prompt 模板并生成

用 MiniMax 图像 API（`POST https://api.minimaxi.com/v1/image_generation`，model=`image-01`，key 在 ~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN，已确认可用）。prompt 模板要点（中英混合写，反复调到稳定）：
- 明确 "pixel art, 32x32 sprite style, front view, full body, chibi 2.5-head-tall"
- 明确 "animal head + human body"（指定动物），"wearing <主色调 hex> hoodie/outfit"
- 明确 "solid pure white background, no shadow, no anti-aliasing, crisp pixels"
- 每只生成 2-3 张候选，存 `assets/art/concepts/v2/`

### 2. 像素化 + 合规检查

- 每张候选过 `python scripts/pixelate.py --size 32`（白底会被四角容差去背景；若主体贴角或白毛动物被误抠，调 --bg-tolerance 或手动补 alpha）
- 过 `python scripts/check_alpha.py`（半透明 = 0）
- 用脚本验证输出颜色全在色板内（families + neutrals + outline）

### 3. 人工筛选与微调

- 每只选最好的一张量化结果；动物头辨识度不够的，用 PIL/Piskel 级手动补几笔（耳朵、喙、鬃毛等关键特征）
- 每只出 idle 2 帧：第 2 帧 = 身体部分下移 1px（呼吸感），两帧包围盒一致
- 产出 `resources/sprites/<人格>/idle_0.png, idle_1.png` 覆盖旧版

### 4. 目检图与报告

- PIL 拼 16 宫格 `assets/art/sprite-sheet-v2.png`（512×512，按族分行，深色背景上以深色描边可见为准，或白底）
- 交付报告 `docs/tech/M1-16人格sprite-v2-交付报告.md`：每只用了几张候选、量化后是否手动修过、辨识度自评（诚实）

## 验收标准

1. 16 人格 idle×2 帧全部更新，check_alpha = 0，颜色全在色板（含 neutrals）
2. sprite 观感与 concepts v2 候选图"神似"（轮廓和配色一致，只是像素化）——这是本工单的核心目标
3. 16 宫格并排风格统一（同一 prompt 模板保证）
4. check_comments.py 通过；`npm run build` 不受影响（如需重新生成占位引用则构建验证）
5. 不做 git commit；不动 PRD/REVIEW/ISSUES/plan/工单文件

## 诚实义务

- 某只生成 5 次以上仍不可用的，如实标注"建议 owner 用即梦出稿"，不要拿差的凑数
- MiniMax API 的任何限制（频次/内容审核拒绝）如实记录
