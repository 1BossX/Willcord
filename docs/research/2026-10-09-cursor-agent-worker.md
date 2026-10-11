# Cursor agent worker / 自托管执行调研

调研日期：2026-10-09（所有链接访问日期同此）。Cursor 的 `agent worker` 与 Willcord 同构：agent loop、推理、会话在中心，worker 出站长连接只执行工具。

本文只用 Cursor 官方文档与官方博客作为事实依据；第三方材料单列在“二手/未核实”一节，不进入结论。标记约定：**[事实]** 为一手来源所述（附链接）；**[推断]** 为我们的理解；**[未核实]** 为未找到一手来源支持。

## 来源

### 一手（官方）

| 来源 | 说明 |
| --- | --- |
| [Self-Hosted Machines](https://cursor.com/docs/cloud-agent/self-hosted) | 总览：My Machines vs Team Pools、连接方式、数据外流、密钥、规模上限、K8s 模板 |
| [Self-Hosted Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool) | Pool 现行权威页：空闲释放、生命周期、管理端点、worker controller、Helm/operator 弃用、fleet summary API、token |
| [Private Cloud Workers](https://cursor.com/docs/cloud-agent/self-hosted/private-workers) | 页面标注 Deprecated、“no longer maintained”，指向 Pool 文档 |
| [CLI Parameters](https://cursor.com/docs/cli/reference/parameters) | `agent worker start`/`debug` 参数表 |
| [anysphere/k8s-workers](https://github.com/anysphere/k8s-workers) | 官方 K8s 模板（由 self-hosted / pool 文档链接） |
| [Run cloud agents in your own infrastructure](https://cursor.com/blog/self-hosted-cloud-agents)（2026-03-25） | 首发博客：每 session 独占 worker、Helm/operator |
| [Run cloud agents on machines you manage](https://cursor.com/blog/self-hosted-machines)（2026-09-02） | split 动机、休眠/快照、按需 controller |
| [What we've learned building cloud agents](https://cursor.com/blog/cloud-agent-lessons) | Temporal、loop 与机器解耦、流式重试等经验 |

### 二手/未核实

| 来源 | 处理 |
| --- | --- |
| [Renting a Cloud Agent's Execution Sandbox](https://agentpatterns.ai/patterns/agent-design/rented-execution-sandbox) | 模式抽象，仅作术语参考。其中“worker token 一小时且不能刷新”与 [Pool 文档](https://cursor.com/docs/cloud-agent/self-hosted/pool) 矛盾（见下），**不采信**；Vercel Sandbox 限额未查 Vercel 一手文档，**未核实**，本文不使用 |
| [cursor-agent-architecture](https://github.com/advaitpaliwal/cursor-agent-architecture) | 第三方逆向，对象是 Cursor 托管 VM，不是 `agent worker` 路径。“运行时按内容哈希注入”和安全反例（token 进进程表、0.0.0.0 监听、无认证 Docker API、privileged+host 网络、GitHub token 写全局 git config）均**未核实**，只作为我们自查清单的灵感，不作为对 Cursor 的事实陈述 |

## 来源矛盾与处理

| 矛盾 | 处理结论 |
| --- | --- |
| 空闲释放默认值：[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool) 与 [Private Workers](https://cursor.com/docs/cloud-agent/self-hosted/private-workers) 正文称默认 `3600` 秒；[CLI 参数表](https://cursor.com/docs/cli/reference/parameters) 写 `0`（禁用），Private Workers 页内的 CLI 表也写“no timeout” | **未完全解决**。[推断] Pool 模式（及 controller 场景）实际默认可能为 3600，裸 `start` 为 0；官方未说明区分条件。连同一页面都自相矛盾，本身就是“值得避免”的样本 |
| Helm chart / operator：[3 月博客](https://cursor.com/blog/self-hosted-cloud-agents) 称提供 Helm chart 与 `WorkerDeployment` operator；现行文档推荐无 CRD 的 k8s-workers 模板 | **已解决**：[Pool 文档](https://cursor.com/docs/cloud-agent/self-hosted/pool) 明确 operator 与 `WorkerDeployment` Helm chart 已弃用，存量可用，新部署用 [k8s-workers](https://github.com/anysphere/k8s-workers)（`agent worker controller --spawn`，不需要 CRD）。旧稿“operator 在路线图上”是错的 |
| Private Workers 页是否弃用 | **已确认**：页面标注 Deprecated，指向 [Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool) |
| token 寿命：二手材料称一小时不可刷新 | **一手来源推翻**：[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool) 称 `--auth-token-file` 在重连时重读、controller 可无重启轮换；session token 服务一次 claim，`CURSOR_AUTH_TOKEN_EXPIRES_AT`（7 天）只是兜底，并有 Create A Session Token 接口换发 |

空白：所有官方材料都未说明断线时在途工具调用的重试、幂等与对账。[推断] Willcord P3 的账本/epoch/fence 在这方面比公开资料更深，不应为“对齐”而简化。

## 关键事实

- **连接** [事实]：worker 开出站 HTTPS 长连接，无需入站端口/公网 IP/VPN，支持 `HTTPS_PROXY`（[Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted)；[博客](https://cursor.com/blog/self-hosted-machines)）。旧稿“HTTP/2 bridge”在所查页面中**未找到**，删除。
- **形态** [事实]：My Machines 用个人凭据、一台机器可跑多个 agent；Team Pools 用服务账号 key、一台机器一次一个 agent，需 Enterprise（[Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted)）。Pool worker 拒绝用户/个人/团队/组织 key（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。
- **生命周期** [事实]（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）：认领 → 会话结束开始空闲计时 → 追问重置计时 → 超时后 CLI 以退出码 0 退出、worker 被标记释放并可重置重新入池；工作区不保留，除非启用休眠（[博客](https://cursor.com/blog/self-hosted-machines)：快照并停机，重连窗口内追问恢复且保留 worker ID，否则转新机器）。
- **管理端点** [事实]：`--management-addr` 暴露 `/healthz`、`/readyz`、`/metrics`，含 `cursor_self_hosted_worker_connected`、`cursor_self_hosted_worker_session_active` 等指标（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。**[未核实]** 旧稿“`/readyz` 仅在已连接且未认领时 200”——文档未定义 ready 语义；默认绑定地址文档也未给出（[CLI](https://cursor.com/docs/cli/reference/parameters)）。
- **controller** [事实]：`agent worker controller --spawn <hook>` 默认 claim-then-spawn，每次认领触发一次 spawn；`--warm-idle <n>` 每池保持 n 个未认领 worker（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。
- **Fleet API** [事实]：`GET /v0/private-workers/summary` 返回用户/团队的已连接与在用数量，文档建议按团队利用率（如 90%）扩容（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。
- **参数** [事实]（[CLI](https://cursor.com/docs/cli/reference/parameters)）：`--auth-token-file`、`--worker-dir`（可重复，首个为分配身份）、`--data-dir`、`--label`/`--labels-file`、`--pool`（`--single-use` 为旧别名）、`--pool-name`（默认 `default`）、`--idle-release-timeout`、`--computer-use`、`--management-addr`；`agent worker debug [--json]` 预检认证、隐私与路由。
- **外流数据** [事实]（[Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted)）：文件内容、终端输出、diff、截图、本地 MCP 结果、路由元数据（共享桌面时还有桌面流）；完整 checkout、构建缓存与本机凭据留在本地。产物上传 `cloud-agent-artifacts.s3.us-east-1.amazonaws.com`，屏蔽后 agent 继续工作只是无产物。官方博客也承认工具输出仍回流、转写可能存于 Cursor（[博客](https://cursor.com/blog/self-hosted-machines)）。
- **密钥** [事实]：环境级密钥与 Build Secrets 永不下发 worker；Pool worker 加 `--sync-dashboard-secrets` 且管理员开启后才以环境变量收到团队/用户密钥；My Machines 不收 dashboard 密钥（[Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted)）。
- **规模** [事实]：每用户 200、每团队 1000 worker（[Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted)）。

## 值得学习

1. **存活与可调度分离**：`/healthz` 与 `/readyz` 分开，另配连接/会话 gauge（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。[推断] readiness 应可驱动扩缩容；Cursor 实际用 fleet summary API 做扩容信号。
2. **`debug` 预检 + JSON 输出**作为安装排障入口（[CLI](https://cursor.com/docs/cli/reference/parameters)）。
3. **token 从文件读取且重连时重读**，轮换无需重启（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。
4. **完整列出外流数据并说明降级行为**（[Self-Hosted](https://cursor.com/docs/cloud-agent/self-hosted)）。
5. **短 workflow**：从“永不结束”的 agent workflow 改为每任务一个短 workflow，便于版本升级（[lessons](https://cursor.com/blog/cloud-agent-lessons)）。
6. **重试流回退**：部分输出后失败重试，客户端识别重试、回退流再显示新输出（[lessons](https://cursor.com/blog/cloud-agent-lessons)）。
7. **大输出落成可搜索文件**，让模型用工具查（[lessons](https://cursor.com/blog/cloud-agent-lessons)）。
8. **卡住的 agent 可能空等数小时无人发现**（[lessons](https://cursor.com/blog/cloud-agent-lessons)）。
9. **环境缺失导致静默质量下降**，常被误判为模型问题（[lessons](https://cursor.com/blog/cloud-agent-lessons)）。
10. **空闲释放以退出码 0 结束**，交给 supervisor 回收（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)）。
11. **按需 claim-then-spawn**：请求排队而不是预估容量（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool)；[博客](https://cursor.com/blog/self-hosted-machines)）。

旧稿第 11 条“运行时按内容哈希注入”仅来自逆向笔记，已移出（未核实）。

## 值得避免

1. **自研拼凑可靠执行原语**：初版只有约一个 9，迁 Temporal 后超过两个 9（[lessons](https://cursor.com/blog/cloud-agent-lessons)）。[推断] 我们用 SQLite + 账本可以，但可靠性必须由不变量测试与故障程序持续保证。
2. **以“执行搬回本地”宣称解决数据外流**：工具输出与转写仍到中心（[博客](https://cursor.com/blog/self-hosted-machines)）。[推断] 中心会话/日志库应按源码级敏感数据管理。
3. **释放后承载对话式追问**：重建工作区需数分钟，Cursor 为此引入休眠/快照（[博客](https://cursor.com/blog/self-hosted-machines)）。
4. **同一参数多处文档默认值互相矛盾**（见上表 idle-release 一项）。
5. **组件更迭留下过时一手文档**：operator/Helm 发布半年即弃用，博客仍保留旧说法（[Pool](https://cursor.com/docs/cloud-agent/self-hosted/pool) vs [3 月博客](https://cursor.com/blog/self-hosted-cloud-agents)）。

已删除旧稿条目：“长会话依赖不可刷新的短期 token”——依据是二手材料，被 Pool 文档推翻；“逆向笔记安全反例”降级为二手节中的自查灵感。

## 对 Willcord 的映射与建议动作

现状核对（2026-10-09，分支 `feat/p4-faults`）：

- `apps/server/src/app.ts:117-121` 的 `/health` 返回 `scheduling_ready: true` 硬编码（`:119`），不满足 P7 验收 2。
- worker token 来自环境变量：`worker/src/main.rs:231` `std::env::var("WORKER_TOKEN")`，不支持文件与轮换。
- 子进程 `env_clear()`：`worker/src/process.rs:132`、`worker/src/tools.rs:55`，模型执行的命令读不到 token。

| # | 动作 | 依据 | 阶段 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `scheduling_ready` 由 DB 可用、调度循环、恢复扫描完成等实际计算 | 学习 1 + 代码现状 | P7 | 待办 |
| 2 | worker 支持 `token_file`，重连时重读（不杀在途 job） | 学习 3（已由一手核实） | P7 | 待办 |
| 3 | `worker debug [--json]`：token、TLS/CA、数据目录锁、账本完整性、磁盘预算、workspace 路径 | 学习 2 | P7 | 待办 |
| 4 | architecture.md 增加数据外流表与中心数据敏感级别 | 学习 4、避免 2 | P7 | 已完成：见 [architecture.md 12.1 数据外流边界](../architecture.md#121-数据外流边界) |
| 5 | needs_attention / 长时间等待醒目展示与通知 | 学习 8 | P6 | 待办 |
| 6 | 重试流回退协议用于“中断草稿可识别” | 学习 6 | P6 | 待办 |
| 7 | 注册时上报环境指纹（OS/arch、关键工具版本、git 状态）并注入 prompt | 学习 9（[推断] 落法为我们设计） | P5/P6 | 待议 |
| 8 | 文档参数默认值由代码生成或 CI 校验 | 避免 4 | P7 | 待议 |
| 9 | 若将来暴露 worker 管理端点，默认绑定 127.0.0.1 | 原依据为逆向笔记（未核实）；Cursor 文档未给默认绑定。作为我们自身安全原则保留 | 未来 | 原则 |

旧稿的“长会话依赖不可刷新 token”不再作为单独动作依据，已并入动作 2。

### 不在 MVP 内、记录备查

- Pool 路由（按标签认领、会话独占）：复用 epoch/fence/对账，不引入独立 lease 服务。
- 单次使用/空闲退出、claim-then-spawn controller：需先解决账本随容器消失时的对账。
- 单机多槽：按 workspace/worktree 分槽，FIFO 与预算按槽计算。
- 大产物（截图/录像/大日志）以引用传递，并入分块输出与补读设计。
- 子 agent 比父任务活得更久：旧稿称是 Cursor 的取舍，所查一手页面**未找到**此说法，标为未核实；P5 验收 9 要求父取消传播，这是我们的设计，不依赖此对比。
