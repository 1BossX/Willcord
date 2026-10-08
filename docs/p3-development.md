# P3 去重、对账与重启恢复

日期：2026-10-08。P3 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p3去重对账与重启恢复)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P3-A | 协议账本帧、Rust worker 账本（下界/tombstone）、执行与连接分离、断线重连 | 已完成（PR #9） |
| P3-B | 主节点按账本对账、在途调用跨断线保留、主节点重启从 SQLite checkpoint 恢复 | 本文记录 |
| P3-C | 可控故障程序（四个 SIGKILL 窗口、帧丢失、主节点三个重启点）与全量验收记录 | 未开始 |

P3 阶段整体验收以 P3-C 的故障程序记录为准；P3-A/P3-B 的测试证明各自机制，不替代四个崩溃窗口的逐项验收。

## P3-A 协议与 Worker 账本

### 协议变更

- `reconcile.calls`：worker 上报全部未经主节点确认的账本条目（accepted/running/completed/unknown，含 call_seq、request_hash、boot_id），最多 128 条，超过即拒绝对账。`call_seq=0` 表示从 P2 账本迁移、无法证明序号的旧记录。
- `tool_accepted`：accepted 落库后上报，带 boot_id。同一 boot 重复收到在途调用时重发该帧，不重新执行。
- `tool_rejected`：账本无法证明可以执行时拒绝，原因为 `conflict`、`unknown`、`retired`、`busy`。主节点收到后将调用标为 unknown、job 标为 needs_attention、worker 置 blocked，不重发。
- `tool_ack.ack_through`：主节点已提交结果的最高 call_seq。worker 据此提高该 job 的确认下界，并把下界内的 completed 记录标为 acked。

### Worker 账本（`worker/src/ledger.rs`）

执行顺序：校验 → accepted 落库 → running 落库 → 启动执行 → 上报 `tool_accepted` → 结果落库 → 发送结果 → 收到 `tool_ack` 后提高下界。执行启动后才上报 accepted：上报丢失只会导致主节点重发，同一 boot 收到重发时返回 InProgress，执行不会因此被遗漏。每个连接只发送一次同一调用的结果，对账后的扫描与完成通知不会重复发送。

| 情况 | 账本判定 |
|---|---|
| 同 call_id、同 hash，已完成 | 返回缓存结果，不再执行 |
| 同 call_id 或同 job/call_seq，请求不同 | conflict |
| 已清理的调用（tombstone）再次出现 | retired；身份不同则 conflict |
| call_seq 不高于已确认下界、账本无记录 | retired |
| 当前 boot 正在执行 | 重发 accepted，继续观察 |
| 上一个 boot 的 accepted/running | 启动时标为 unknown，阻塞整台 worker |
| 存在 unknown 或其他在途调用 | 拒绝新调用（unknown/busy） |

已确认结果按 `result_retention_secs`（默认 7 天）清理，清理时保留 tombstone，以拒绝旧帧复活执行。P2 账本自动迁移：acked 记录保留，其余一律 unknown 并保留原结果作为核对依据。

### 运行时

工具在独立任务中执行，结果先落库再通知连接层，连接断开不影响在途命令。网络类错误按 1→30 秒退避重连。重连后先上报账本，主节点确认对账后再重发已完成但未确认的结果。worker 每 10 秒发心跳和 Ping，30 秒收不到任何入站消息即判定连接失效。

以下错误不重连，进程直接退出，需要人工处理：

- 证书校验失败
- token 被拒（HTTP 4xx）
- 超大帧、非法帧、旧代次帧
- ACK 身份不符

`fault-injection` cargo feature 提供 P3-C 使用的崩溃点（`WP_FAULT=after_accepted|after_running|after_effect|after_result_persisted`）。默认构建和发布构建不包含这些崩溃点。

### 验证

`apps/server/test/worker-ledger.test.ts` 启动真实 Rust worker，由脚本化主节点驱动，用 `marker.log` 中的唯一行判定副作用次数：

| 场景 | 结果 |
|---|---|
| 结果送达、ACK 随连接丢失 | 重连后 boot 不变，账本报告 completed，结果重发一次，marker 1 行 |
| 确认后重复 tool_call | 返回缓存结果，不再执行 |
| 同 call_id 改参数 / 新 call_id 复用 call_seq | conflict，未执行 |
| 命令运行中断网 | 命令继续，新连接报告同 boot 的在途调用，结果在新连接送达，marker 1 行 |
| 副作用发生后、结果落库前 SIGKILL | 重启后 boot 变化、ledger_id 不变，调用报告为 unknown；重发与新调用均被拒绝，marker 1 行 |
| 结果清理后旧帧到达 | tombstone 拒绝（retired），marker 1 行 |

另有 Rust 单元测试覆盖账本判定表与 P2 账本迁移，`apps/server/test/execution.test.ts` 覆盖 `ack_through` 与 `tool_rejected` 后阻塞而不重发。

本地环境：macOS arm64、Node 22.22.3、Rust 1.93.1。`pnpm test` 的 TLS 用例需要 OpenSSL 3：OpenSSL 1.1.1 签发的测试证书会被 rustls 判为 `UnknownIssuer`。可以把 OpenSSL 3 放在 PATH 前面再运行，例如 `PATH=/opt/homebrew/bin:$PATH pnpm test`。

## P3-B 主节点对账与重启恢复

### 在途调用

`ExecutionCoordinator.dispatch(job_id, call_id)` 只执行已提交的工具意图：

- 请求从 `runtime_calls` 重建，并核对提交时的 request hash。
- 调用的状态以 SQLite 为准，内存中的 pending 只负责唤醒等待方。
- worker 断线时调用继续等待，不报 `worker_offline`，job 保持 running，执行槽不释放，也不派发下一个工具。
- worker 重连并完成对账后，原请求按同一 call_id、同一内容重发，由 worker 账本原子地决定执行、返回缓存结果还是拒绝。
- 只有已对账、未阻塞、代次一致的连接才会收到调用。
- 超过 1800 秒没有结果时，调用标为 unknown，job 标为 needs_attention，worker 置 blocked。

结果的处理：

- 结果提交后才发送 `tool_ack`，ACK 发到当前连接。
- 重复的相同结果只重发 ACK，不重复写入消息。
- 同一调用收到不同结果，或收到未提交、unknown 调用的结果，都视为矛盾，阻塞 worker 并写入 `attention_actions`。

### 对账判定

worker 上报 `reconcile.calls` 后，主节点逐条核对，判定只决定是否阻塞，不会在这一步启动执行：

| 上报 | 主节点记录 | 动作 |
|---|---|---|
| completed | completed | 记为 ACK 丢失，worker 就绪后重发 ACK |
| completed | dispatched | 等待 worker 重发结果后提交 |
| accepted/running，boot 不变 | dispatched | 继续观察，执行槽保留 |
| unknown，或 P2 迁移记录（`call_seq=0`） | 任意 | 调用标为 unknown，job 标为 needs_attention，worker 置 blocked |
| boot 已变化的在途调用，或 hash/call_seq 不符 | 任意 | 阻塞 |
| 账本中有、主节点没有 | 无，或仅 committed | 阻塞 |
| 账本中没有 | dispatched | 由重发的原请求交给 worker 判定 |
| 执行槽指向不存在的 job | — | 阻塞，执行槽保留 |

出现矛盾时仍确认对账，连接保持在线并显示 blocked，worker 不再循环重连。worker 被阻塞后不接收新调用，新 job 保持 waiting_worker。解除阻塞属于 P4 的人工处置。

### 执行与恢复

job 首次执行和崩溃后恢复走同一条路径。用户消息先写入 `runtime_history`，然后按以下步骤执行：

1. 按 call_seq 顺序补完未完成的已提交意图（committed 或 dispatched），沿用原 call_id。
2. 从 SQLite 重建 Pi transcript：用户消息、已提交的 assistant 轮次，以及由结果生成的 toolResult。实时执行和恢复都通过 `toolOutput()` 生成同一种内容，部分写入的 Pi 会话文件不作为依据。
3. 调用 `continue()` 继续推理。

最终回答、`runtime_history` 和 job 的 succeeded 状态在同一事务中提交。因此恢复时：

- 已结束的 job 不会再向模型请求一次；
- 已提交的工具轮次不会重新生成；
- 只有未提交的推理会重试。

`runtime_generation` 在每次执行时递增。轮次提交、最终提交和工具派发都会校验代次和 running 状态，过期的推理不会提交任何内容。

执行槽的处理：

- 主节点重启后不主动恢复任何状态。worker 对账就绪后，调度器发现执行槽被 running 状态的 job 占用、而本进程并没有在运行它，就从 checkpoint 恢复执行。
- 只有 job 已终态并且没有 dispatched 或 unknown 调用时才释放执行槽。
- 执行异常退出时，如果还有未决调用，job 标为 needs_attention 并阻塞 worker；否则标为 failed。
- 模型返回 error 或 aborted 的轮次不当作最终回答。

Migration `004_p3_recovery.sql` 给 `runtime_calls` 增加 `completed_at`，用于生成稳定的 toolResult 时间戳。

### 验证

`apps/server/test/p3-recovery.test.ts` 使用以下环境：

- 真实主节点（Fastify、SQLite 文件）
- 前置 TLS 代理
- 真实 Rust worker
- Pi SDK 加脚本化模型

用 `marker.log` 判定副作用次数：

| 场景 | 结果 |
|---|---|
| 命令运行中断网 | job 在新连接上 succeeded，marker 1 行，未阻塞，执行槽释放 |
| 派发后主节点重启（关闭 app、重开 SQLite 和 app） | 从 checkpoint 恢复，命令只执行一次，工具轮次未重新生成，最终回答 1 条 |
| 意图已提交、主节点在派发前退出 | 恢复后按原 call_id 派发一次，工具轮次未重新生成，job succeeded |
| 副作用发生后 SIGKILL worker | worker 上报 unknown，job 标为 needs_attention，worker 置 blocked，执行槽保留；后续 job 保持 waiting_worker，没有新调用 |

`apps/server/test/execution.test.ts` 覆盖：

- 断线等待与原样重发；
- 未对账的连接不收调用；
- 重复结果只 ACK；
- 矛盾结果阻塞；
- 对账判定表的每一行；
- 执行异常退出时有未决调用则保留执行槽。

主节点在精确提交点被 SIGKILL 的情况由 P3-C 的独立进程故障程序验证。
