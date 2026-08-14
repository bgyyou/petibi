# 工单：UI 全面返工（DESIGN.md v1 落地）

> 里程碑：T3 | 执行：子 agent（M3） | 终审：主 agent 脚本校验 + owner 截图目检
> 依据：docs/DESIGN.md（唯一视觉标准，先完整读）

## 范围

1. **字体**：下载缝合像素字体（Fusion Pixel，SIL OFL，GitHub: TakWolf/fusion-pixel-font）打包进 assets/fonts/，CSS @font-face 引入，标题用像素字体、正文系统黑体
2. **无边框窗口**：setup / panel 两个窗口 frame:false + 自绘标题栏组件（28px、奶油底 #FEF9EF、左 Petibi 像素标 + 标题、右侧自绘最小化/关闭按钮、app-region:drag 可拖拽、按钮无拖拽区）。桌宠窗已无边框不动
3. **界面返工**（全部按 DESIGN.md tokens：无圆角 / 3px 墨边框 #2B2320 / 硬阴影 4px / 奶油底 / 族色强调）：
   - setup 五页（登录/昵称/选人格/测试/结果）
   - 主面板四 Tab（对话/百科/社区/我的）+ 访客锁定页
   - 快捷菜单气泡
   - 海报预览弹窗
4. **结果页升级**（P2-023）：人格大字 + 细分标签（坚定型/善感型）+ **四维百分比条**（每维两字母对比如 E 51% / I 49%，族色填充）；某维度落在 45%-55% 时显示提示「这个维度你的倾向较弱，结果可能随状态波动」
5. **emoji 图标替换**：🎨 等功能图标改为像素风 CSS 绘制或内联 SVG icon
6. **NSIS 安装器品牌化**：electron-builder.yml 改 oneClick 一键安装 + 自定义图标；品牌插画（164×314 左侧图）先用像素占位图（脚本生成 16 人格 sprite 排列图即可），AI 正式插画后续单独出稿替换

## 自验清单（真实运行，输出贴报告）

1. 风格合规脚本 scripts/check_design.py：扫描 src/**/*.tsx/css，断言零 rounded-lg/xl/full、零 gradient、零 shadow-lg/xl（柔和阴影）、边框色值统一
2. 根 + server vitest 不回归；typecheck 0 错；`npm run build` 出安装包（oneClick 生效：安装过程无"为哪位用户安装"页）
3. 结果页百分比条：mock 各维度边界值（51/49）截图或测试验证提示文案出现
4. check_comments 通过
5. **每个界面截图**（dev 或安装版）存 docs/tech/screenshots/t3/，供 owner 目检

## 约束

- 不改功能逻辑，只改视觉与窗口框架；组件结构保持
- 不动 server/、data/、eval/、PRD/REVIEW/ISSUES/plan.md
- 中文注释（R9）；不 git commit
- 交付报告 docs/tech/T3-UI返工-交付报告.md
