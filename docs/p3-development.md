# P3 去重、对账与重启恢复

日期：2026-10-08。P3 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p3去重对账与重启恢复)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P3-A | 协议账本帧、Rust worker 账本（下界/tombstone）、执行与连接分离、断线重连 | 已完成（PR #9） |
| P3-B | 主节点按账本对账、在途调用跨断线保留、主节点重启从 SQLite checkpoint 恢复 | 已完成（PR #10） |
| P3-C | 可控故障程序（四个 SIGKILL 窗口、帧丢失、主节点三个重启点）与全量验收记录 | 本文记录 |

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

## P3-C 故障程序与验收

### 故障程序

所有场景都用真实进程和真实副作用判定：bash 命令向 workspace 的 `marker.log` 追加唯一标记，按行数计副作用次数；同时核对主节点 SQLite（`runtime_calls`、`jobs`、`workers`、`worker_slots`、`attention_actions`）、进程退出信号和代理记录的帧。

| 文件 | 内容 |
|---|---|
| `apps/server/test/p3-faults.test.ts` | 进程内主节点 + TLS 代理 + 真实 Rust worker：四个 worker SIGKILL 窗口、四种帧丢失、ledger 丢失 |
| `apps/server/test/p3-main-process.test.ts` | 主节点作为独立进程（`src/main.ts`）：三个提交点 SIGKILL 后重启、第二实例被拒绝 |
| `apps/server/test/p3-races.test.ts` | 脚本化 worker 直连进程内主节点，精确控制帧顺序：新旧连接竞争、等待期限、workspace 版本变化 |
| `apps/server/test/support/main-node.ts` | 每个场景独立目录的进程内主节点 |
| `apps/server/test/support/main-process.ts` | 启动、等待健康、拒绝启动的主节点子进程，管理员客户端 |
| `apps/server/test/support/worker-harness.ts` | 新增 `buildFaultWorker()`（`--features fault-injection`，输出到 `worker/target/fault`，不覆盖默认 debug 二进制）；`startTlsProxy` 新增 `drop` 规则和 `frames` 记录 |

主节点故障点：`apps/server/src/fault.ts` 的 `mainFault()` 在 `WP_MAIN_FAULT` 指定的位置向自身发 SIGKILL，只在脚本化模型模式（`P2_FAKE_MODEL=1` 或设置了 `P3_FAKE_SCRIPT_FILE`）下生效，真实部署不会触发。

| 故障点 | 位置 | 崩溃时的数据库状态 |
|---|---|---|
| `before_dispatch` | 工具轮次与调用意图提交之后（`commitTurn`） | call `committed`，未发送 |
| `after_dispatch` | 收到 worker 的 `tool_accepted` 时 | call `dispatched`，worker 已在执行 |
| `after_result_commit` | 结果、工具消息提交之后，发送 `tool_ack` 之前 | call `completed`，worker 未收到 ACK |

为独立进程运行新增的入口配置：`PORT`（默认 3000）、`P3_FAKE_SCRIPT_FILE`（按用户消息给出脚本化模型轮次的 JSON）。`createApp` 新增 `toolResultTimeoutMs`（默认 1800 s）和 `waitSweepMs`（默认 60 s），只为在测试里缩短等待期限。

### workspace 配置版本变化

会话创建时绑定 workspace 的 `config_version` 和路径。P3-C 补齐了版本变化后的处理：

- 有 job 占用执行槽时，worker 以不同的 workspace 映射注册会被拒绝（P2 已有），在途 job 不改绑。
- worker 以新映射注册后，绑定旧版本的会话里排队的 job 在调度时直接 failed，并在 `events` 记录 `workspace_version_changed`，不会派发到新目录。
- 旧版本会话再提交消息返回 409 `workspace_version_changed`，需要新建会话。

### 观察到的行为

- **重复帧**：结果或 ACK 随连接丢失后，重连时 worker 在 `worker_ready` 之后主动重发未确认的结果，主节点同时重发等待中的调用，worker 再返回一次缓存结果。主节点因此可能收到两次相同结果、发出两次 ACK。重复结果只重新 ACK，副作用和工具消息都只有一次，终态不倒退。
- **主节点 SIGKILL 后的锁**：`main.lock` 不会自动过期，重启会以 `EEXIST` 失败，需要运维确认旧进程已退出后删除该目录。测试按此操作。
- **worker 丢失 SIGINT（已修复）**：CI 中 `p3-recovery` 在 ubuntu 上偶发卡满 120 s，P3-B 分支上已出现过。原因是 worker 每轮会话循环新建 `ctrl_c()` 监听，信号在处理帧、分块传输或握手期间到达时没有监听者，直接丢失，worker 不退出。现在进程启动时注册一次 SIGINT 监听并保存信号，会话在任何等待点都会被取消。`worker-ledger.test.ts` 用停在分块传输中的 worker 复现：修复前 SIGINT 后不退出，修复后立即以 0 退出。测试工具的 `stopWorker` 增加 10 s 上限，信号被忽略时报错而不是挂住。
- **ledger 丢失**：worker 用新 ledger_id 注册时被置为 blocked，对账以 `reconcile_blocked` 被拒，worker 按退避持续重连但始终不能对账。主节点保留原 ledger_id，在途调用不重发也不判定为未执行，执行槽保留。人工处置属于 P4。

### 总验收

验收环境：macOS arm64，Node 22.22.3，Rust 1.93.1，本机临时 CA，worker 与主节点均在本机。未在 venus-local 远端复验。命令：`cargo build --locked --manifest-path worker/Cargo.toml` 后执行 `PATH=/opt/homebrew/bin:$PATH pnpm test`（server 39 项、protocol 3 项全部通过）；`cargo test --locked`（含 `--features fault-injection`）12 项通过。job ID 为下面这次运行的记录，测试每次运行通过 `t.diagnostic` 输出新的 job ID。

**故障程序：worker 四个崩溃窗口**（`p3-faults.test.ts`，call `crash-1` / `done-1`）

| 窗口 | 预期 | 实际 | job |
|---|---|---|---|
| `after_accepted` | unknown、needs_attention、worker blocked，无标记 | 进程以 SIGKILL 退出；重启后 call unknown，job needs_attention，blocked=1，执行槽保留，marker 0 行；后续 job 保持 waiting_worker、无调用 | `fb1e2768-ea42-4f1f-8ad4-d726b4479e5f` |
| `after_running` | 同上 | 同上，marker 0 行 | `66de44d1-d76e-487f-aa75-9bc88ae81895` |
| `after_effect` | 同上，marker 不出现第二行 | 同上，marker 1 行 | `e7b33bf6-0169-4143-bb5f-61151271b176` |
| `after_result_persisted` | 返回原结果，job succeeded，marker 1 行 | 崩溃时 call 仍为 dispatched；重启后缓存结果提交，job succeeded，未阻塞，工具消息 1 条，后续 job 正常执行 | `4dcd4168-4a07-4654-9819-90e4386fc6ef` |

**P3 验收表**

| 故障或竞争 | 必须观察到的结果 | 实际 | 证据 |
|---|---|---|---|
| tool_call 丢失 | 重连查询账本，已经接受的调用不重启 | 代理丢弃 `tool_call` 并断线；重连后按原 call_id 重发一次，marker 1 行 | `p3-faults` job `5bfef38e-4709-437b-a188-b230dd681ca3`，call `lose-1` |
| accepted ACK 丢失 | 同上 | 丢弃 `tool_accepted` 并断线；重连后 worker 返回缓存结果，不重新执行，marker 1 行 | `p3-faults` job `50996f9e-64fb-431f-8c2d-0327db4dc48f`；`worker-ledger.test.ts` |
| 命令完成、tool_result 丢失 | 缓存结果重传，副作用只发生一次 | 丢弃 `tool_result` 并断线；重连后结果重传并提交，marker 1 行，工具消息 1 条 | `p3-faults` job `124c0617-b1c9-45b3-a345-6d1575a9027c` |
| 主节点结果提交、result_ack 丢失 | 工具消息不重复，ACK 可以重发 | 丢弃 `tool_ack` 并断线；对账后重发 ACK，工具消息 1 条；主节点在 `after_result_commit` 被 SIGKILL 的情况同样在重启后重发 ACK | `p3-faults` job `6c2430b4-5002-4dd2-8133-055cd8e98fd1`；`p3-main-process` job `992edec1-afb0-4531-ad34-0fb9624b5817` |
| 相同 call_id 不同参数 | 返回冲突，无额外执行 | `tool_rejected` reason `conflict`，marker 不增加 | `worker-ledger.test.ts`（P3-A） |
| 清理详细结果后收到旧调用 | 下界/tombstone 拒绝执行 | `tool_rejected` reason `retired` | `worker-ledger.test.ts`（P3-A） |
| worker 未重启、网络断开 | 命令继续，主节点保留槽且不派发下一工具 | 断线期间命令完成，新连接上提交，marker 1 行 | `p3-recovery.test.ts`（P3-B） |
| accepted/running 与进程启动窗口崩溃 | 无法证明执行情况时 needs_attention，不重跑 | 见四个崩溃窗口 | `p3-faults` |
| worker 完成结果落库后重启 | 返回原结果，不要求再次执行 | 见 `after_result_persisted` | `p3-faults` |
| ledger 丢失或 ledger_id 改变 | worker 阻塞，不以记录不存在证明未执行 | 删除 worker 数据目录后重启：blocked=1，对账不通过，在途 call 未完成也未重发，marker 1 行，执行槽保留，后续 job waiting_worker | `p3-faults` call `lost-1` |
| 主节点派发前、后、结果落库后重启 | 从原请求/checkpoint 恢复，不重复生成或执行 | 独立进程在三个提交点被 SIGKILL，删除锁后重启：job succeeded，`runtime_turns` 1 条，工具消息 1 条，最终回答 1 条，marker 1 行，执行槽释放 | `p3-main-process` job `6cea0369-bc19-4ba6-b1d3-b344d21d3dc5`（before_dispatch）、`8004ffee-3adc-45a9-8ccd-e8797fb3ca3d`（after_dispatch）、`992edec1-afb0-4531-ad34-0fb9624b5817`（after_result_commit） |
| 新旧连接竞争 | 旧连接不接收新调用；已接受调用仍需对账 | 新连接注册后，旧连接晚到的结果未提交（call 仍 dispatched）、旧连接以 1008 关闭且没有收到新调用；新连接对账后按原 request_hash 重发，提交的是新连接的结果 | `p3-races` job `fc7a06ca-14ea-439b-9bee-1185e4a63655`，call `race-1` |
| workspace 配置版本变化 | 在途 job 不改绑；后续任务不静默切换目录 | 在途调用期间版本 3 注册被拒，job 以版本 2 完成；绑定版本 1 的排队 job failed 且无调用，旧会话新消息 409 | `p3-races` 版本 1 job `903bd7a3-7a7a-47a3-8abf-502c2ea8c58e`，版本 2 job `c4c20853-5254-4837-a1a1-e4856979c735` |

**补充验收**

| 项 | 实际 | 证据 |
|---|---|---|
| 重复帧不使终态倒退 | 帧丢失场景中重复的结果和 ACK 只重新 ACK；`execution.test.ts` 覆盖相同结果只 ACK、矛盾结果阻塞 | `p3-faults`、`execution.test.ts` |
| 过期推理不提交结果 | 代次落后的工具轮次和最终回答都不提交，job 状态不变 | `execution.test.ts` “superseded run” |
| 对账未完成不可派发 | 未对账的连接不收调用；新旧连接竞争中重发只发生在新连接对账之后 | `execution.test.ts`、`p3-races` |
| 等待期限不释放状态不明的执行槽 | 工具结果超时后 call unknown、job needs_attention、blocked；排队 job 等待期满 failed 且无调用；执行槽一直由 unknown job 占用；晚到结果记为 `result_for_unknown_call`，不倒退 | `p3-races` job `67f21764-8787-4525-aba9-96e121cfc8bc`，过期 job `5869d322-7905-48e8-9945-2739503b3b3f` |
| 主节点第二实例启动被拒绝 | 第二个进程以 `EEXIST` 非零退出，第一个继续提供服务，锁仍指向第一个进程；正常退出后锁释放，可再次启动 | `p3-main-process` |

未接受或明确拒绝的调用没有产生标记（`after_accepted`、`after_running` 为 0 行，阻塞后的后续 job 为 0 行），已执行的调用没有因恢复产生第二个标记。

