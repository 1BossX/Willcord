# Willcord（WorkerPlane）

**大脑留在中心，机器只管执行。**

面向内网与生产环境的 AI 运维控制面；模型调用、会话和调度运行在主节点，Rust worker 通过出站 WSS 执行工具。断线先对账，未知不重跑。

产品展示名采用 **Willcord**，视觉方向采用 B「错位牵引」。工程仓库、包名、CLI、服务名与配置路径仍沿用 WorkerPlane，具体使用现有运维文档中的命令。

- [静态产品介绍页源码](site/index.html)（GitHub Pages 待发布）
- [品牌资产与规范](docs/brand/willcord/README.md) · [名称核验及待办](docs/brand/naming-shortlist.md)

模型密钥集中在主节点，执行机器无需直接访问模型服务，也无需开放入站端口；执行端仍需访问主节点并保存设备身份与凭据。项目仍处于开发与受控验收阶段，不能把品牌更新视为生产验收完成。

技术决定与系统行为见 [最终架构方案](docs/architecture.md)，阶段拆分与验收门槛见 [开发计划](docs/development-plan.md)。尚需提供的环境资源和开工准备见 [资源与待办](docs/resources-and-todos.md)。

## 安全与许可证

Bash 使用执行端服务账户的实际权限，工作目录限制**不是 shell 沙箱**。使用独立、最小权限账户；当前为单管理员设计，不向不可信用户开放执行。文件内容、命令输出和会话可能进入模型上下文，采用前需确认模型服务的数据处理策略。详情见 [安全策略](SECURITY.md)。

项目采用 [Apache License 2.0](LICENSE)。品牌名称与 Logo 的使用边界见 [品牌说明](BRAND.md)；依赖的许可证仍适用，第三方清单见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 当前状态

P0 Pi runtime spike 的八条验收已在受控环境通过，证据见 [P0 结果](spikes/pi-runtime/RESULTS.md#p0-最终验收矩阵2026-10-07)。

P1 工程、协议、存储与身份阶段已实现 pnpm workspace、Fastify/SQLite、认证/CSRF、React worker 状态、Rust worker WSS 注册、epoch/心跳/reconcile，以及安全执行槽和 workspace 映射保护。P1 不开放模型生成的命令执行。构建方式和验收证据见 [P1 开发记录](docs/p1-development.md)。

P2 已实现固定 worker/workspace 会话、FIFO job 调度、Pi 工具 checkpoint、WSS read/write/bash 执行、离线等待和基础聊天任务列表。`linux-test-worker` Linux x86_64 经临时 CA 验收完成，并验证了 138 KB 分块写入和远程校验；P2 记录见 [P2 开发记录](docs/p2-development.md)。P2 仅用于受控演示。

P3 已实现 worker 账本去重、重连对账与主节点重启恢复，无法证明执行情况时阻塞机器；故障程序与验收见 [P3 开发记录](docs/p3-development.md)。

P4 已实现取消全链路、进程组控制与超时、任务预算、分块输出与补读、磁盘拒绝、人工处置接口和基础 UI；11 条验收与故障程序见 [P4 开发记录](docs/p4-development.md)。

P5 已实现 Main Agent 与持久化委派：Main session，list_workers/get_job/delegate，委派与用户任务共用 FIFO，前置依赖和验证命令，等待子任务，重启恢复，父取消传播，根预算和结构化结果；11 条验收与故障程序见 [P5 开发记录](docs/p5-development.md)。

P6 已实现事件流与完整 UI：带游标快照、SSE 补放与游标过期、模型草稿、日志缺口，UI 改为快照 + SSE，实时显示机器可执行状态、委派子任务、排队与等待原因、取消和人工核对；9 条验收、故障程序和浏览器走查见 [P6 开发记录](docs/p6-development.md)。

P7 进行中：调度暂停、在线备份与恢复、升级快照、token 轮换、保留策略与磁盘检查见 [P7 开发记录](docs/p7-development.md)；安装、升级与恢复步骤见 [运维手册](docs/operations.md)。

工作台 UI 按原文档重组为机器/会话导航、固定目标聊天与任务时间线，设计映射、状态边界和浏览器证据见 [UI 设计记录](docs/ui-design.md)。

外部调研、最佳实践与经验教训沉淀在 [docs/research](docs/research/README.md)，供后续阶段设计参考。
