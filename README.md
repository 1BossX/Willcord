# Worker Plane MVP

中心化 Agent 控制面；模型调用、会话和调度运行在主节点，Rust worker 通过出站 WSS 执行工具。

技术决定与系统行为见 [最终架构方案](docs/architecture.md)，阶段拆分与验收门槛见 [开发计划](docs/development-plan.md)。尚需提供的环境资源和开工准备见 [资源与待办](docs/resources-and-todos.md)。

## 当前状态

P0 Pi runtime spike 的八条验收已在受控环境通过，证据见 [P0 结果](spikes/pi-runtime/RESULTS.md#p0-最终验收矩阵2026-10-07)。

P1 工程、协议、存储与身份实施涵盖 pnpm workspace、Fastify/SQLite、认证/CSRF、React worker 状态、Rust worker WSS 注册、epoch/心跳/对账，以及安全执行槽与 workspace 映射保护。P1 不开放模型生成的命令执行。构建方式和验收证据见 [P1 开发记录](docs/p1-development.md)。
