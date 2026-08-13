# 交付报告：16 人格桌宠 sprite（兽首人身版）

> 工单：`docs/tech/M1-工单-16人格sprite设计.md` | 执行：子 agent | 日期：2026-08-12
> 验收标准见工单「验收标准」一节，本报告逐条对应。

## 1. MiniMax 图像生成 API 可用性（如实）

**可用。** 用 `~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN` 调
`POST https://api.minimaxi.com/v1/image_generation`（model=`image-01`），
首次探测返回 `status_code: 0` 并成功下载 1024×1024 JPG。

随后用 `scripts/make_concepts.py` 按 `character-design.md` 的设计说明批量生成 16 只概念图，
**16/16 全部成功**，存于 `assets/art/concepts/<人格>.jpg`（该目录已 gitignore）。

**但概念图未作为最终 sprite 素材**，原因有二：
1. PRD §8.3 硬规范：透明 sprite 必须原生像素绘制，"AI 出图 + 抠图"会因抗锯齿边缘
   产生白边，属原理性缺陷；
2. 实测概念图是 1024×1024 的"像素画风"插画（非逐像素控制），缩到 32×32 后
   动物特征会糊掉，且配色无法保证落在 16 色限定色板内。

概念图定位：供 owner 参考姿势/配色感觉，owner 后续可用即梦按 `character-design.md`
重出更高质量概念稿。

## 2. 每只动物的实现方式

**全部 16 只均由 `scripts/make_characters.py`（PIL 程序化像素绘制）产出**，即工单第 3 步保底方案，
因上述 PRD 规范原因成为实际生产线。机制：

- **共用骨架**：躯干/手臂/腿坐标 16 只完全一致（`body_geometry()`），只换动物头 + 衣服配色
- **描边自动生成**：剪影 8 邻域膨胀 1px 减去剪影 = 统一 1px `#2B2320` 外描边，不会断边
- **idle 2 帧**：帧 1 躯干+手臂下移 1px、腿压短 1px，头和脚不动（呼吸起伏）；
  两帧包围盒完全一致（y2..29），保证过 pixelate.py 时是恒等变换
- **逐像素自检**：生成时即断言 alpha ∈ {0,255}、颜色全部 ∈ 16 族色 ∪ {outline}

| 人格 | 动物 | 辨识度抓手（像素级） |
|---|---|---|
| INTJ | 猫头鹰 | 5×5 大圆眼盘（护目镜感）+ 头顶耳羽簇 |
| INTP | 猫 | 三角耳 + 半眯横线眼 + 胡须 |
| ENTJ | 狮子 | 18px 宽深棕鬃毛环（全系列最宽的头） |
| ENTP | 狐狸 | 高尖耳 + 前突尖吻 + 深色耳尖 |
| INFJ | 天鹅 | 唯一长颈结构（2px 左弯颈）+ 闭眼竖线目 |
| INFP | 蝴蝶 | 球状端触角 + 大复眼 + 背部浅绿翅 |
| ENFJ | 金毛 | 贴脸垂耳 + 前突口鼻 + 眼高光 |
| ENFP | 海豚 | 大额隆 + 浅色宽吻突 + 呼吸孔 + 微笑弧线 |
| ISTJ | 海狸 | 两颗大门牙（上排整排、下排留缺口）+ 平眉 |
| ISFJ | 企鹅 | 深蓝头 + 大白脸盘 + 橘喙，无耳 |
| ESTJ | 熊 | 16px 宽方下巴 + 半圆耳 + 下压眉线 |
| ESFJ | 大象 | 垂鼻搭到领口 + 两侧扇形大耳 + 小象牙 |
| ISTP | 豹 | 猫科脸 + 2×2 块状斑纹 + 细长锐眼 |
| ISFP | 卡皮巴拉 | 方块钝吻 + 高位半闭眼 + 头顶小橘子 |
| ESTP | 猴子 | 浅色心形脸盘 + 脸侧外凸大圆耳 + 咧嘴笑 |
| ESFP | 鹦鹉 | 向右下收窄的钩喙 + 三根冠羽 + 眼圈 |

## 3. 验收标准逐条结果

| # | 标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | character-design.md 16 只设计说明完整 | ✅ | `assets/style/character-design.md`，含全局硬规范 + 16 只逐只像素级说明 + 自检清单 |
| 2 | 16 人格各有 idle 2 帧，check_alpha 全过、颜色全在色板内 | ✅ | `resources/sprites/<16 人格>/idle_0.png,idle_1.png` 共 32 个；`check_alpha.py` 输出"半透明像素总数 = 0"；颜色由 `make_characters.py` 生成时逐像素断言 + `test_art_tools.py` 同款校验逻辑复核 |
| 3 | pixelate.py 支持 --size，原测试不回归 | ✅ | `--size` 默认 32（旧 48 可用 `--size 48`）；`python scripts/tests/test_art_tools.py` 全部通过（7 项，含新增默认 32 用例）；32 个 sprite 过 pixelate 前后像素逐一比对**完全相等**（恒等变换，未被二次缩放） |
| 4 | 桌宠窗 128×128，npm run build 成功 | ✅ | `electron/main.ts` 窗口 128×128、`src/App.tsx` PET_SIZE=128（`image-rendering: pixelated` 保持）；`npm run build` 全链路通过（typecheck + electron-vite build + electron-builder NSIS） |
| 5 | 中文注释覆盖（check_comments.py 通过） | ✅ | 13/13 源文件通过 |
| 6 | 交付报告 + 16 宫格目检图 | ✅ | 本报告；`assets/art/sprite-sheet.png`（512×512，PIL 拼 4×4 宫格，每格 idle_0 最近邻放大 4 倍，按族分行） |

## 4. 诚实标注：辨识度没把握的几只（owner 请重点看）

以下判断基于我对 `assets/art/sprite-sheet.png` 的逐只放大目检（宫格图见 §3.6）：

- **ENFP 海豚（把握最低）**：正面海豚头没有耳/鬃可抓，目前靠"蓝色圆头 + 浅色吻突 + 呼吸孔"
  表达，第一印象更像"蓝色小人"而非海豚。建议 owner 用即梦补概念稿后人工微调，
  或考虑改 3/4 侧脸（吻突侧向会好认得多）。
- **ISTP 豹 vs INTP 猫**：两者共用猫科基础脸，差异化只有斑纹（豹）和胡须/眯眼（猫）。
  并排能分，单看豹可能认成猫。后续可给豹加更密的斑纹或金钱豹"花瓣斑"。
- **ISTJ 海狸**：门牙已可读，但整体轮廓仍偏"熊"。靠和 ESTJ 熊对比（毛色浅一档 + 有牙）区分。
- **ESFP 鹦鹉**：钩喙和冠羽可读，但绿色头在无对比时可能被认成"戴绿帽的小人"。
  与 INFJ 天鹅（长颈）、ISFJ 企鹅（白脸）并排时鸟类特征足够。
- **INTJ 猫头鹰**：大眼盘 + 耳羽可读，但眼盘也可能被读成"护目镜"。在可接受范围。

其余 11 只（猫/狮子/狐狸/天鹅/蝴蝶/金毛/企鹅/熊/大象/卡皮巴拉/猴子）单看剪影
即有较强的动物指向性。

**风格统一性**：16 只共用骨架 + 统一描边 + 统一色板 + 统一光源（左上提亮、右下压暗），
宫格图并排看整齐度达标；但程序化绘制的表情普遍偏"呆"，灵动度不如手绘，
owner 若用即梦补概念稿，建议以 `character-design.md` 的坐标规范为准微调。

## 5. 附带说明

- **pixelate.py 的 `load_palette` 顺带修复**：旧实现按"值均为颜色列表"解析，
  遇到 palette.json 新增的 `personalities`（嵌套 dict）和 `outline`（字符串）会崩溃；
  已改为递归收集 `#RRGGBB` 字符串（族色 + 人格主色 + outline 全部纳入量化目标）。
- **构建前杀掉了 4 个残留 Petibi.exe 进程**（PID 44768/51828/600/24064，
  是旧构建的桌宠实例，锁住了 `release/win-unpacked/*.dll` 导致 electron-builder 失败）。
  如需重新查看桌宠，`npm run dev` 即可。
- `resources/sprites/placeholder/`（旧 48×48 占位紫色怪兽）未删除，仍通过 check_alpha；
  App.tsx 已不再引用它。是否清理由 owner 决定。
- `assets/art/`（concepts/ 与 sprite-sheet.png）已 gitignore，不进公开仓库。

## 6. 产出文件清单

- 设计：`assets/style/character-design.md`
- 脚本：`scripts/make_characters.py`（sprite 生产线 + 宫格图）、`scripts/make_concepts.py`（概念图）
- 改造：`scripts/pixelate.py`（--size + load_palette 兼容）、`scripts/tests/test_art_tools.py`（适配 + 新用例）
- sprite：`resources/sprites/{intj,intp,entj,entp,infj,infp,enfj,enfp,istj,isfj,estj,esfj,istp,isfp,estp,esfp}/idle_{0,1}.png`
- 前端适配：`electron/main.ts`（128×128）、`src/App.tsx`（PET_SIZE=128，默认加载 intj）
- 目检：`assets/art/sprite-sheet.png`；概念图：`assets/art/concepts/*.jpg`（16 张）
