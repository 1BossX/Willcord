# P5 Main Agent 与持久化委派

日期：2026-10-09。P5 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p5main-agent-与持久化委派)，设计依据见 [架构 §8](architecture.md#8-main-agent-委派)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P5-A | 数据迁移、Main session、Main 工具（list_workers、get_job、delegate）、共用 FIFO 入队、前置依赖校验 | 完成 |
| P5-B | 等待集合与 `waiting_children`、依赖满足后入队、重启扫描恢复、父取消传播、根预算、结构化最终结果 | 未开始 |
| P5-C | Main 入口 UI、双 worker 测试工具、故障程序与全量验收记录 | 未开始 |

已定决策：

- 只有一个 Main session，置顶显示。
- 等待集合要等全部子任务终态，父任务才恢复。
- 双机验收用本机两个真实 Rust worker 进程（各自的身份、token、数据目录）；真实双机联调放到 P7。

P5 阶段整体验收以 P5-C 的记录为准。

## P5-A：数据与 Main 工具

### 数据（`migrations/008_p5_delegation.sql`）

- sessions 新增 `parent_job_id`、`delegation_id`：子 session 属于创建它的委派，不会成为用户默认会话。
- jobs 新增 `result_json`，存结构化最终结果（P5-B 填写）。
- 新表 `job_waits(parent_job_id, child_job_id, call_id)`：持久化的等待集合（P5-B 使用）。
- 索引 `jobs(parent_job_id)`、`job_dependencies(depends_on_job_id)`。
- P1/P4 预留的 `kind='main'`、`waiting_children`、`UNIQUE(parent_job_id, delegation_id)`、`job_dependencies`、`root_job_id`、`budget_roots` 开始使用。

### 入队（`apps/server/src/jobs.ts`）

用户消息、重试和委派都走同一个 `createJob`：

- worker job 按 `MAX(queue_seq)+1` 进入该 worker 的 FIFO。前置依赖未全部成功的委派 job 不分配 `queue_seq`（状态 `queued`、没有等待期限），`pump` 只选有 `queue_seq` 的 job，所以它不占队列位置，也不挡住后面的任务。
- 没有父任务的 job 自成预算根。委派 job 用父任务的 `root_job_id`，并继承根任务的上限和 `deadline_at`。
- 委派出来的 job 不能用"重试"另起：重试会新建预算根，绕过根预算（`delegated_job_retry_not_allowed`）。

### Main session

- `GET /api/main` 幂等创建并返回唯一的 `kind='main'` session。消息仍用 `POST /api/sessions/:id/messages`。
- Main job 没有 worker、没有 `queue_seq`，不占 worker 执行槽。`pumpMain` 按提交顺序推进：队首是 running 就继续执行，是 queued 就开始；队首处于其他非终态（等待子任务、需要核对）时，后面的消息排在它后面。
- 主节点启动后立即 `pumpMain`，Main job 不用等 worker 上线就能恢复。

### Main 工具

`runPi` 按 session 类型选角色：worker 用远程 read/write/bash，main 用三个本地工具，白名单仍由 `createPiSession` 校验。

| 工具 | 行为 |
|---|---|
| `list_workers` | 每台机器的在线、可执行（已对账且未阻塞）、阻塞、忙碌、排队数和 workspace 列表 |
| `get_job` | 只能读同一根任务下的 job：状态、结束原因、依赖、`result`、最后一条回答。其他任务一律 `job_not_found` |
| `delegate` | `{worker_id, workspace_id?, prompt, delegation_key?, depends_on?}`，见下 |

Main 工具在主节点本地执行：效果、调用结果和工具消息在同一个事务里提交（`localTool`）。重启后已提交的结果直接重放，不会再执行一次。

### delegate

在一个 `IMMEDIATE` 事务里：

1. 校验 worker 和 workspace（不传 workspace 用默认 workspace）、prompt、依赖列表（最多 16 个，不重复）。
2. 父任务就是正在执行这次调用的 job，不从参数取。delegation ID 取模型给的 `delegation_key`，没有就用 call ID。参数里的 `parent_job_id`、`delegation_id` 一律忽略。
3. 查 `(parent_job_id, delegation_id)`：已存在且内容哈希（worker、workspace、prompt、依赖）相同，返回原任务并标 `duplicate`；不同则返回 `delegation_conflict`。
4. 依赖可以写兄弟委派的 `delegation_key`，也可以写 job ID，但必须属于同一根任务，否则返回 `dependency_not_in_task`。依赖只能指向已经存在的任务，新任务不可能成环。依赖已失败或取消时返回 `dependency_failed`。
5. 新建子 session（`kind='worker'`，绑定 worker/workspace，记录父任务和 delegation ID），新建子 job，写依赖和 `job_delegated` 事件。
6. 提交后 pump 目标 worker。

子 session 和普通 worker session 一样可以单独追问，目标固定。文件不会在机器之间自动传输。

### 验证

`apps/server/test/p5-delegate.test.ts`，真实 Rust worker 加脚本模型：

| 场景 | 结果 |
|---|---|
| 同一 key 委派两次，再用同一 key 换内容，再委派不存在的 worker，参数里伪造 parent/delegation ID | 只有一个子 job；重复返回原 job；换内容返回 `delegation_conflict`；不存在的 worker 被拒绝；伪造的 ID 不出现在数据库里 |
| 子 session | `kind='worker'`，绑定 `w/repo`，记录父任务和 delegation ID；与用户 session、Main session 不同；用户 session 里没有任何消息；追问在同一 workspace 执行 |
| 用户 u1 运行中，Main 委派 b，用户再交 u2 | 执行顺序 u1 → b → u2，同一时刻只有一个；Main job 没有 `queue_seq`，不占执行槽 |
| A、B（依赖 A）；依赖不存在的 key；依赖其他任务的 job；`get_job` 读其他任务 | 前两个非法依赖都被拒为 `dependency_not_in_task`；`get_job` 返回 `job_not_found`；A 运行期间 B 没有 `queue_seq`，A 之后提交的用户任务照常先执行，B 没有运行 |

P5-A 已知缺口，由 P5-B 补上：

- 依赖满足后还不会给 B 分配队列序号。
- 父任务在子任务完成前就会结束：委派结果只是创建回执，还没有等待集合。
- 父取消还不会传播到子任务。
