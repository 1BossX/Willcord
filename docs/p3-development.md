# P3 去重、对账与重启恢复

日期：2026-10-08。P3 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p3去重对账与重启恢复)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P3-A | 协议账本帧、Rust worker 账本（下界/tombstone）、执行与连接分离、断线重连 | 本文记录 |
| P3-B | 主节点按账本对账、在途调用跨断线保留、主节点重启从 SQLite checkpoint 恢复 | 未开始 |
| P3-C | 可控故障程序（四个 SIGKILL 窗口、帧丢失、主节点三个重启点）与全量验收记录 | 未开始 |

P3-B 完成前，主节点对 worker 上报的账本仅保持 P2 行为：有活动执行槽时拒绝对账，因此 P3 阶段整体验收以 P3-C 记录为准。

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
