# P5 Main Agent 与持久化委派

日期：2026-10-09。P5 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p5main-agent-与持久化委派)，设计依据见 [架构 §8](architecture.md#8-main-agent-委派)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P5-A | 数据迁移、Main session、Main 工具（list_workers、get_job、delegate）、共用 FIFO 入队、前置依赖校验 | 完成 |
| P5-B | 等待集合与 `waiting_children`、依赖满足后入队、重启扫描恢复、父取消传播、根预算、结构化最终结果 | 完成 |
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

P5-A 提交时留下的缺口（依赖满足后入队、等待集合、父取消传播）已由 P5-B 补上。

## P5-B：等待、依赖推进、取消与预算

### 等待

- Main job 每轮工具执行完后，如果还有未终态的子任务，就在一个事务里把它们写进 `job_waits`，转为 `waiting_children` 并结束这次执行：不再调用模型，也不占任何执行槽。Main session 的下一条消息排在它后面。
- 等待集合是该父任务所有未终态的子任务，全部终态后父任务才回到 `running`。
- 恢复执行时，每个子任务的结构化结果以一条 `child:<job_id>` 历史消息加入父任务（`runtime_history` 唯一键保证只加一次），然后才进行下一次模型调用。
- 有未结束子任务时，父任务即使给出最终回答也不会标为 `succeeded`，而是回到等待。
- 脚本模型新增 `{calls: [...]}`：一轮里发出多个调用。同一轮委派的任务一起等待，A → B 这样的依赖应在同一轮里声明。

### `advance()`：只看数据库的推进

每次任务状态变化（执行结束、取消、放弃、等待过期等）后，以及启动时和 `waitSweepMs` 定时扫描时，都会调用 `advance()`。它只依据 SQLite 推进，所以丢失的唤醒和重启都不影响结果：

1. 给终态 job 写 `result_json`。
2. 等待依赖的 job：前置任务全部成功，才分配 `queue_seq`（排在当时 FIFO 的最后），并按 worker 状态设为 `queued` 或 `waiting_worker`；任一前置任务失败或取消，就以 `failed` + `dependency_failed` 结束，并逐级传递。前置任务是 `needs_attention` 时继续等待。
3. 父任务的子任务全部终态且已有结果，就恢复 `running`。
4. 正在取消的父任务：子任务全部终态，就收尾；剩下的未终态子任务全是 `needs_attention` 时，父任务也转为 `needs_attention`。

### 父取消

- 取消 Main job 时先标记 `cancel_requested`，再用同一原因取消所有未终态子任务：排队的直接取消，运行中的走 P4 的取消链路，`needs_attention` 的只记录请求。
- `finalizeCancel` 要等子任务全部终态才收尾。子任务执行情况不明时，父任务进入 `needs_attention`，不会宣称已经安全取消。
- 放弃 Main job 时，没有 worker 可记的操作写成 `job_abandoned` 事件。

### 根预算

- 委派 job 用父任务的 `root_job_id`，复制根任务的上限和 `deadline_at`；工具次数和 token 都累加到同一个 `budget_roots` 行。delegate 本身也算一次工具调用。
- 用新 key 再次委派不会得到新预算；委派出来的 job 也不能单独重试。
- 时限扫描同时覆盖 `waiting_children` 的父任务。

### 结构化结果

`result_json`：`{outcome, summary, evidence_call_ids, exit_code?, error, failed_call_ids, truncated, children?}`。

- `summary` 取最后一条回答，`evidence_call_ids` 是已完成的调用，`exit_code` 取最后一次 bash 的退出码，`truncated` 表示有输出流被截断。
- Main job 的结果额外列出 `children`。
- `verification` 记录验证调用的 ID、状态和退出码（见下）。

### 验证命令（`migrations/009_p5_verify.sql`）

worker 上的模型只有 read/write/bash，无法报告"失败"，正常结束就会记为成功。所以由 Main 决定子任务怎样算成功：

- `delegate` 新增可选参数 `verify`：一条 shell 命令，属于委派内容的一部分，计入幂等哈希，存在 `jobs.verify_command`。
- 子任务的第一条用户消息会附上这条命令，告诉模型结束后会怎样验证。
- 子任务的模型给出最终回答后，主节点在同一个事务里提交这条回答和一次服务端发起的 bash 调用（`verify-<job_id>`），然后在同一个 workspace 执行它。这次调用不计入工具次数预算。
- 退出码为 0 才是 `succeeded`；否则以 `failed` + `verification_failed` 结束，依赖它的步骤以 `dependency_failed` 结束。
- 提交最终回答后主节点崩溃，恢复时不会再调用模型，只把验证调用跑完：未发送的重新发送，已发送的按 P3 规则对账。
- 不带 `verify` 的子任务，以及用户自己的任务，仍以模型正常结束为成功。工具说明要求 Main 给被依赖的步骤带上 `verify`，并把有依赖的步骤放在同一轮委派。

### 验证

`apps/server/test/p5-wait.test.ts`，真实 Rust worker 加脚本模型：

| 场景 | 结果 |
|---|---|
| A 测试成功 → B 写说明 | 父任务 `waiting_children`，不占执行槽，等待期间模型轮次不增加；A 的验证命令退出码为 0，证据里包括 `verify-<job_id>`，A 的提示附有这条命令；B 在 A 结束前没有 `queue_seq`；执行顺序 test-start、test-end、doc；子任务和父任务都有结构化结果；两条子任务结果各进入父任务历史一次 |
| A 自己的命令成功并报告完成，但验证命令 `exit 3` 失败；A 运行中被取消 | A 为 `failed`/`verification_failed`，`exit_code=3`；两种情况下 B 都是 `failed`/`dependency_failed`，doc 为 0，被取消的命令没有后续副作用 |
| 父任务等待期间取消 | 立即返回 `cancel_requested`，子命令确认终止后父子都变为 `cancelled`；doc 和 late 都为 0；worker 随后能正常执行用户任务 |
| worker 离线时委派，主节点重启，再启动 worker | 父任务从数据库恢复；子任务只执行一次；只有一个子 job 和一个 delegate 调用 |
| 直接改库让子任务结束（模拟丢失的唤醒） | 定时扫描让父任务恢复并完成，结果里子任务为 `cancelled` |
| 工具次数上限 3：委派 c1、c2、c3 | c1 执行；c2 的命令超过共享上限，以 `budget_tool_calls` 结束；父任务随后同样结束，c3 没有创建；只有一个 `budget_roots` 行，计数为 5 |

`p5-delegate.test.ts` 的依赖场景同时验证了：A 成功后，B 排在 A 运行期间提交的用户任务之后。
