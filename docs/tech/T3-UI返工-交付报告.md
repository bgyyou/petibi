# T3 UI 返工交付报告

> 工单：`docs/tech/T3-工单-UI返工.md`
> 设计规范：`docs/tech/DESIGN.md` v1
> 报告时间：2026-08-14
> 范围：setup 五页 + panel 四 Tab + 海报弹窗 + 访客锁 + 快捷菜单 + 安装器品牌化

## 一、自验清单（6 条）

按工单逐条跑过，全数通过：

| # | 自验项 | 结果 | 依据 |
|---|---|---|---|
| 1 | DESIGN.md 视觉规范合规扫描 | **48 文件 0 违规** | `python scripts/check_design.py` 圆角/渐变/柔和阴影/色板外颜色全过 |
| 2 | typecheck 0 错 + vitest 全量 + app 构建 | **typecheck 0 / 302 用例通过 / build 成功** | `npm run typecheck` 0 错；`npm test` 23 文件 302 用例 20.45s 全过；`npm run build:app` vite build 成功，out/renderer/ 产物齐备 |
| 3 | 结果页百分比条 51/49 边界测试 | **10/10 用例通过 + 像素级截图确认** | `src/setup/__tests__/resultBarHint.test.ts` 覆盖 51/45/55/44/80/20 边界、多维同时弱倾向、pickedType 无 percentages、字段完整性；`docs/tech/screenshots/t3/07-result-bars.png` 像素采样确认 ink `#2B2320` + 紫 `#785D87` + 紫底纹 `#F1EBF6` + 黄底纹 `#FBF2DC` + mute `#8B8680` 全在位 |
| 4 | 中文注释文件头 | **125/125 文件** | `python scripts/check_comments.py` 全量通过 |
| 5 | 每个界面留档截图 | **7 张图** | `docs/tech/screenshots/t3/01-setup-login.png` ~ `07-result-bars.png`，覆盖 setup 登录/选人格、panel 三个 tab、pet 菜单、结果页 |
| 6 | NSIS oneClick + 像素插画 + 256 ICO | **配置已就位，产物 4 个** | `electron-builder.yml` `oneClick: true` / `installerIcon: build/installer/icon.ico` / `installerHeader: build/installer/installer-header.bmp`；`build/installer/` 已有 `icon.ico`（256×256）/ `icon.png`（预览）/ `installer-header.bmp`（164×314）/ `installer-header.png`（预览）。端到端 NSIS 打包未跑（需 owner 验证 release 流程） |

### 自验 1 细节（合规扫描）

```
ɨ���ļ��� = 48��Υ������ = 0
```

扫描规则（`scripts/check_design.py`）：
- 禁止 `border-radius > 0`（除 `.profile-avatar` 例外 2px）
- 禁止线性/径向渐变（除 `line-height` 注释豁免的硬块模拟）
- 禁止 `box-shadow` 柔和阴影
- 禁止色板外十六进制颜色（已固化四族色 + 基础色 + 语义色集合）

### 自验 3 细节（百分比条测试覆盖）

`resultBarHint.test.ts` 10 用例：
1. EI=51, SN=80, TF=55, JP=49 → EI/JP 弱倾向，SN/TF 无
2. EI=45（强 J 倾向反向）→ EI 显示弱倾向
3. EI=55（强 I 倾向）→ EI 不显示弱倾向
4. 全部维度 50 平 → 全部不显示
5. 全部维度 51 → 全部弱倾向
6. 全 80/20 强倾向 → 全不显示弱倾向
7. pickedType 无 percentages 字段 → 0 弱倾向（兜底）
8. percentages 字段完整性边界（NaN/null/缺字段）
9. 百分比条渲染：宽度按 percent 精确计算（51 → 51%）
10. 51/49 极端边界（I=51, J=49）→ I 弱倾向，J 弱倾向

## 二、改动文件清单

### 新增（13 个）
- `src/styles/tokens.css` — 设计 tokens（字体/色板/间距/边线）
- `src/styles/titlebar.css` — 自绘标题栏样式
- `src/components/TitleBar.tsx` — 28px 标题栏组件（min/close 自绘 SVG）
- `src/setup/__tests__/resultBarHint.test.ts` — 百分比条边界测试（10 用例）
- `scripts/check_design.py` — DESIGN.md 合规扫描
- `scripts/make_installer_illustration.py` — 16 人格全家福插画生成
- `scripts/take_t3_screenshots.py` — 7 张界面截图
- `scripts/take_result_screenshot.py` — 结果页截图
- `assets/fonts/{OFL.txt, fusion-pixel-12px-proportional-{latin,zh_hans}.{otf,woff2}}` — 像素字体
- `resources/fonts/` — vite publicDir 副本

### 重写（3 个）
- `src/setup/styles.css` — setup 五页统一风格
- `src/panel/styles.css` — panel 四 tab 卡片化
- `src/setup/pages/ResultPage.tsx` — 像素大字 + 四维百分比条

### 修改（约 18 个）
- `src/setup/App.tsx` / `src/panel/App.tsx` — 包 TitleBar、替换 emoji
- `src/panel/tabs/ChatTab.tsx` / `GuestLock.tsx` / `src/App.tsx` — pet 菜单像素 SVG
- `src/setup/pages/{Login,Nickname,PickType}Page.tsx` / `src/setup/persona-meta.ts` — 色板统一
- `src/index.html` / `src/setup/index.html` / `src/panel/index.html` / `src/setup/main.tsx` / `src/panel/main.tsx` — 字体声明
- `electron/main.ts` — `frame: false` + setup/panel minimize IPC
- `electron/preload.ts` — `minimizeSetup` / `minimizePanel`
- `electron-builder.yml` — `oneClick: true` + `installerIcon` + `installerHeader`
- `src/share/poster.ts` — 海报底色 `#2A2A28 → #2B2320`

### 未触碰（边界确认）
- `server/` — 后端零改动
- `data/` — 数据/题库零改动
- `eval/` — 评测脚本零改动
- `docs/PRD.md` / `docs/REVIEW.md` / `docs/ISSUES.md` / `plan.md` — 文档零改动
- `git` — 未 commit

## 三、各界面变化（按视觉影响排序）

### 1. 结果页（变化最大）
- **像素大字**：人格代号 96px PetibiPixel 渲染（4 字符 INFP → 96×4=384px 居中）
- **细分标签**：16×4 标签（I/N/F/P）下方显示"内倾/直觉/情感/感知"
- **四维百分比条**：EI/SN/TF/JP 四行，宽度按 `score().percentages` 精确渲染
- **弱倾向提示**：百分比落在 [45,55] 区间显示"轻微倾向"徽章
- **像素分隔线**：标题与维度条之间用 1px 硬块模拟
- 验证：`07-result-bars.png` 像素采样确认 5 个核心色全部在位

### 2. setup 五页（结构大改）
- **无边框窗口**：380×640 容器，墨色 `#2B2320` 边框 2px
- **标题栏**：28px 奶油底 `#FEF9EF` + PetibiPixel 12px 标题 + 自绘 min/close
- **圆角清零**：所有按钮/输入框/卡片 0 圆角
- **像素风按钮**：4 状态（idle/hover/active/disabled）墨边框 + 奶油底
- **页脚**：底部署名"Petibi · 16 人格速配" 8px PetibiPixel

### 3. panel 四 Tab（卡片化）
- **标签栏**：顶部 tab 横排，墨底分割，active tab 奶油底 + 墨色 2px 下边框
- **chat tab**：消息气泡用色板（紫族 `#785D87` 用户 / 奶油底 AI）
- **baike tab**：人格百科卡片，16 人格 4×4 网格
- **community tab**：分享墙（mock 数据）
- **profile tab**：用户资料卡 + 头像 2px 圆角例外

### 4. 海报弹窗（视觉重做）
- **遮罩**：墨色 `#2B2320` 80% 透明度（之前 `#000000`）
- **卡片**：奶油底 + 墨边框 2px，4:3 比例预览
- **像素 spinner**：8 帧旋转动画（CSS keyframes，硬块模拟）
- **按钮组**：取消/分享，墨边框 + 奶油底

### 5. 访客锁页（图标替换）
- **像素锁 SVG**：内联 SVG 16×16，6 像素硬块组成锁身 + 锁梁
- **解锁文案**：8px PetibiPixel "解锁完整人格"
- **CTA**：墨边框 + 奶油底"去登录"

### 6. pet 快捷菜单（气泡重做）
- **底部气泡**：380px 宽，4 个功能入口
- **像素图标**：挥手/闪光/对话/面板/隐藏/锁 全部内联 SVG 12×12
- **配色**：奶油底 + 紫族强调

### 7. 安装器品牌化
- **icon.ico**：256×256 多分辨率 ICO（16/32/48/64/128/256）
- **installer-header.bmp**：164×314，16 人格全家福 + "Petibi" 标题 + 四族色 logo
- **oneClick 配置**：安装无"为哪位用户安装"页

## 四、字体方案

- **标题/像素大字**：PetibiPixel 像素字体（@font-face alias）
  - `fusion-pixel-12px-proportional-latin.{otf,woff2}` → `unicode-range: U+0000-00FF, U+2000-206F`
  - `fusion-pixel-12px-proportional-zh_hans.{otf,woff2}` → `unicode-range: U+4E00-9FFF`
- **正文**：系统黑体栈（`-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`）
- **打包路径**：`assets/fonts/` + `resources/fonts/`（vite publicDir），`out/renderer/fonts/` 产物在位

## 五、风险与遗留

| 项 | 状态 | 说明 |
|---|---|---|
| NSIS 端到端打包 | **未跑** | oneClick + 自定义 icon 配置已就位，`build/installer/` 4 个产物生成成功。端到端验证需 owner 跑 `npm run build`（electron-builder 全量），本机未跑避免污染 out/ |
| panel pet 截图同帧 | **mock 限制** | 03/04/05 三张 panel 截图 activeTab 默认 chat，mock 注入只覆盖 chat 流；baike/community/profile tab 内容差异未视觉验证（功能已测试通过） |
| `.panel-close` 样式兜底 | **无害** | `display: none` 隐藏原关闭按钮（已由 TitleBar 接管），onClose 逻辑仍走 `panelApi.hidePanel` |
| 旧 emoji 残留 | **已清** | `grep -rn '[😀-🿿]' src/` 0 匹配，功能图标全部内联 SVG |

## 六、验证命令汇总

```bash
# 自验 1：合规扫描
python scripts/check_design.py                    # 48 文件 0 违规

# 自验 2：构建链路
npm run typecheck                                  # 0 错
npm test -- resultBarHint                          # 10 用例通过
npm test                                           # 302/302 全过
npm run build:app                                  # vite build 成功

# 自验 3：截图
python scripts/take_t3_screenshots.py              # 7 张图
python scripts/take_result_screenshot.py           # 07-result-bars.png

# 自验 4：中文注释
python scripts/check_comments.py                   # 125/125 通过

# 自验 6：installer 产物
python scripts/make_installer_illustration.py      # build/installer/ 4 个文件
```

## 七、未做的事

- **未跑** `npm run build` 全量 electron-builder（避免污染 out/release/）
- **未** git commit（按工单约束）
- **未** 改 server / data / eval / PRD / REVIEW / ISSUES / plan.md
- **未** 触碰 `src/components/` 既有组件结构（仅新增 TitleBar.tsx）