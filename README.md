# Worker Plane MVP

中心化 Agent 控制面；模型调用、会话和调度运行在主节点，Rust worker 通过出站 WSS 执行工具。

技术决定与系统行为见 [最终架构方案](docs/architecture.md)，阶段拆分与验收门槛见 [开发计划](docs/development-plan.md)。尚需提供的环境资源和开工准备见 [资源与待办](docs/resources-and-todos.md)。

## 当前状态

P0 Pi runtime spike 的八条验收已在受控环境通过，证据见 [P0 结果](spikes/pi-runtime/RESULTS.md#p0-最终验收矩阵2026-10-07)。当前实现是实际 Pi SDK + SQLite 的 single-owner spike；当前已开始 P1 工程、协议、存储与身份开发，尚未具备生产工具执行能力。

P1 工程与身份基础已开始实施：pnpm workspace、Fastify/SQLite、React 登录与机器状态、Rust WSS 身份与连接。构建方式、已验证证据与剩余验收见 [P1 开发记录](docs/p1-development.md)。P1 全量验收尚未完成，任务执行未开放。
