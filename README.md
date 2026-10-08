# Worker Plane MVP

中心化 Agent 控制面；模型调用、会话和调度运行在主节点，Rust worker 通过出站 WSS 执行工具。

技术决定与系统行为见 [最终架构方案](docs/architecture.md)，阶段拆分与验收门槛见 [开发计划](docs/development-plan.md)。尚需提供的环境资源和开工准备见 [资源与待办](docs/resources-and-todos.md)。

## 当前状态

P0 Pi runtime spike 的八条验收已在受控环境通过，证据见 [P0 结果](spikes/pi-runtime/RESULTS.md#p0-最终验收矩阵2026-10-07)。

P1 工程、协议、存储与身份阶段已实现 pnpm workspace、Fastify/SQLite、认证/CSRF、React worker 状态、Rust worker WSS 注册、epoch/心跳/reconcile，以及安全执行槽和 workspace 映射保护。P1 不开放模型生成的命令执行。构建方式和验收证据见 [P1 开发记录](docs/p1-development.md)。

P2 已实现固定 worker/workspace 会话、FIFO job 调度、Pi 工具 checkpoint、WSS read/write/bash 执行、离线等待和基础聊天任务列表。`venus-local` Linux x86_64 经临时 CA 验收完成，并验证了 138 KB 分块写入和远程校验；P2 记录见 [P2 开发记录](docs/p2-development.md)。P2 仅用于受控演示，崩溃恢复等 P3/P4 保证仍未验收。

工作台 UI 按原文档重组为机器/会话导航、固定目标聊天与任务时间线，设计映射、状态边界和浏览器证据见 [UI 设计记录](docs/ui-design.md)。
