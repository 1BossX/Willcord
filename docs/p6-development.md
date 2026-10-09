# P6 UI 与完整端到端体验

日期：2026-10-09。P6 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p6ui-与完整端到端体验)，设计依据见 [架构 §4、§12](architecture.md)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P6-A | 事件流（触发器写事件）、带游标快照、SSE 补放与游标过期、模型草稿、日志缺口、委派子任务汇总 | 完成 |
| P6-B | UI 改为快照 + SSE，补齐机器状态、委派卡片、排队与取消、需要核对、日志缺口和草稿的展示 | 未开始 |
| P6-C | 故障程序、浏览器端到端走查（含网络记录）与全量验收记录 | 未开始 |

已定决策：

- Main 的 outcome 仍由模型判断。UI 在 Main 结果和委派卡片上醒目显示"N 个子任务未成功"，服务端在 job 视图里给出 `children_summary`。
- P6 走查用脚本模型和真实 Rust worker。真实模型联调（包括是否遵守"同一轮委派""带 verify"）放到 P7。

P6 阶段整体验收以 P6-C 的记录为准。

## P6-A：事件流、快照与草稿

### 数据（`migrations/010_p6_events.sql`）

- `events` 新增 `kind`、`entity_id`、`session_id`、`job_id`。旧的审计事件（`job_delegated`、`job_failed` 等）`kind` 为空，不进事件流，也不被保留策略删除。
- 事件由 SQLite 触发器写入，和状态变更在同一个事务里。任何代码路径改了状态都会留下事件，不靠各处手动调用。

| kind | 触发 | 实体 |
|---|---|---|
| `job` | jobs 新建；状态、队列序号、取消请求/原因、结束原因、结果、开始时间、期限、验证命令变化；预算用量变化（根任务下每个 job） | job。子任务变化时父任务也发一条，父任务视图里带子任务列表。队列移动时，同一 worker 上仍在排队的 job 各发一条 |
| `message` | messages 新建 | message |
| `session` | sessions 新建、改标题 | session |
| `worker` | online、reconciled、blocked、unblock_pending、连接 epoch、报告的账本变化；执行槽变化；该 worker 的队列变化。心跳（`last_seen`）不发 | worker |
| `call` | runtime_calls 新建；状态、取消发送时间、resolve 确认变化 | call |
| `log` | `call_log_state` 新建或变化、收到一个日志分块 | `call_id/stream`，只带计数和缺口，不带日志内容 |
| `draft` | 草稿新建或更新 | draft |
| `attention` | attention_actions 新建 | action |

- 事件行只记"什么变了"。发送时按实体读当前状态，所以重放或重复都是幂等的，UI 按实体 ID 覆盖即可。
- 新表 `event_floor` 记录保留策略删到的最大 event_id。新表 `model_drafts` 见下文。

### 快照与 SSE（`apps/server/src/feed.ts`）

- `GET /api/snapshot?session_id=`：在同一次读取里返回 `cursor`、`main_session_id`、全部 worker（带 `schedulable`、`queued_jobs`、`active_job_id`）和全部 session。带 `session_id` 时还返回该会话的消息、job、调用、日志状态和未提交的草稿。session 不存在时返回 404。
- `GET /api/events?after=<cursor>`（也接受 `Last-Event-ID`）：`text/event-stream`，`id:` 就是 event_id。
  - 先补放 `after` 之后的事件，再推送新事件。同一批次里一个实体变了多次只发一次（取最后一次的 event_id 和当前状态）。批次末尾如果被合并掉的事件 ID 更大，补一条 `event: cursor`，让浏览器的 `Last-Event-ID` 前进到批次末尾。
  - 新事件由一个 100 ms 的轮询发现（只查 `MAX(event_id)`，没有订阅者时不查），所以不依赖代码在提交后手动通知。
  - 每 15 s 发一次心跳注释。
- 游标过期：保留最近 10 万条、且不超过 7 天的事件，启动时和每小时清理一次。`after` 小于 `event_floor`，或大于当前最大 ID（不是这个数据库发出的游标），返回 `event: reset`（`cursor_expired`）并关闭连接，UI 需要重取快照。快照的 cursor 不会小于 floor，所以重取后的游标总能用。
- 认证：两个接口都要登录 cookie，未登录返回 401。打开的流在每次推送和心跳前重新检查登录，退出登录或会话过期后，下一次推送时关闭，不再发出任何事件。
- 日志接口和快照里的日志状态新增 `gaps`：worker 记录了、主节点却没有的分块区间（`from_seq`、`to_seq`、`from_offset`、`missing_bytes`）。只有在不会再收到分块时（`complete` 或 `expired`）才把尾部缺失算作缺口。主节点容量满后丢弃的部分算截断（`main_truncated`），不算缺口。
- `/api/workers` 和 `/api/sessions/:id/jobs` 改用同一套视图：worker 多了 `schedulable`、`queued_jobs`，job 多了 `session_id`、`verify_command`、`children`（委派 ID、目标、状态、结束原因、结构化结果）和 `children_summary`（总数、成功、失败或取消、需要核对、未结束）。

### 模型草稿

- `runPi` 订阅 Pi 的 `message_update`：生成开始时建一条 `streaming` 草稿，之后最多每 250 ms 写一次当前文本。
- 草稿和它所属的轮次在同一个事务里变为 `committed`，文本清空。工具轮次是 `commitTurn`，最终回答是 `commitFinal`。正式消息只出现一次，快照不再返回已提交的草稿。
- 生成被中止或出错、job 执行结束时还在 `streaming` 的草稿，标为 `interrupted`，保留已生成的文本。主节点崩溃留下的 `streaming` 草稿在下次启动时标为 `interrupted`。
- 脚本模型的步骤可以带 `tokens_per_second`，让文本慢慢流出，测试和走查可以在提交前看到或打断它。

### 验证

`apps/server/test/p6-events.test.ts`，真实 Rust worker 加脚本模型。SSE 通过真实 HTTP 读取（`test/support/sse.ts`），按 UI 的方式合并：每个 event_id 只处理一次，按实体保留最新状态。

| 场景 | 结果 |
|---|---|
| 取快照后订阅，执行一个 bash 任务，中途断开，再用 `Last-Event-ID` 从中间重连 | event_id 单调递增，且都大于快照游标。合并后的 job、消息（user/tool/assistant）、调用状态与新快照完全一致。重连只收到中点之后的事件，两段合并后的状态与不断开时相同。命令只执行一次 |
| 一个长命令运行中，再交两个任务，取消排第一的，再取消运行中的；然后 Main 委派一个子任务；最后停掉 worker | 排队位置 1、2 实时出现，取消排第一的后另一个变为 1。运行中的任务先显示 `cancel_requested=1` 和调用上的取消发送时间，再变为 `cancelled`。父任务视图里子任务实时变为 succeeded，带结果和 `children_summary`。worker 离线后 `online=0`、`schedulable=false` |
| 清理全部事件后用旧游标、用不存在的未来游标订阅 | 都只收到 `reset`（`cursor_expired`）。新快照的 cursor 仍可用 |
| 未登录访问事件流、快照、历史、日志；退出登录后对已打开的流制造一个事件 | 全部 401。流在下一次推送时关闭，没有发出该事件 |
| Main 生成中途取消；Main 生成中途主节点停止再启动；正常完成 | 取消：草稿为 `interrupted`，保留部分文本，没有回答消息。重启：第一条草稿为 `interrupted`，重新执行后第二条为 `committed`，回答只出现一次。正常完成：草稿为 `committed`、文本为空，快照里只剩两条 `interrupted` 草稿 |
| 日志四个分块中缺第 1、3 块且已过期 | `gaps` 列出两个缺口和缺失字节数，快照中相同。P4 的完整日志和主节点容量满的日志都没有缺口 |

`pnpm test`：server 80 项（其中 `p6-events` 5 项）、protocol 3 项全部通过（`identity` 的迁移计数改为 10。`p3-races` 读审计事件时改为只看 `kind` 为空的行）。
