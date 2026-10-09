# P6 UI 与完整端到端体验

日期：2026-10-09。P6 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p6ui-与完整端到端体验)，设计依据见 [架构 §4、§12](architecture.md)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P6-A | 事件流（触发器写事件）、带游标快照、SSE 补放与游标过期、模型草稿、日志缺口、委派子任务汇总 | 完成 |
| P6-B | UI 改为快照 + SSE，补齐机器状态、委派卡片、排队与取消、需要核对、日志缺口和草稿的展示 | 完成 |
| P6-C | 故障程序、浏览器端到端走查（含网络记录）与全量验收记录 | 完成，见 [总验收](#总验收) |

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

## P6-B：UI 改为快照 + SSE

### 数据层

- `apps/web/src/feed-state.ts`：纯函数。`fromSnapshot` 建立状态，`applyEvent` 逐条应用事件。
  - event_id 不大于当前游标的事件是重复，不改变状态。
  - 同一实体按 ID 覆盖为最新状态；数据为空时删除。
  - 只保留当前会话的消息、job、调用、日志和草稿。worker 和 session 是全局的。
  - 已提交的草稿直接移除，避免回答出现两次。
  - `event: cursor` 只让游标前进。
- `apps/web/src/feed.ts`：`useFeed(enabled, sessionId)`。
  - 先取 `/api/snapshot`，再用快照游标打开 `EventSource('/api/events?after=…')`。
  - 断线由 EventSource 带 `Last-Event-ID` 自动重连。收到 `reset` 或 EventSource 放弃重连时，重新取快照。
  - EventSource 放弃后先查 `/auth/session`：未登录就回到登录页。
  - 切换会话时先清空上一个会话的记录，再取新会话的快照。
- 去掉了 2 s / 5 s 轮询。人工核对面板在 `attention`、`worker` 和 needs_attention 相关的 job 事件到来时重新读取。
- 刷新后恢复上次打开的会话，Main 会话也包括在内。只有 ID、记录还没收到的子会话，由该会话的快照补上。

### 展示

| 验收 | UI |
|---|---|
| #1 | 机器状态分两部分：连接（在线/离线）和执行（可执行/忙碌/需要核对/等待机器确认/等待对账/不可执行）。"可执行"只在服务端的 `schedulable` 为真时显示 |
| #2 | 委派卡片默认展开，显示来源（Main 任务）、目标、子任务的实时状态、结束原因（前置任务未成功、验证未通过）、验证结果和子任务的总结，并保留"打开子会话"。Main 任务下方显示"N 个子任务未成功"（模型给出的 outcome 不变） |
| #3 | 每个任务下方用文字说明它在哪、为什么等：队列第几位、等待哪台机器上线以及截止时间、等前置任务、等子任务、机器需要核对。已发出但还没有结果的调用显示为"正在执行"，可以查看实时输出。取消请求显示"已请求取消"和原因 |
| #4 | needs_attention 在状态标签、任务说明和委派卡片里都显示"需要核对"。带取消请求时说明"不能宣称已安全停止" |
| #6 | 完整日志列出每个缺口（块号、起始字节、缺失字节），还在接收时标"仍在接收"。实时连接断开时显示"正在重连并补齐断线期间的变化" |
| #7 | 草稿显示为虚线框中的回答，标"正在生成…"；中断的草稿标"生成中断，未提交"并加删除线，不当作回答 |

### 验证

- `apps/web/test/feed.test.ts`（`node --test`）6 项：重复事件不改变状态；同一实体取最新状态；其他会话的记录不进入当前视图，但游标照样前进；已提交草稿移除、中断草稿保留；删除实体，游标标记只前进；核对相关事件让核对面板刷新。
- 浏览器走查，环境用 `apps/server/test/support/walkthrough.ts`：主节点 + 脚本模型 + 两个真实 Rust worker，8105 端口的前端转发 `/api`、`/auth`。
  - Main 发送"在 w 上跑测试，通过后在 v 上写说明"：委派卡片实时从"执行中"变为"已完成，验证通过"，v 的卡片显示前置任务。
  - 发送"测试失败的情况"：w 卡片显示"验证未通过（退出码 1）"，v 卡片显示"前置任务未成功，没有执行"，Main 下方显示"2 个子任务未成功"。
  - w 的会话：长命令运行中显示"正在执行 · echo long …"。追问显示"排在 w 队列第 1 位"。刷新后会话和状态都恢复。取消后长任务变为已取消，追问随后开始，草稿流出后被正式回答替换，没有重复。
  - Main 发送"慢慢回答"并在生成中取消：草稿变为"生成中断，未提交"。
  - 走查中途重启了环境：浏览器的事件流先是连接失败，再收到 401，随后回到登录页。
  - 手机宽度（375 px）没有横向滚动，刷新后回到 Main。
  - 网络记录：所有请求都是 `localhost:8105` 的页面资源、`/auth/*` 和 `/api/*`（快照、事件流、消息、取消、workspace），没有访问 worker 地址，也没有携带 worker token。
- `pnpm check`、`pnpm build` 通过。

## P6-C 故障程序与验收

### 故障程序（`apps/server/test/p6-faults.test.ts`）

| 场景 | 结果 |
|---|---|
| 主节点作为独立进程运行。事件流打开、命令执行到一半时 SIGKILL 主节点，删掉锁后重启，浏览器用断开前最后一个 event_id 作为 `Last-Event-ID` 重连 | 旧连接结束，新连接只补放这个 ID 之后的事件。两段合并后的 job、消息和调用状态与重启后节点的新快照一致，job 为 succeeded，命令的前后两行各只写了一次 |
| worker 在命令执行后、写账本前被杀（`after_effect`），重启后上报执行不明；再追问一条；取消卡住的任务；人工放弃；人工解除阻塞 | 事件流依次显示：job 进入 `needs_attention`，worker `blocked=1`、在线但 `schedulable=false`，调用为 `unknown`。追问是 `waiting_worker`，排第 1 位，卡住的任务不受影响。取消只记录 `cancel_requested=1`，状态仍是需要核对。放弃后 job 为 cancelled，机器仍然阻塞。解除后 worker `blocked=0`，追问执行成功。每个 job 的状态、结束原因、取消请求，调用状态和 worker 标志都与 SQLite 一致。人工操作都有 `attention` 事件。没有任何命令被重跑 |

`test/support/sse.ts` 遇到服务端中途断开时，把它当作连接断开记录下来，不再当作测试异常。

### 浏览器走查

环境同 P6-B（`apps/server/test/support/walkthrough.ts`），另加一台 x：它运行带故障注入的 worker，第一次调用时在 `after_effect` 处退出，之后以正常模式重新连上。

| 步骤 | 页面上看到的 | 数据库 |
|---|---|---|
| 登录，首页 | 三台机器都是"在线"和"可执行"，分开显示 | — |
| x 上新建会话，发送"崩溃任务" | 顶部横幅"这台机器需要核对"。任务标签为"需要核对"，下方是"执行情况未知 · echo crash >> marker.log"和"需要核对：执行情况无法确认，不会自动重跑"。侧栏里 x 显示"在线"和"需要核对" | — |
| 再发"跑测试" | 追问排进队列，标"等待机器"，时间线显示队列第 1 位。输入框下方说明"消息将保留在队列中，等待机器完成核对" | — |
| 在任务详情里填放弃说明，点"放弃任务" | 任务变为已取消，结束原因"已放弃"。核对面板仍然要求填写调用结果和依据 | — |
| 选择"已执行完毕"，填核对依据，点"解除阻塞" | x 变为"忙碌"，追问开始执行，显示"正在执行"和"查看实时输出"，随后完成并给出回答 | 崩溃任务 `cancelled/abandoned`；追问 `succeeded`；`crash-1` 为 `resolved`；x `blocked=0`；人工操作依次为 blocked、abandon、unblock、unblocked；x 的 marker 里 crash 和 test 各一行 |
| 网络记录（`performance` resource 条目） | 只有 `localhost:8105` 一个主机，路径只有页面资源、`/auth/session`、`/auth/login`、`/api/snapshot`、`/api/events`、`/api/sessions…`、`/api/attention`、`/api/jobs/:id/abandon`、`/api/workers/x/unblock`、`/api/workers/x/workspaces` | — |

走查中发现并修复：机器在线但被阻塞时，排队中的追问原来写着"等待上线"。现在显示"需要核对，核对完成前不会开始"；时间线写"等待机器核对"；状态标签 `waiting_worker` 改为"等待机器"。

已知限制：人工结清的调用不会生成工具消息，所以被放弃的任务在会话里只剩用户消息。结清的依据记录在人工操作里，`/api/attention` 可以查到。

### 总验收

验收环境：macOS arm64，Node 22.22.3，Rust 1.99.0，主节点和 worker 都在本机，模型为脚本模型。真实模型和真实双机联调放到 P7。

先执行 `cargo build --locked --manifest-path worker/Cargo.toml`，再执行 `PATH=/opt/homebrew/bin:$PATH pnpm test`：server 82 项（`p6-events` 5 项、`p6-faults` 2 项）、web 6 项、protocol 3 项全部通过。`/health` 的 phase 为 `P6`。

| # | 验收标准 | 证据 | 结果 |
|---|---|---|---|
| 1 | Main Agent 置顶；在线与 idle/busy/blocked 分开，在线不误显示为可执行 | 侧栏 Main Agent 置顶。机器的连接和执行状态分开显示，"可执行"只取服务端的 `schedulable`。`p6-events`：worker 离线后 `schedulable=false`。`p6-faults`：在线但阻塞时 `schedulable=false`。走查：x 显示"在线"和"需要核对" | 通过 |
| 2 | 委派卡片显示来源、目标、状态与结果，可开子 session；追问进当前会话 | `p6-events`：父任务视图里子任务实时变为 succeeded，带结果和 `children_summary`。P6-B 走查：卡片实时变化，验证失败和依赖失败的原因、"2 个子任务未成功"、"打开子会话"都正常。追问用当前 `session_id` 提交，不猜测机器最近的任务 | 通过 |
| 3 | 执行期间追问排队、不改活动 job；显示等待上线、排队位置、取消请求 | `p6-events`：排队位置 1、2 实时变化，取消排第一的后另一个前移，`cancel_requested` 先于终态出现。`p6-faults`：追问为 `waiting_worker`、排第 1 位，卡住的任务不受影响。P6-B 走查和本节走查的页面截图都对应这些状态 | 通过 |
| 4 | needs_attention 显示"需要核对"，人工操作结果与数据库一致 | `p6-faults`：每一步人工操作后，事件流的状态与 SQLite 逐项一致。本节走查：页面显示与数据库查询一致，任何位置都没有显示"已完成" | 通过 |
| 5 | 带游标快照后订阅 SSE，重复 event_id 不重复渲染，断线补放无关键状态缺失 | `p6-events`：快照游标之后补放，从中间断开再重连，合并后与新快照一致。`p6-faults`：主节点被 SIGKILL 后用旧游标补放，结果完整。web `feed.test.ts`：重复或已覆盖的 event_id 不改变状态 | 通过 |
| 6 | 刷新/重连恢复任务；游标过期要求重取快照；日志过期、缺口、截断明确显示 | `p6-events`：过期游标和不是本库发出的游标都收到 `reset`。日志 `gaps` 与快照一致，截断不算缺口。UI 收到 `reset` 后重取快照，并显示缺口、过期、截断和"仍在接收"。走查：刷新后恢复会话（包括 Main）和运行状态，主节点重启后浏览器回到登录页 | 通过 |
| 7 | 中断草稿可识别，已提交消息和工具结果不重复；敏感历史与日志仅认证用户可见 | `p6-events`：取消、主节点重启都留下 `interrupted` 草稿，回答只出现一次。未登录访问事件流、快照、历史、日志都是 401；退出登录后事件流关闭。走查：页面上中断草稿标"生成中断，未提交"，提交后的草稿被正式回答替换 | 通过 |
| 8 | 浏览器提交真实任务，观察工具和数据库，查看结果、取消与恢复 | P6-B 与本节走查：真实 Rust worker 执行命令，页面显示执行中、结果、取消，以及需要核对后的恢复，数据库查询与页面一致。模型为脚本模型（已定决策） | 通过 |
| 9 | 浏览器只连主节点 REST/SSE，不访问 worker、不带 worker token；切换后只显示当前目标数据；断线恢复靠快照与补放 | 两次走查的网络记录只有主节点的 `/api/*`、`/auth/*` 和页面资源，worker token 只存在于 worker 进程。`feed-state` 只保留当前会话的记录，切换会话时先清空再取新快照（web 单测）。断线恢复只用快照和 `/api/events` | 通过 |

出口条件"无须查看开发日志即可理解任务处于何种状态、为何等待以及如何处置"：每个任务下方都用文字说明状态、等待原因和下一步操作，人工核对面板给出处置入口。P6 验收完成。
