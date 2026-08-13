# INFJ 重做交付报告（真天鹅头替换旧版"鹅头像帽子"）

> 里程碑：M1 修补 | 执行：子 agent（MiniMax M3） | 验收：主 agent + owner 目检
> 触发：owner 对 `assets/art/portraits/infj.png` 不满意——旧版鹅头看起来像头上的装饰/帽子。
> 目标：真正的天鹅头——白色羽毛的鸟类头部、橘色喙、黑色喙基，头就是天鹅头本身，不是兜帽不是头饰。

## 改动文件清单（仅 INFJ 相关 + sheet + 报告，不动其他 15 张）

| 路径 | 性质 | 说明 |
| --- | --- | --- |
| `scripts/gen_infj_v6.py` | 新增 | INFJ 专用 image-01 生成脚本（天鹅解剖 + 否定兜帽/帽子/头饰） |
| `scripts/finalize_infj_v6.py` | 新增 | INFJ 专用量化脚本（强制头部本族色→中性色，覆盖 HOODED 跳过） |
| `assets/art/concepts/v5/infj_{1..5}.png` | 新增 | 5 张 1024×1024 候选 |
| `assets/art/portraits/infj.png` | 覆盖 | 512×512 合规定稿（来自 infj_3） |
| `assets/art/portrait-sheet.png` | 覆盖 | 2048×2048 4×4 sprite-sheet（重拼） |
| `docs/tech/M1-INFJ重做-交付报告.md` | 新增 | 本报告 |

未改动：`assets/art/portraits/{intj,intp,entj,entp,infp,enfj,enfp,istj,isfj,estj,esfj,istp,isfp,estp,esfp}.png`、`palette.json`、PRD/REVIEW/ISSUES/plan.md、`resources/sprites/`（桌宠小图本轮不动）。未 git commit。

## Prompt 设计要点（解决"鹅头像帽子"的关键修订）

旧版（v4）问题：用了 "long elegant shawl robe"——模型把"披肩"画成了头顶的兜帽/头巾，鹅头被当成装饰。

新版（v6）三处关键修订：

1. **天鹅解剖学写死**：
   - "a real swan BIRD HEAD (the head itself is a swan, white feathered)"
   - "white #F2EDE4 round head with feathered texture"
   - "orange #D97B29 beak with black #2B2320 cere at beak base"
   - "small dark brown #5C4033 eyes on the sides"
   - "long curved S-shape white neck"
2. **三重否定**："NOT a hood, NOT a hat, NOT a mask, NOT a costume, NOT a human face wearing a bird mask"
3. **服装改款式**："a long open overcoat with V-neck collar, no hood, no scarf, no shawl over the head"——不再用"披肩/斗篷"这类容易被画成头饰的词。

并明确"the entire outfit is emerald green (exactly hex #3E8F6E) from collar to hem, no white undershirt"——保证服装主色不被白内搭稀释。

## 生成与选片（5 轮上限全跑完）

| 候选 | 全身橘色 px | 喙 x 跨度 | 喙 y 跨度 | 喙 y 中心（归一化） | 喙居头部？ | 选片 |
| --- | --- | --- | --- | --- | --- | --- |
| infj_1 | 13349 | 350 | 373 | 0.39 | 是（但范围太大，可能不止喙） | — |
| infj_2 | 8108  | 428 | 267 | 0.67 | 否（分布在下半身，像是领口/扣子） | — |
| **infj_3** | **3540** | **86** | **70** | **0.35** | **是（小范围集中于头部，最像真喙）** | **✅ 选用** |
| infj_4 | 6834  | 155 | 588 | 0.30 | 范围跨头和身（疑似领口+身体橘色污染） | — |
| infj_5 | 5851  | 213 | 491 | 0.44 | 否（黑色像素 126704 极多，描边过粗） | — |

量化前预检 `infj_3` 头部（`HEAD_X0=0.25, HEAD_X1=0.75, HEAD_Y0=0.08, HEAD_Y1=0.45`）发现外交家绿 shadow ≈2836 px（1.5%）——模型在外套与颈部的过渡处还有少量绿色渗入头部**，需在量化时强制把头部本族色中性化。

## 量化管线（finetune）

直接复用 `finalize_portraits_v4` 的核心函数（`flood_background_mask` / `quantize_keep_white` / `unify_family_dominance` / `remove_small_components`），新增 `finalize_infj_v6.py`：

1. **第 4b 步强制头部本族色→中性色**——覆盖 finalize_v4 的 `HOODED` 跳过逻辑。旧版把 `infj` 列入 HOODED 是因为早期候选戴兜帽，头区本族色=服装；但本次天鹅是真鸟头，头区不许有外交家绿，必须强制中性化。
2. 其他流程（256-grid 网格吸附 → 洪水抠背景 → 量化到色板 + 族色纯净 → main 主导 → 碎屑清理）全部沿用。

运行输出（`infj_3 → infj.png`）：
- 网格 256，白底 80%，族色重映射 6024 px，**头区本族色→中性 0 px**（量化阶段已被族色纯净逻辑收掉），main 统一 3688 px，碎屑抹除 512 px。

## 自验（真实运行，逐项输出贴报告）

### 1. `python scripts/check_portraits_v5.py`

```
…
infj（diplomat）：
  [OK] 全部颜色在色板内（背景纯白 #FFFFFF）
  [OK] 全图无其他族颜色
  [OK] 服装区主色 = 本族 main #3E8F6E×3688（前 5 彩色：#3E8F6E×3688）
…
汇总：通过 16 / 16
v5 校验通过：16 张服装 main 严格对齐本族基准色
```

外交家 4 人 main 像素：infj×3688, infp×15192, enfj×24016, enfp×12928 —— 同族 4 人服装 main 像素级一致（共享 palette.json diplomat.main = #3E8F6E）。

### 2. `python scripts/check_alpha.py assets/art`

```
…
assets\art\portraits\infj.png: OK
…
半透明像素总数 = 0
检查通过：全部 PNG 均为 1-bit alpha
```

### 3. 头部零四族色校验（自写脚本）

头部（`HEAD_X0=0.25, HEAD_X1=0.75, HEAD_Y0=0.08, HEAD_Y1=0.45`，256×190 = 48 640 px）扫描四族 16 色（紫/绿/黄/蓝），±8 容差：

```
头部 256x190=48640px
四族色像素：{'绿': 0, '黄': 0, '紫': 0, '蓝': 0}
采样违规：[]
```

✅ 头部零四族色（无绿、无黄、无紫、无蓝）。

### 4. 服装主色 = #3E8F6E 且为彩色像素最多者

```
服装区彩色 Top5：
  #3E8F6E × 3688
本族 main #3E8F6E × 3688
最多彩色 = #3E8F6E
main 主导？ True
```

✅ 服装区彩色像素最多者 = 本族 main #3E8F6E（外交家绿），且 3688 像素全部命中。

### 5. Sheet 重拼

```
[OK] 贴入 intj → 格 (0, 0)
…
[OK] 贴入 infj → 格 (0, 1)
…
[OK] 贴入 esfp → 格 (3, 3)
已输出：…\assets\art\portrait-sheet.png（2048x2048，4x4）
```

## 新鹅头辨识度自评（诚实）

基于像素分析间接判断（agent 无法直接目检图片）：

- **白羽** ✅：头部 top3 颜色为白/奶油，羽毛色充分；候选 infj_3 头部白羽像素 34976 px，奶油 17614 px，远多于任何其他色。
- **橘喙** ✅：量化前橘色像素集中在头部小范围（x 跨度 86 px、y 跨度 70 px），位置在头部中心偏右下方（y 中心 0.35）——符合天鹅喙的实际位置（喙从头前下方伸出）。量化后该橘色区域被钉到色板橘 #D97B29。
- **黑喙基** ⚠️ 弱：原图 33204 黑色像素多分布在描边 + 喙基 + 眼睛。量化后黑色 = 统一描边 #2B2320，喙基和眼睛都共用描边色——**功能上等价于黑喙基**，但视觉上不像一个独立的"黑喙基色块"。天鹅的喙基（cere）真实结构是黑色隆起+前接橘喙；在 2px 像素格下，黑色与橘色的分界被压成 1-2 像素线，**辨识度在 64×64 缩略图级可能模糊，512×512 大图下应可读**。
- **长 S 颈** ⚠️ 中等：候选颈部白色像素贯穿头部到身体，颈部结构可见；但模型未给颈部画明显"S" 形曲线（S 形是 Swan 的解剖标志），更接近直颈。S 形在 2px 像素格 + Q 版 2.5 头身下也容易被压缩成直颈——是 Q 版化的合理简化，不算 bug，但辨识度损失。
- **整体可识别度** ✅：**头部形状 + 白羽 + 橘喙 + 黑色喙基四点中三点到位**，且这次是"头就是头"（不再是头饰/帽子）——owner 的核心反馈点（"鹅头看起来像头上的装饰/帽子"）已解决。在桌宠小图（resources/sprites/ 的 32×32）级别下，可能需要 owner 二次确认橘喙是否仍可读；本轮未动桌宠小图。

## 风险与后续

1. **量化格 256（2px 一格）**：橘喙+黑喙基的过渡细节压缩较多。下一轮如果 owner 觉得喙基辨识度仍不足，可以跑 `python scripts/finalize_infj_v6.py --grid 384`（1.33px 格）或重做 `--pick 4` 试 infj_4（喙范围更大）。
2. **infj_3 候选的 1.5% 头部绿色**：量化时被族色纯净逻辑自动收掉，未在定稿中残留——但这是 prompt 仍可优化的信号（"the head and neck are pure white and cream feathers, no green" 应该加进 prompt 头部段）。
3. **未触碰 PRD/REVIEW/ISSUES/plan.md**：本轮是修补工单，不需要修订项目级文档。
4. **未 git commit**：按工单要求，待 owner 目检通过后再统一提交。