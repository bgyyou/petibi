# Petibi 开发协议（DEV-PROTOCOL）

> 2026-08-12 owner 定，所有会话必须遵守（防上下文压缩丢失）。

## 主/子 agent 分工

- **K3（主 agent）只做三件事**：与 owner 讨论需求、写工单、终审（看交付报告 + 抽查关键点）
- **M3（子 agent）包干执行**：所有工具调用 / 代码 / 测试 / 初步自查
- K3 不全量读文件、不用读图做技术校验（色值等比对一律用脚本）；目检类判断可少量抽查

## 派单纪律

1. **子 agent 必须绑定 secondary model（MiniMax M3）**。绑定验证方法：先派一个最小测试任务（如读 palette.json 汇报颜色数），owner 在界面确认显示 MiniMax M3 后才许派大任务
2. **所有子 agent 一律 `run_in_background=true`**，owner 在 /tasks 面板看状态
3. 工单必须含**自验清单**；M3 交付报告必须附**实际命令输出**（不许只写结论）
4. 美术任务：单只动物生成**重试上限 5 次**；**禁止用 ReadMediaFile 逐张检查代替脚本校验**
5. 派单前先写数据契约/接口契约文档，M3 按契约施工
6. M3 不做 git commit；不动 PRD.md / REVIEW.md / ISSUES.md / plan.md / 工单文件本身

## 已知教训

- secondary_model 配置修改后需 `/reload` 或 `/secondary_model` 显式绑定，否则子 agent 回落 K3 烧主模型配额（2026-08-12 事故）
- 子 agent 汇报不可全信，终审以脚本校验输出为准
