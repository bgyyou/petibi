; 【文件说明】M5 P1-C 修复：自定义 NSIS 完成页文案（中文）
;
; electron-builder 25.x 的 NSIS 模板（assistedInstaller.nsh）默认行为：
;   - oneClick: false（assisted 向导模式）时，会定义 MUI_FINISHPAGE_RUN + MUI_FINISHPAGE_RUN_FUNCTION，
;     完成页会显示"Launch <productName>"复选框，默认勾选；
;   - 但 MUI 默认 SimpChinese 下复选框文案是"启动 <productName>"——shorter and less friendly。
;
; 本脚本在 assistedInstaller.nsh 之后被 include，覆盖 MUI_FINISHPAGE_RUN_TEXT / MUI_FINISHPAGE_TEXT /
; MUI_FINISHPAGE_TITLE 三个宏为更友好的中文文案：
;   - 复选框：「运行 Petibi」
;   - 完成页副标题：「Petibi 已安装到您的电脑。点击「完成」关闭，或勾选「运行 Petibi」立即启动。」
;   - 完成页标题：「Petibi 安装完成」
;
; 关键约束：
;   1. 不要重复 !define MUI_FINISHPAGE_RUN / MUI_FINISHPAGE_RUN_FUNCTION——assistedInstaller.nsh
;      已经定义好且挂了 StartApp 函数（走 StdUtils.ExecShellAsUser 调 launchLink），这里只覆盖文本；
;   2. 不要重新定义 MUI_PAGE_FINISH——assistedInstaller.nsh 已经调用过；
;   3. 用 !ifndef BUILD_UNINSTALLER 防止 uninstaller 也加载（虽然 include 路径只在 install 阶段 include，
;      但显式判定更稳）；
;   4. 这些 !define 必须在 MUI_PAGE_FINISH 之前生效——electron-builder 的 script 模板里 include
;      位置在 assistedInstaller.nsh 之前（见 builder-debug.yml），所以自定义文件先 include，
;      再被 assistedInstaller.nsh 调用 MUI_PAGE_FINISH 时即可消费。
;
; MUI_FINISHPAGE_RUN_CHECKED 也显式声明：让复选框默认勾选，用户不用点一下就直接能用。
;
; 验证方式：跑 `npm run build`，新装 release/Petibi Setup 0.1.0.exe 完成页看复选框文案。

!ifndef BUILD_UNINSTALLER
  ; 复选框文案：MUI 默认"启动 Petibi" → "运行 Petibi"
  !define MUI_FINISHPAGE_RUN_TEXT "运行 Petibi"
  ; 复选框默认勾选：owner 实测"装完直接结束"——期望用户一按完成就立刻有桌宠出来。
  ; 不勾选的话用户还得手动点一下复选框，体验差。
  !define MUI_FINISHPAGE_RUN_CHECKED
  ; 完成页标题：默认 "$(^Name) 安装完成" → "Petibi 安装完成"（更短）
  !define MUI_FINISHPAGE_TITLE "Petibi 安装完成"
  ; 完成页正文：默认 "$(^Name) 已安装到您的电脑。"（无后续动作提示）→ 加上"勾选运行 Petibi"引导
  !define MUI_FINISHPAGE_TEXT "Petibi 已安装到您的电脑。$\r$\n$\r$\n点击「完成」关闭安装向导，或勾选「运行 Petibi」立即启动桌宠。"
!endif