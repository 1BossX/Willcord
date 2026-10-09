# Worker Plane 工作台 UI

日期：2026-10-08

依据：[原始架构](architecture.md)第 2、12 节，以及 [开发计划](development-plan.md)的 P6 UI 验收要求。此次将 P2 演示页重组为工作台，复用已有认证、固定会话和任务接口。

## 信息结构

| 区域 | 内容与行为 |
|---|---|
| 左侧导航 | Main Agent 置顶；机器连接状态与执行状态分开；仅列出当前机器的独立会话；新建会话入口与退出登录 |
| 主会话区 | 固定 worker/workspace 目标条、按任务组织的聊天、可展开 read/write/bash 结果、固定输入区 |
| 右侧时间线 | 当前会话的任务状态、输入摘要、机器队列位置、提交/开始时间、工具调用数量与等待截止时间 |
| 手机布局 | 机器与会话导航改为左侧抽屉，任务时间线改为右侧抽屉，聊天和输入区保留在主屏幕 |

Main Agent 当前展示后续协调入口和机器概览，明确标为“即将开放”。尚未提供的委派、取消、人工核对不会出现可误操作的按钮。

## 行为与状态

- 每个会话创建前必须显式选择机器与工作目录，并显示仓库和绝对路径；创建后无法在会话内静默切换目标。
- `online` 表示连接，`active_job_id` 表示机器占用，`blocked` 表示需要核对；离线且未占槽显示“离线 / 未就绪”，离线且占槽仍保留忙碌或需要核对状态。
- 任务的排队位置从同一 worker 的所有排队会话计算，不能按当前会话列表猜测。忙碌、离线和需要核对分别显示对应等待原因。
- 切换机器/会话先清空旧聊天与任务，取消旧读取请求；刷新恢复所选会话和认证状态。变更请求实时读取当前 CSRF token。
- 工具卡默认折叠。失败展示真实错误；bash 非零退出仍展示实际退出码；文件 hash 和 call/job 标识放在详情中；截断提示保留。
- `needs_attention` 不显示已完成，说明机器保留占用且不会自动重跑。手机隐藏导航使用 `inert`，抽屉支持关闭按钮、遮罩和 Escape；对话框使用原生 `<dialog>`。

## 最小 API 补充

`GET /api/workers` 增加从 `worker_slots` 读取的 `active_job_id`。会话 jobs 响应增加 `input_text`、`worker_id`、`wait_until` 和按机器计算的 `queue_position`。无 Cookie 的 `/auth/session` 返回 `authenticated: false`，不尝试计算不存在的 token digest。

## 验证与截图

浏览器检查使用临时 SQLite 中的受控状态样例和真实 Fastify 认证/API，包括在线空闲、在线忙碌、离线等待和需要核对。通过界面创建 documentation 会话并提交消息，真实落库为 queued、机器队列第 3 位，原活动 job 未变。切换到另一机器与刷新后，没有残留前一会话的数据。

这些截图证明界面及 API 行为，不能作为真实 worker 执行或 P6 全量故障恢复证据。已有 P2 真实 worker 执行证据仍见 [P2 记录](p2-development.md)。

- [登录页](../output/playwright/ui-redesign/01-login.webp)
- [Main Agent 与机器概览](../output/playwright/ui-redesign/02-main-agent.webp)
- [三栏会话工作台](../output/playwright/ui-redesign/03-conversation.webp)
- [展开工具输出](../output/playwright/ui-redesign/04-tool-output.webp)
- [固定目标选择](../output/playwright/ui-redesign/05-fixed-target-dialog.webp)
- [离线等待与截止时间](../output/playwright/ui-redesign/06-offline-queue.webp)
- [需要核对](../output/playwright/ui-redesign/07-needs-attention.webp)
- [手机会话](../output/playwright/ui-redesign/08-mobile-conversation.webp)
- [手机导航](../output/playwright/ui-redesign/09-mobile-navigation.webp)
- [手机时间线](../output/playwright/ui-redesign/10-mobile-timeline.webp)

TypeScript 检查、Vite 生产构建和服务端 14 项回归覆盖该改动。API 断言验证了未登录认证检查、执行槽字段和跨 session 机器队列位置。

本机检查使用 Node 22.22.3；仓库规定的 Node 24 CI 矩阵尚未运行。临时浏览器、预览服务和内存数据库在验收后关闭，截图保留。

## 后续阶段边界

持久委派由 P5 提供；取消、人工核对和完整日志查看已在 P4 实现（见 [P4 开发记录](p4-development.md#ui)）；快照游标和 SSE 补放仍需后续实现。本次继续使用认证轮询，不将 UI 重设计标为 P6 全量通过。
