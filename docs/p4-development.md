# P4 取消、预算、输出与人工处置

日期：2026-10-08。P4 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p4取消预算输出与人工处置)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P4-A | 协议帧、worker 进程组控制、超时、输出分块与补读、磁盘拒绝、账本取消栅栏与人工解除 | 本文记录 |
| P4-B | 主节点取消全链路、任务预算、人工处置接口与基础 UI | 待开发 |
| P4-C | 故障程序与全量验收记录 | 待开发 |

P4 阶段整体验收以 P4-C 的记录为准。P4-A 的测试只证明 worker 侧机制和主节点的输出处理，主节点发起取消、预算与人工处置属于 P4-B。

## P4-A Worker 进程控制与输出

### 协议变更

新增帧：

| 帧 | 方向 | 含义 |
|---|---|---|
| `cancel_call` | 主→worker | 幂等的停止请求，携带 call_seq 与 request_hash |
| `cancel_ack` | worker→主 | 只表示收到，状态见下表。停止的证明是之后的 `tool_result` |
| `tool_log` | worker→主 | 一个已落盘的输出分块，base64，原始数据至多 16 KiB。每个流从 seq 0 编号，带字节 offset |
| `log_fetch` | 主→worker | 从 `from_seq` 起补读一个流 |
| `log_status` | worker→主 | 结束一次补读：`complete`、`more`（单次至多 64 块）、`running` 或 `expired`，并给出该流已存块数 |
| `log_ack` | 主→worker | 主节点已持有它要保留的全部分块。与 `tool_ack` 相互独立 |
| `resolve_call` | 主→worker | 人工核对后结清一个 unknown 调用 |
| `resolve_ack` | worker→主 | `resolved` 或 `not_unknown` |

`cancel_ack.state` 的含义：

| 状态 | 含义 |
|---|---|
| `running` | 本次启动正在执行，已记录取消并开始终止 |
| `completed` | 已有结果（包括已清理只剩 tombstone 的调用） |
| `fenced` | 账本从未接受该调用。同一事务写入取消 tombstone，之后同一调用以 `cancelled` 拒绝，这是"未执行"的权威证明 |
| `unknown` | 上一次启动留下的调用，或已人工结清的调用；本进程无法停止它 |
| `conflict` | 身份与账本记录不符 |

`tool_rejected.reason` 增加：

| 原因 | 含义 |
|---|---|
| `disk_full` | 剩余空间或输出预算不足，账本未记录，调用未执行 |
| `invalid` | 请求不会被执行，目前用于超出范围的 `timeout_secs` |
| `cancelled` | 命中取消栅栏 |

bash 的 `arguments.timeout_secs` 为 1..1800 的整数，默认 600。它属于请求内容，计入 request hash。worker 以本地上限 `max_tool_timeout_secs`（不超过 1800）校验，超出时拒绝为 `invalid`，不静默截短。

### bash 执行（`worker/src/process.rs`）

- 每条命令用 `process_group(0)` 启动在独立进程组中。env、stdin、无 PTY 与 P2 相同。
- 超时或取消时：
  1. 向进程组发 TERM；
  2. 宽限 `kill_grace_secs`（默认 10 秒，上限 30 秒），期间进程组为空即结束；
  3. 发 KILL；
  4. 回收 bash，并用 `killpg(pgid, 0)` 确认进程组为空，最多等 5 秒。
- bash 在 TERM 之前不回收，所以进程组 ID 不会在发信号时被无关进程复用。
- 命令正常退出后，进程组里如果还有遗留成员，按同一流程终止，结果记 `leftover_terminated: true`。
- 进程组在期限内确认为空，结果记 `termination` 为 `cancelled` 或 `timeout`，并带真实的退出码或信号。
- 无法确认为空时：
  - 账本把调用标为 unknown，结果字段保存证据（含进程组 ID），worker 阻塞；
  - worker 以 `tool_rejected(unknown)` 主动通知主节点，主节点沿用 P3 的处理：needs_attention 加 blocked。
- 进程组 ID 只作为证据，从不跨重启使用。上一次启动的在途调用仍按 P3 规则标为 unknown，不按陈旧 PID 发信号。
- 刻意用 `setsid` 等方式脱离进程组的进程不在控制范围内。如果它仍占着管道，读取在确认期限后放弃，结果记 `pipes_closed: false`。

### 输出（`worker/src/logs.rs`）

- stdout、stderr 各由独立任务持续读取，管道始终被排空。
- 每次调用的输出写入 `data_dir/logs/<sha256(call_id)>/`，每个流两个文件：
  - 数据文件；
  - 分块索引（offset、长度）。先写数据、再写索引，读取方只认索引，不会读到半块。
- 两个流合计最多保存 10 MiB。超出部分继续读出并计数，但不保存，结果中 `logs.truncated` 为 true，`bytes_total` 是真实字节数。
- 未满 16 KiB 的分块在 200 毫秒无新数据后落盘。
- 落盘后尝试实时推送 `tool_log`：
  - 推送队列有界（64 块），队列满时直接丢弃，等主节点按 seq 补读；
  - 连接未完成对账时不推送。
- bash 结果只带元数据，不带输出正文，因此结果帧始终远小于 64 KiB：
  - `exit_code`、`signal`、`termination`、`leftover_terminated`、`pipes_closed`、`duration_ms`；
  - `logs`：每流的 `bytes_total`、`bytes_logged`、`chunks`，以及 `truncated`、`error`。

### 账本（schema v2）

v1 账本原地升级：
- `calls` 增加 `cancel_requested`；
- `tombstones` 增加 `reason`，取值 `retired`、`cancelled`、`resolved`；
- 新增 `log_streams`，记录每流块数与是否已 `log_ack`。

规则：

- **完成时**：结果与各流块数在同一事务中写入。
- **磁盘检查**：只对账本从未见过的调用检查剩余空间和输出预算；重复调用仍从账本返回缓存结果。不足时拒绝为 `disk_full`，不写任何记录。
- **取消**：已接受的调用只设置标记并触发终止；未接受的调用写入取消 tombstone。
- **人工结清**：`resolve` 把 unknown 调用转为 `resolved` tombstone，删除记录和输出。被结清的调用再到达时拒绝为 `retired`，取消时返回 `unknown`，永远不会复活。
- **输出删除**：只有结果已 `tool_ack`、并且所有流都已 `log_ack`，输出才删除。`tool_ack` 不会删掉仍需补读的输出。超过 `result_retention_secs` 的结果连同输出一起清理，之后的 `log_fetch` 返回 `expired`。启动时删除没有账本记录的输出目录。

### 主节点输出处理

Migration `005_p4_logs.sql` 新增两张表：
- `call_logs`：按 (job, call, stream, seq) 去重保存分块；
- `call_log_state`：记录每流块数、真实字节数、worker 截断、主节点截断和状态（`streaming`、`complete`、`expired`）。

提交结果：

- 收到带 `logs` 的 bash 结果时，先检查每流前 64 KiB 对应的分块是否连续齐全。
  - 缺块时发送 `log_fetch` 并暂缓提交；每流同时只有一个补读在途。
  - 齐全，或 worker 回复 `expired` 后，才提交。
- 提交的结果附加 `output.stdout`、`output.stderr`，各含：
  - `text`：前 64 KiB；
  - `bytes_shown`、`bytes_total`；
  - `truncated`；
  - `gap`：前 64 KiB 本应存在却取不回。
- 模型看到的内容就是已提交的内容，实时执行与 SQLite 恢复一致。
- 重复结果的一致性比较忽略主节点附加的 `output`。

补读与容量：

- 提交后在后台补齐完整日志（每次至多 64 块），补齐后对每个流发 `log_ack`。
- 重连并完成对账后，继续补齐未完成的流。
- 主节点日志总量受 `MAIN_LOG_CAPACITY_BYTES`（默认 1 GiB）限制：
  - 超出后只保留模型视图需要的前 64 KiB；
  - 其余分块不再保存，记 `main_truncated`，照常 `log_ack`，不让 worker 无限期保留。
- `GET /api/jobs/:job_id/calls/:call_id/logs?stream=&from_seq=` 按页返回分块和上述状态。

dispatch 等待结果的期限：bash 为 `timeout_secs + 60 秒`（覆盖 TERM 宽限和停止确认），其他工具仍为 1800 秒。

UI 的 bash 卡片读取 `output`，显示真实退出码或"已取消/已超时停止"及信号，并标明截断字节数和缺口。完整日志视图属于 P4-B。

### 验证

`worker/src` 的 Rust 单元测试（23 项）覆盖：

- 账本 v2 迁移；
- 取消栅栏；
- 磁盘拒绝只针对新调用；
- resolve 后不复活；
- 日志删除条件；
- 分块读写与 10 MiB 上限；
- TERM 被忽略时宽限后 KILL，同组子进程同时被杀；
- 超时走 TERM；
- 正常退出后的遗留进程；
- 30 MiB 输出；
- `timeout_secs` 边界。

`apps/server/test/worker-process.test.ts` 使用真实 Rust worker 加脚本化主节点：

| 场景 | 结果 |
|---|---|
| 取消忽略 TERM 的命令（同组后台子进程写 pid 文件） | `cancel_ack` 为 `running`；结果在 cancel 后约 1.04 秒（宽限 1 秒）到达，`signal=9`，子进程已不存在 |
| 终止确认前发来下一调用 | 拒绝为 `busy`；结果到达后同一请求可再次发送并执行，marker 1 行 |
| 重复取消 | `cancel_ack` 为 `completed` |
| `timeout_secs=1` | `termination=timeout`，`signal=15` |
| `timeout_secs` 为 121（本地上限 120）或 1801 | 拒绝为 `invalid`，marker 0 行 |
| 30 MiB stdout | 约 1.2 秒完成；`bytes_total` 为 31457280，保存 10 MiB（640 块），按 seq 补读无缺口，内容逐字节正确 |
| 仅 `log_ack` | 输出保留 |
| 再收到 `tool_ack` | 输出删除，之后 `log_fetch` 返回 `expired` |
| 输出期间断线 | 重连对账报告 running；结果到达后补读得到完整的 5 行，块数与结果一致 |
| 对未见过的调用取消 | `fenced`（重复仍为 `fenced`）；之后的 tool_call 拒绝为 `cancelled`，marker 0 行 |
| `min_free_bytes` 超过可用空间 | 拒绝为 `disk_full`；重启后对账报告为空，marker 0 行 |
| 副作用后 SIGKILL，重启后 unknown | 新调用拒绝为 `unknown`；`resolve_call` 得到 `resolved`，重复为 `not_unknown`；原调用再到达拒绝为 `retired`；新调用正常执行；原副作用仍 1 行 |

`apps/server/test/p4-output.test.ts` 使用真实主节点、TLS 代理和真实 worker：

| 场景 | 结果 |
|---|---|
| 200000 字节 stdout，代理首次丢弃 seq<3 的实时分块 | 主节点发出 `log_fetch`，补齐前 64 KiB 后才提交 |
| 上一行的提交内容 | `output.stdout` 为 65536/200000 字节、`truncated=true`、`gap=false`；stderr 完整；工具消息与模型视图一致 |
| 上一行的后台补齐 | 完整日志（13 块，200000 字节）补齐后 `log_ack`，worker 侧输出目录删除；日志接口可按页读取 |
| 主节点容量 100000 字节 | 前 64 KiB 保留；其余部分 `main_truncated=1`，总存储不超过容量 |

其余测试全部保持通过，包括 P3 的故障与恢复测试。这些测试的 bash 结果已改为分块输出。

本地环境：macOS arm64，Node 22.22.3，Rust 1.93.1。运行方式同 P3：`PATH=/opt/homebrew/bin:$PATH pnpm test`。

## P4-B：取消、预算与人工处置

### 数据（`migrations/006_p4_control.sql`）

- jobs 新增 `cancel_reason`、`end_reason`、`root_job_id`（P4 中等于自身）、`max_tool_calls`、`max_tokens`、`max_runtime_secs`、`deadline_at`（首次 running 时写入，重启不变）。
- workers 新增 `reported_ledger_id`（注册时账本变化，仅在人工解除时采用）和 `unblock_pending`。
- 重建 `runtime_calls`（连同引用它的两张日志表）：状态增加 `not_executed`、`resolved`，并增加 `cancel_sent_at`、`resolution_json`、`resolve_acked`。P4-A 记为 `completed` + `not_executed:true` 的结果迁移为 `not_executed`。
- 新表 `job_usage`（每轮用量，与轮次同事务写入；中止的生成记 `usage_known=0`）和 `budget_roots`。

### 取消

`ExecutionCoordinator.cancel(jobId, reason)`，REST 为 `POST /api/jobs/:id/cancel`：

| 当前状态 | 处理 |
|---|---|
| 终态 / `cancel_requested` | 原样返回（幂等） |
| queued / waiting_worker | 直接 `cancelled`，没有调用 |
| running | `cancel_requested`，`runtime_generation+1`，未发送的调用记为 `not_executed`；中止 Pi 生成；已发送的调用发 `cancel_call` |
| needs_attention | 只记录请求，状态不变 |

- worker 离线时请求保留；重连对账后 `resumeWorker` 先发 `cancel_call`，已取消任务的调用不再重发。
- `cancel_ack`：`fenced` 记为 `not_executed`；`running`/`completed` 只是回执，等待真实结果；`unknown` 走 `markUnknown`。
- 没有 dispatched/unknown 调用后 `finalizeCancel`：`cancelled_by_user` 记为 `cancelled`，其余原因（预算、时限、磁盘）记为 `failed`，再释放执行槽并 pump。
- `disk_full` 拒绝：调用 `not_executed`，job 以 `failed` + `worker_disk_full` 结束，worker 不阻塞。

### 预算

默认值见 `DEFAULT_BUDGET`，可用 `MAX_JOB_TOOL_CALLS`、`MAX_JOB_TOKENS`、`MAX_JOB_RUNTIME_SECS` 覆盖。计数都来自 SQLite。

- 每次生成前检查时限、token 和已提交轮次数（`MAX_MODEL_TURNS`）。
- `commitTurn` 超过工具次数时：整轮照常提交，新调用全部 `not_executed`，以 `budget_tool_calls` 结束。
- 时限：每个 running job 一个定时器，外加 `waitSweepMs` 周期扫描；首次派发前再检查一次。到期按取消处理，在途命令先终止。

### 人工处置

| 接口 | 行为 |
|---|---|
| `GET /api/attention` | blocked 的 worker、needs_attention 的 job、unknown 和待确认的 resolved 调用、最近 200 条动作 |
| `POST /api/jobs/:id/abandon` `{note}` | 仅限 needs_attention；变为 `cancelled` + `abandoned`，不解除阻塞，不释放执行槽 |
| `POST /api/workers/:id/unblock` `{evidence, resolutions}` | 不能有 needs_attention 的 job；依据必填；必须覆盖全部 unknown 调用。调用改为 `resolved`，必要时采用新账本，向 worker 发 `resolve_call`；全部 `resolve_ack`（`resolved` 或 `not_unknown`）且连接已对账后才 `blocked=0`、释放执行槽、pump。期间出现新矛盾则作废这次解除 |
| `POST /api/jobs/:id/retry` | 仅限终态 job；新 job_id 和新 client_request_id，输入相同，附带核对副作用的提示 |

所有动作写入 `attention_actions`：`blocked`、`abandon`、`unblock`、`unblocked`、`retry`。

### UI

- 任务详情：取消按钮，以及"正在停止"状态。
- 预算用量（工具次数、token、剩余时限）和结束原因。
- 人工核对面板：unknown 调用逐个选择结果，放弃需填说明，解除需填依据。
- 新建重试。
- bash 卡片的"查看完整日志"：按流分页读取，并标明截断、容量和过期。

### 验证

`apps/server/test/execution.test.ts` 新增协调器单测：

- 运行中取消：保留真实结果，执行槽保留到结果到达，重复取消和终态取消都幂等；
- `fenced`，以及离线取消在重连后最先发出；
- queued 取消和 needs_attention 取消；
- 放弃 → 解除 → `resolve_ack` 的完整动作序列；
- 超出工具次数的一轮。

`apps/server/test/p4-control.test.ts` 使用真实 Rust worker：

| 场景 | 结果 |
|---|---|
| 命令中取消 | 下一 job 在取消的 job 结束后才运行；结果 `termination=cancelled`；`sleep` 之后的副作用没有发生 |
| 推理中取消（脚本模型延迟 1.5 秒） | 没有任何 runtime_calls，marker 为 0 |
| 离线取消（代理丢弃首个 tool_call） | 重连后发往 worker 的只有 `cancel_call`，结果为 `fenced` → `not_executed`；queued 取消没有调用 |
| 工具次数 / token / 时限 | 分别以 `budget_tool_calls`、`budget_tokens`、`deadline_exceeded` 结束；重启主节点后计数不变；时限到期时命令以 cancelled 终止 |
| 磁盘不足 | `worker_disk_full`，marker 为 0，worker 不阻塞，执行槽释放 |
| 放弃 → 解除 → 重试 | 放弃后仍 blocked，新 job 拿不到调用；解除后依据写入 `attention_actions`，排队的 job 完成；重试的 job ID 不同 |

全部测试通过；`pnpm build`、`git diff --check` 和协议生成无漂移。

浏览器走查：真实主节点、真实 worker、脚本模型。

- 命令中取消：任务先显示"正在停止"，确认后变为"已取消"，结束原因为"用户取消"。
- 完整日志查看器：取回全部 30000 行，共 828,894 字节。
- worker 被 SIGKILL：显示核对面板。放弃后机器仍阻塞；填写依据、选择结果后解除阻塞，机器回到空闲。
- 新建重试：生成新 job 并开始执行。
- 预算行显示正常。
- 走查中发现并修复两处 UI 问题：机器未阻塞时多渲染了一个"0"；长时限改为按小时显示。
