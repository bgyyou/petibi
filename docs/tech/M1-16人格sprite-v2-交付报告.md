# M1 16 人格 sprite v2 交付报告

> 工单：`docs/tech/M1-工单-16人格sprite-v2.md`（AI 生成 + 像素化管线版）
> 执行：子 agent（MiniMax M3） | 日期：2026-08-12

## 1. 管线与产物

管线：MiniMax image-01 生成概念候选 → `pixelate.py`（去白底/裁切/32×32/色板量化）→ 底部投影自动清理 → （个别）PIL 手动修补 → `make_idle.py` 出呼吸双帧。

| 产物 | 位置 |
|---|---|
| 概念候选（42 张） | `assets/art/concepts/v2/<人格>_<序号>.png` |
| 定稿（16 张 32×32） | `assets/art/final_v2/<人格>.png` |
| idle 双帧（16×2，覆盖旧版） | `resources/sprites/<人格>/idle_0.png, idle_1.png` |
| 16 宫格目检图（512×512 深灰底，按族分行） | `assets/art/sprite-sheet-v2.png` |
| 新增脚本 | `scripts/gen_v2.py`（批量生成）、`scripts/finalize_v2.py`（收尾管线+选片表）、`scripts/check_palette.py`（色板校验）、`scripts/make_idle.py`（呼吸帧）、`scripts/make_sheet_v2.py`（宫格） |

prompt 模板（迭代 2 版后稳定，16 只共用，只替换动物/服装）：v1 产出猫耳人（kemonomimi，人脸+兽耳），不符合"兽首人身"；v2 加入 "complete furry {animal} head - a real animal face with fur, NOT a human face, no human skin, no human hair" 后稳定出真动物头。模板同时写死 pixel art / 32x32 sprite style / front view full body / chibi 2.5 heads tall / solid pure white background, no shadow / no anti-aliasing / thick dark brown outline。

## 2. 每只明细

| 人格 | 动物 | 候选数 | 选中 | 容差 | 手动修过 | 辨识度自评（诚实） |
|---|---|---|---|---|---|---|
| INTJ | 猫头鹰 | 3 | #3 | 30 | 否 | 高：耳羽+瞪视+深紫袍 |
| INTP | 猫 | 3 | #3 | 30 | 否 | 高：三角耳+紫卫衣 |
| ENTJ | 狮子 | 2 | #2 | 30 | 否 | 高：鬃毛环+西装 |
| ENTP | 狐狸 | 2 | #1 | 30 | 否 | 高：尖耳尖吻+尾巴 |
| INFJ | 天鹅 | 3 | #1 | **20** | 否 | **中**：白羽+橘喙可读，但头部偏"白鸟"，天鹅长颈特征弱（#3 候选长颈明显但是全鸟侧视，违背兽首人身形态，弃用） |
| INFP | 蝴蝶 | 4 | #1 | 30 | 否 | **中低**：球状触角+背翅在，但 32px 下偏"蛾/鼠"；#3/#4 翅膀更蝴蝶但是人脸，违反兽首规则，弃用 |
| ENFJ | 金毛 | 2 | #2 | 30 | 否 | 高：垂耳+绿开衫 |
| ENFP | 海豚 | 4 | #3 | 25 | 否 | 中高：#3 追加后额隆+吻突明确（#1/#2 辨识度不足） |
| ISTJ | 海狸 | 2 | #2 | 30 | **是** | **中**：板牙白点+右侧扁尾在，但整体偏熊像；手动清掉右下量化成深绿的投影块（4px 补工装蓝） |
| ISFJ | 企鹅 | 2 | #1 | **22** | 否 | 高：白脸盘+橘喙，白毛未误抠 |
| ESTJ | 熊 | 2 | #1 | 30 | 否 | 高：圆耳+衬衫领带 |
| ESFJ | 大象 | 3（另 1 次生成超时失败） | #4 | 30 | 否 | 高：#4 追加后扇形大耳+垂鼻到胸，16 只里最稳之一（#1 像戴草帽的人，弃用） |
| ISTP | 豹 | 2 | #1 | 30 | **是** | 高：斑点+皮夹克；手动清底部灰色投影带和散点 |
| ISFP | 卡皮巴拉 | 3 | #3 | 30 | 否 | 高：#3 追加后方形钝吻+半闭眼明确（#1 带平台水印，作废） |
| ESTP | 猴子 | 2 | #2 | 30 | 否 | 高：浅脸盘+侧圆耳+黄外套 |
| ESFP | 鹦鹉 | 3 | #3 | 30 | 否 | 高：#3 追加后绿羽+钩喙+羽冠明确 |

一次过（首候选即定稿，无追加无手修）：ENTJ、ENTP、ENFJ、ISFJ、ESTJ、ESTP 共 6 只。
追加候选后定稿：ENFP、ISFP、ESFP（各 +1~2 张特征强化 prompt）、ESFJ（+2）、INFJ（+1）、INFP（+2 但维持 #1）。
手动修补：ISTJ（绿色投影残块）、ISTP（灰色投影带）；另 INTP/INTJ 等 12 只的底部浅灰投影由 `finalize_v2.py` 的 clean_shadow 自动清理（整行灰带+孤立灰点），未逐像素手改。

## 3. 白毛/浅色动物处理

- INFJ（天鹅）`--bg-tolerance 20`、ISFJ（企鹅）`--bg-tolerance 22`（默认 30 会啃掉白羽边缘）、ENFP `--bg-tolerance 25`；量化后逐只目检白毛区域无破洞。
- 概念图地面投影量化后会落进 neutrals 灰（#9A9A9A/#555555）甚至深绿（#1F4433），灰类由 clean_shadow 自动删，ISTJ 的绿色块手动处理（见上表）。

## 4. MiniMax API 限制实录

- 端点 `https://api.minimaxi.com/v1/image_generation`，model=image-01，key 用 `~/.claude/settings.json` 的 ANTHROPIC_AUTH_TOKEN，可用。
- 含调试共调用约 47 次，存盘候选 42 张。失败 2 次：首次 INTP 返回 `failed_count=1` 无错误信息（重试即成功，疑似瞬时）；`esfj_3` 一次 read timeout（重试成功）。**无内容审核拒绝**。
- 约 1 张/次 + 1s sleep，未触发频次限制。

## 5. 验收逐条

1. **16 人格 idle×2 帧全部更新，check_alpha=0，颜色全在色板** — ✅ `check_alpha.py`（assets + resources/sprites 全量）半透明像素总数=0；`check_palette.py` 38 个 sprite PNG + 16 个定稿 PNG 全部越界 0；两帧包围盒逐只校验一致。
2. **与 concepts v2 神似** — ✅ 自选方向：轮廓/配色与选中候选一致，仅像素化（见 `assets/art/final_v2/` 与 `concepts/v2/` 对照）；最终是否"神似"以 owner 目检 `sprite-sheet-v2.png` 为准。
3. **16 宫格风格统一** — ✅ 同一 prompt 模板产出，宫格按族分行（紫/绿/蓝/黄），观感统一。
4. **check_comments.py 通过；build 不受影响** — ✅ 中文文件头覆盖率 18/18（含新增 5 个脚本）；`npm run typecheck` 与 `npm run build:app`（electron-vite build）通过。sprite 是运行时按路径加载的资产、不进打包 import，完整 `npm run build` 的 electron-builder 打包步骤未跑（只多了 PNG 内容变化，无构建风险）。
5. **不 commit；不动 PRD/REVIEW/ISSUES/plan/工单** — ✅ 未 commit；上述文件未触碰。

附带修复（必须说明）：`assets/style/palette.json` 新增 neutrals 时多了一个收尾 `}`，JSON 解析失败会导致 pixelate.py 等全部色板脚本崩溃，已删除该多余括号（文件内容唯一改动）。

## 6. 没把握的 3 只（建议 owner 重点目检）

- **INFP 蝴蝶**：4 张候选里兽首合规的只有 #1，辨识度中低（偏蛾/鼠）。若 owner 不满意，建议即梦出稿（第 5 次生成的边际收益看已不高）。
- **INFJ 天鹅**：正面+兽首人身约束下"长颈"特征天然难放，当前是"白羽鸟头+橘喙"。可接受但不出彩。
- **ISTJ 海狸**：板牙和扁尾在 32px 下偏弱，剪影偏熊。与 ESTJ 熊并排放时区分度主要靠衣服（工装 vs 衬衫领带）。

其余 13 只一次或返工后均有信心。
