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
- （测试账号规则见下方专节）

## 会话轮换规则（2026-08-14 owner 提出，防上下文膨胀降智）

- 主 agent 上下文超 ~350k 或里程碑收口时，owner 开新会话接续
- 轮换前主 agent 必须把「当前状态 + 进行中任务 + 下一步」写进 plan.md（当前卡点区）
- 新会话第一句："继续 Petibi 项目"；主 agent 按 plan.md → ISSUES.md → 本文件 → docs/inbox/ 顺序恢复上下文
- 注意：cron 定时任务和挂起的子 agent 绑定旧会话 id，轮换前确保无未完成的后台任务
- 评测类任务按协议本来就必须新会话执行

## 统一测试账号（M5 真 API 接入工单 · 2026-08-14 起生效）

- **agent 自动化测试统一使用 `test@petibi.local` + 验证码 `123456`** 走快速登录通道。
  server 端 `routes/auth.ts` 的 `isTestAccountFastPath()` 在 `env !== "prod"` 时直接放行，
  不查 `email_codes` 表、不写日志验证码。
- 禁止 agent 在测试脚本里新建随机账号（`alice-1234@example.com`、`user_<uuid>@...` 等）。
  原因：每次跑都往 users 表堆一行脏数据，配额计数也跟着膨胀，重复跑会撞 R4 拦截；
  且 owner 没法一眼看出"哪个 user 是测试残留"——`test@petibi.local` 一搜就到。
- 需要"另一个 user 测多用户场景"的脚本可以再注册一组专用账号（如 `test2@petibi.local`），
  但要先把规则加到这里并对应实现 server 端白名单，不允许脚本随手造新邮箱。
- 测试账号快速通道在 `PETIBI_ENV=prod` 时**自动关闭**（返回 400 INVALID_CODE），
  避免被外部站点撞到 `test@petibi.local` 偷 token。
- 与 `.env` 配合：`PETIBI_DISABLE_QUOTA=1` + 测试账号组合是 agent 跑对话回归的标准姿势。
