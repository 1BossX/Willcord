# P0 PiRuntime Spike 结果

日期：2026-10-06  
Pi SDK：`@earendil-works/pi-coding-agent` 1.0.4  
验证模型：自动化 spike 测试使用 Pi faux provider；2026-10-07 另以 OpenRouter 实际请求验证 `deepseek/deepseek-v4.1-flash`
状态：P0 八条受控 spike 验收通过（2026-10-07）；以下各增量保留其当时状态，当前结论见末尾矩阵

## 已实际验证

### OpenRouter 实际模型连通性（2026-10-07）

使用用户本机 `~/.zshrc` 中的 `OPENROUTER_KEY`，仅在子进程环境映射为 `OPENROUTER_API_KEY`；没有打印或写入密钥。模型为 OpenRouter `deepseek/deepseek-v4.1-flash`。

| 场景 | 验证方式 | 结果 |
|---|---|---|
| 非流式最小请求 | OpenRouter Chat Completions | HTTP 成功；`finish_reason=length`；prompt 35、completion 8、total 43 tokens；OpenRouter 报告费用 `$0.00000655` |
| 流式请求中止 | 首个响应片段后发送 AbortSignal | HTTP 200，读取流停止；按设计未收到最终 usage 帧 |
| Pi AgentSession 端到端取消 | `npm run verify:openrouter` 启动真实 Pi session，在 provider 首个数据块到达后调用 `session.abort()` | Pi run 正常 settle，session idle，工具执行 0 次；未收到最终 usage 帧 |
| job/root 累计预算持久化 | SQLite adapter 跨 generation、子任务与数据库重开测试 | token/step 计数持久化；job/root token 超额时工具 gate 关闭；step ceiling 阻止下一次 generation |
| 父子等待持久化 | SQLite adapter 关库重开、验证 child ID 与结果恢复 | parent 的 `waiting_children`、child ID 与结果可恢复；恢复后可进入下一 generation |

取消结果证明 Node fetch 和 Pi AgentSession 的本地运行都能由 AbortSignal 中止，且取消后没有工具执行；未收到最终 usage 帧，因此不能据此确认 OpenRouter 上游何时停止计费或本次取消请求的费用。

复跑真实 Pi/provider 取消验证：从 `~/.zshrc` 安全映射变量后运行 `npm run verify:openrouter`。脚本仅把 key 写入 OS 临时目录中的短期 Pi credential store，结束时删除目录，不输出 key。

| 能力 | 验证方式 | 结果 |
|---|---|---|
| 工具隔离 | 实际创建 Pi coding-agent session，检查 active tools | `noTools: "all"` 与显式名单只暴露指定的 custom tools；Main/worker 名单分别匹配 |
| 执行前完整轮次持久化 seam | 包装公开 Agent.beforeToolCall，观察其完整 assistant message 后才执行假工具 | 第一个 hook 收到整批 toolCall；异步 hook 完成后才进入 tool execute |
| 同轮串行 | Pi 实际执行两项假工具，第二项后再发送下一轮模型响应 | 顺序执行，前一调用结束后才运行后一调用 |
| SDK transcript 持久化/恢复 | Pi SessionManager 写 JSONL，关闭并重开 SessionManager 和 AgentSession | assistant toolCall 与两个 toolResult 都重载；可在恢复 session 上继续推理 |
| 主节点 SQLite 检查点 | 实际 Pi hook 调用 SQLite adapter；检查执行前提交、关库重开和待对账调用 | 工具执行前整批 assistant 意图已提交；重开后仍可读，恢复检查不再次执行 |
| SQLite 重复与事务约束 | SQLite adapter 测试相同轮次重试、内容冲突、跨轮 call_seq、事务回滚和结果状态 | 相同内容幂等；内容变化冲突；唯一序号递增；失败不留部分 checkpoint |
| 主 Agent 等待委派 | delegate 假工具返回稳定 child ID 与 `terminate: true` | 当前 Pi run 在一个模型请求后结束，不自行轮询；结果保留在 session transcript |
| 推理取消 | 可控 fake provider 等待 AbortSignal | `session.abort()` 发出 signal，假 provider 响应中止，session settle，工具未执行 |
| 超预算工具拒绝 | 按 assistant usage 做 host gate，返回 false | Pi 将工具调用标记为受阻，假工具没有执行 |
| 应用侧调度假设 | dependency-free harness | 工具白名单、turn checkpoint、generation 过期拒绝、等待子任务和匹配结果恢复均通过 |

验证命令：`npm test`。结果：22 项通过，无失败。真实 provider 取消命令：`npm run verify:openrouter`，本次通过。依赖版本固定在 package.json/package-lock.json；测试 key 和 SessionManager 数据仅写在 OS 临时目录。

## 本地发现与实现约束

Pi 的 `Agent.beforeToolCall` 收到完整 assistant message 和当前工具参数。该 hook 对同一个批次中的每个工具调用都会运行，因此主节点的 checkpoint 写入必须按 assistant turn key 幂等。checkpoint 写失败或预算拒绝时，hook 必须阻止工具执行。

AgentSession 默认可能装载本地工具。本项目创建 session 时必须显式使用 `noTools: "all"`、精确 `tools` 和 `customTools`，并在运行时核验 active tool names；不可依赖 Pi 默认值。

将 Pi 的 `finishTurn` 设为结束当前 run，由 ExecutionCoordinator 在完成持久化和预算检查后显式启动下一模型轮次。委派工具创建持久化子 job 后返回可恢复结果并终止当前 run；不能让 Pi 内部循环轮询 child job。

Pi SessionManager 的 JSONL 适合恢复模型 transcript，但不与主节点 job/tool-call SQLite 事务原子提交，不能作为执行账本。主节点需在 hook 中先提交完整工具意图和 checkpoint，再允许工具 dispatcher 联系 worker。

SDK 只报告每个 assistant 响应的 usage；job/root 累计预算由主节点累计并持久化。预算拒绝要在工具执行前 gate；预算用尽后 Coordinator 不再启动下一次模型请求。

## 尚未通过的 P0 条目

1. **真实 provider 已完成本阶段验证。** 已通过 OpenRouter + DeepSeek V4.1 Flash 获得真实 usage，并通过 Pi AgentSession 验证真实 provider 流取消后运行结束、没有工具执行。中止流没有 final usage，实际取消费用未知。
2. **双持久层崩溃窗口尚未完整验证。** 已实现并测试主节点 SQLite checkpoint adapter，也分别验证 Pi JSONL 与 SQLite 文件重开；尚未验证两者在分别落盘/崩溃时的完整对账流程，SQLite 与 Pi transcript 仍非原子提交。
3. **中断后的未决工具恢复尚未完整验证。** 测试覆盖 Pi hook 已提交完整调用意图、SQLite 重开后保留为 committed；尚未覆盖主节点/worker 在 RPC 派发前、派发后但无结果时分别崩溃，以及如何与 worker 账本对账。
4. **job/root 累计预算已在 SQLite adapter 验证，尚未接入 Coordinator。** SQLite 测试覆盖跨 generation、共享 root、重启和超预算 gate；需要接入真实调度器并补齐竞争验收。
5. **父子等待已在 SQLite adapter 验证，尚未接入 Coordinator。** parent/child 关系、waiting 状态、匹配结果恢复和重启后续跑有真实 SQLite 证据；需要接入 delegate 创建与主节点恢复流程。

## P0 结论

Pi 1.0.4 满足继续采用的接口条件：工具可完全收窄，执行前 hook 可拿到完整工具批次，会话 transcript 可持久化和恢复，推理取消可传递，父任务可以在一轮后交还控制权。没有发现阻止采用 Pi 的 SDK 缺口。

P0 作为整体仍为 **进行中**。正式通过前需补齐真实 provider 取消/usage 验证、SQLite + Pi transcript 崩溃恢复设计与测试、累计 job/root 预算，以及可持久化父子等待。上述后续项横跨 P0 与 P3/P5 的实际实现，不应误报为当前已经验收。

## 2026-10-07 SQLite → Pi transcript 恢复增量

`npm test`：30 项通过，0 失败。新增 5 个独立 Node 子进程使用真实
better-sqlite3 / Pi SessionManager 写入后 SIGKILL；恢复侧重新打开 SQLite，
使用公开 Pi SDK 重建及重新打开 JSONL，并以 faux provider 验证实际 AgentSession。
没有请求外部模型，未验证机器掉电、文件系统损坏或真实 worker RPC。

| 注入窗口 | 预期与实际结果 |
|---|---|
| SQLite 意图已提交，JSONL 无 assistant | 阻塞；两个原 call ID 保留，不生成下一模型请求，不执行工具 |
| JSONL 有 assistant，SQLite 无意图 | 丢弃 JSONL 意图，恢复 SQLite 原用户请求；新模型响应请求 1 次，工具执行 0 次 |
| 两项结果提交，JSONL 未写结果 | 重建原 assistant 与原两项结果；Pi 继续请求 1 次，工具重放 0 次 |
| 第一项完成，第二项 dispatched 未知 | 阻塞原第二项；恢复不请求模型或重放工具 |
| 取消历史落盘 | 保留 aborted assistant；直接 continue 被 SDK 拒绝且请求 0 次；新持久用户消息后恢复推理 |

另外验证历史幂等/冲突、多条用户与 assistant 顺序、缺失 legacy 基础历史阻塞、
结果身份不匹配阻塞、参数内容不匹配阻塞、旧式字符串或损坏的 assistant content
以 RecoveryBlockedError 阻塞，以及恢复 AgentSession 自动压缩已禁用。
SQLite 事务同时记录工具批次与历史次序；JSONL 只是可重建投影，重试恢复从 SQLite
重新创建文件。系统 prompt 和运行配置仍由 host 提供。

本项收口的是历史投影和失败关闭规则。**已提交但未完成调用的安全派发、worker 账本
对账和 Coordinator 集成仍未完成，P0 整体仍未通过。**旧检查点没有用户历史时不能
从 JSONL 静默导入执行；必须明确迁移后再恢复。

## 2026-10-07 Worker SQLite 账本对账增量

`npm test`：39 项通过，0 失败。新增 worker SQLite adapter 与主节点持久请求绑定，
明确返回 completed / observe / wait / dispatch_same_request / needs_attention。
这组测试无远程连接、无模型请求；可信身份由测试 host 注入，不代表已实现网络认证。

| 验证 | 预期与实际结果 |
|---|---|
| 主节点 dispatched、worker 尚未 accepted 后 SIGKILL | 同可信账本、下界以上缺失证明允许原 ID/hash 请求重传；后续调用仍等待 |
| accepted 或 running 后 SIGKILL、worker 新 boot | needs_attention；不重启工具、不开放后续调用 |
| 唯一 marker 副作用完成、结果尚未落库后 SIGKILL | needs_attention；文件只有一条原 call ID，禁止重放 |
| 结果已提交、发送/主节点结果落库前 SIGKILL | 从 worker 导入原 Pi result；不重复 marker append；完成后才开放下一序号 |
| 同 boot accepted/running | observe；worker 拒绝另一个活动调用；Pi transcript 恢复仍阻塞 |
| 两项串行结果导入 | 恢复原两个 call ID 的完整 transcript |
| 账本变化/不可用、缺失原绑定、请求 hash 或本地结果矛盾 | needs_attention，不推断安全执行 |
| 结果明细回收 | 保留 job 下界与 call ID/hash tombstone，旧序号或跨 job 同 ID 不能复活 |

五个独立 Node 子进程使用真实 SQLite WAL/FULL，在上述窗口 SIGKILL。
副作用为临时目录文件追加；验证重启观察与结果恢复不会追加第二条 marker。
该证据不是机器掉电持久性证明，也不证明任意外部命令恰好一次。

主节点绑定持久化失败或缺失时拒绝对账；派发前必须落库绑定。已派发且原绑定丢失时，
不能用当前 ledger 重新绑定。absence 决策仍需 worker accepted 事务重新核对活动槽；
它不是直接执行授权。取消/终态 job gate 与 needs_attention 的业务持久化仍由未来
Coordinator 承担。

请求 hash 使用有限 JSON 值与排序 key 的 provisional spike-json-v1；测试固定 SHA-256
样例与排序一致性，并拒绝 undefined、Infinity、稀疏/装饰数组。**未宣称 RFC8785
合规或 Rust/JS 互通。** 生产数据目录锁、Rust worker/WSS、完整调度和预算/父子等待
集成仍未完成，P0 整体仍未通过。

## 2026-10-07 最小 Worker ExecutionCoordinator 增量

`npm test`：56 项通过，0 失败。新增 worker-role Coordinator，使用实际 Pi SDK 与
SQLite；worker transport 为注入的本地假实现，无外部模型或 WSS 请求。
Coordinator 与预算 adapter 共享检查点 **同一 SQLite connection**，工具批次的
usage、原意图、可信目标绑定及 lifecycle 在同一事务中提交。

| 验证 | 预期与实际结果 |
|---|---|
| 实际 Pi 同轮两工具 | 顺序执行原 call IDs；重复 hook 只记一次 usage/step；下一轮由 Coordinator 显式启动 |
| 绑定失败 | usage、整批意图、绑定全部回滚；Pi 捕获 hook 错误后仍持久 needs_attention；重复恢复不解封 |
| 超 token ceiling | worker accepted 前拒绝整批，配对 not-executed 结果；工具执行 0 次，不能请求下一轮 |
| root step/attempt ceiling | 最后合法轮次工具可执行；下一模型请求被 gate；模型 attempt 先持久化 |
| 两工具之间共享预算耗尽 | 第一项完成；第二项无 worker accepted，配对拒绝结果；不继续推理 |
| 取消后的迟到 provider 回复 | 原 generation 失效；新 usage/意图/工具/terminal commit 均为 0 |
| 已运行工具期间取消 | 保留真实 worker 完成事实；恢复导入结果，下一未接受项配对取消；持久 cancelled，无继续模型请求 |
| 恢复期间取消 | generation 递增；恢复不能覆盖为 ready；并发 recover/runStep 拒绝 |

四个独立子进程实际创建 Pi session，并在模型请求开始、完整意图事务提交后、文件
marker 副作用后及 worker 结果提交后 SIGKILL。重启分别得到：未知最终 usage 阻塞、
按原意图执行一次、未知副作用阻塞、取回缓存原结果而不重复追加 marker。
恢复保持原 token/step counters；仅明确安全恢复后发出下一模型请求，不重新生成
已提交的工具 turn。未知模型 attempt 连续恢复仍为 needs_attention。

usage 取 pinned Pi adapter 的 input + cacheRead + cacheWrite / output；测试以实际
faux provider 返回的 message usage 核对计数，并用固定样例核对 cache 分项口径。
该 provider 会根据实际 prompt 估算 tokens，所以未将手写 faux usage 当成真实回包。
模型请求前另记 attempt 并按 job/root maxSteps 限制总请求次数。取消或网络中断后的
最终 usage 可能未知；已有计数不回零，但本项不保证精确账单或严格货币成本 ceiling。

**本 PR 只收口 worker 执行路径。**取消 lifecycle 已持久化，aborted provider 消息未
投影到 SQLite 历史。Main delegate、持久父子等待及匹配 child 结果尚未接入；生产
single-owner 锁、Rust/WSS、远程终止核验与规范 RFC8785 仍未实现。P0 整体仍未通过。

工具参数恢复补充：Pi SDK 先校验当前调用，再运行 beforeToolCall；首个合法调用
的 hook 仍持久化整批，因此后续未校验意图可能已提交。Coordinator 在 live/recovery
worker accepted 前都调用公开 validateToolArguments；非法或需要 coercion/preparation
改变的原参数，在同可信账本证明从未接受后配对 notExecuted 结果，不执行副作用。
新增真实 Pi 首合法/后非法批次 SIGKILL 恢复及 live coercion 测试；原参数与 hash
保持不变，不将被转换的 payload 静默当作原执行内容。

恢复自身崩溃补充：未知 model attempt 由 coordinator_attempts 与 runtime_usage
缺失关联直接判定，在恢复 opening transaction 内与 generation fence 原子保存
needs_attention。新增 model SIGKILL 后，再在恢复 opening transaction 已提交处
SIGKILL 的双进程测试；第三次重开及连续恢复仍阻塞，后续模型请求 0 次。
即使旧式 lifecycle 被写为 ready，runStep 仍以缺失 usage 证据阻止推理。

## 2026-10-07 Main / child delegation Coordinator 增量

`npm test`：71 项通过，0 失败；`git diff --check` 通过。实际 Pi Main 工具名单为
list_workers / delegate / get_job，child 为独立 worker role。工具与模型均为本地
注入/faux provider，无外部请求或真实 WSS。

| 验证 | 预期与实际结果 |
|---|---|
| 同轮两个 delegate 与本地工具 | 按提交顺序原子接受全部有效 child；重复 hooks 不新增 child、不重复计 usage；Main 请求 1 次后 waiting_children，无 worker slot |
| 独立 child | host 派生稳定 child ID / parent / root；session 不同于 parent 且彼此不同；自己的原请求/history；目标、版本、session、timeout 在接受时固定 |
| child 完成扫描 | 同 SQLite snapshot 读终态/history；逐个匹配 owned child，稳定 key / 源 timestamp 幂等投影；所有 child 已解决后 parent 才 ready |
| invalid delegate / 越权 get_job | 显式错误结果、无非法 child；不能伪造 parent/root 或读取其他 parent 的 child |
| 首项全非法、SDK 无 pre-tool hook | final response 原子保存实际 usage、原意图与 notExecuted 结果，不丢弃花费证据 |
| child 工具错误 / 显式 terminal failure | 普通工具错误保留下一轮修复机会；host failJob 记录明确 failed outcome，并投影给 parent，不自动派生依赖 |
| shared root budget | parent 与两个 child 累积计数；重启保持；root ceiling 阻止 parent 新模型请求 |
| parent cancel | 同一事务标记/隔离所有 pending child；未知执行不假称取消完成；真实结果恢复后才能最终 cancelled |
| 未知 child model usage | 从持久 attempt/usage 识别并 fence；parent 连续恢复仍阻塞，后续模型请求 0 次 |
| 原 PR4 SQLite 文件升级 | CHECK schema 事务迁移；原在途 intent、usage、绑定保持，并可按原意图恢复 |

新增独立 Pi 子进程 SIGKILL：delegate acceptance 提交后、child terminal 提交后而
扫描前、projection 事务中、projection 提交后、parent cancellation 事务提交后以及
child model 请求开始。验证 children 不重复创建、结果不重复追加、未决 parent 不
推理，且取消传播崩溃时所有 sibling 已被持久隔离。projection 中途 crash 回滚整个
事务，重启重扫得到相同两项结果；projection 提交后 crash 不重复写 history。

Scanner 不依赖事件投递成功，直接读取同库 child state/history；terminal assistant
history 与 child lifecycle 原子提交，parent 结果投影与等待解除也原子提交。工作仍为
single-owner、单一配置目标的 spike。没有 full DAG/FIFO/worker registry/Rust/WSS，
没有生产锁、远程终止核验或规范 RFC8785 互通；aborted provider transcript history
仍未接入，未知 usage 无法精确计费。**P0 整体仍未宣称通过。**


## P0 最终验收矩阵（2026-10-07）

验证命令：`cd spikes/pi-runtime && npm test`，80 项通过，0 失败。固定 Pi SDK
1.0.4，实际 AgentSession/SessionManager、SQLite WAL/FULL 与独立 SIGKILL 子进程；
模型响应使用 faux provider，本轮没有调用外部模型。真实 OpenRouter 取消/usage 的
既有证据日期为 2026-10-07（见上文）；provider 验证代码本轮未改变，未重复外部请求。

| P0 条目 | 预期与实际证据 | 测试来源 | 结论 |
|---|---|---|---|
| 1 工具隔离 | Main 仅 list_workers/delegate/get_job；worker 仅注入 read/write/bash，无 Pi 内置本地执行工具 | pi-sdk.test.js role allowlist；parent-child.test.js actual Main | 通过 |
| 2 授权前不执行、整批串行 | usage/意图/绑定同事务；失败回滚；原调用串行，接受前校验参数 | execution-coordinator.test.js atomic batch/binding failure；pi-sdk.test.js complete batch | 通过 |
| 3 数据库历史恢复 | SQLite 重建新 Pi 投影；原 call ID、参数、结果关联保留，旧 JSONL 不授权执行 | transcript-recovery.test.js SIGKILL results/integrity；worker-ledger.test.js two results | 通过 |
| 4 已提交原意图恢复、未提交明确重试 | committed intent crash 不重新生成；草稿 crash 自动阻塞，可信 host 提供已核对用量及证据、新用户消息后重试；旧草稿 ID 不执行 | execution-coordinator.test.js intent SIGKILL；interruption.test.js partial tool draft SIGKILL | 通过 |
| 5 取消与过时代次 | late provider 不提交 usage/意图/工具/终态；已归档草稿不被迟到事件改写 | execution-coordinator.test.js cancel fences late provider；interruption.test.js cancellation late updates | 通过 |
| 6 步数/token 预算 | job/root 实际 usage 持久累加；模型 attempt 先落库；重启/核对重试不重置，耗尽后不接受工具或新请求 | sqlite-runtime-state.test.js；execution-coordinator.test.js budget；interruption.test.js attempt/token retry budgets | 通过 |
| 7 持久父子等待 | 同轮多个 child 只创建一次；Main 一次请求后停止；匹配持久结果扫描/投影后才恢复 | parent-child.test.js actual Main 与 accepted/child_completed/projection SIGKILL | 通过 |
| 8 取消历史重载与压缩策略 | 已知未接受项明确 notExecuted，与真实完成结果配对；关库重开实际 Pi history；aborted 草稿去除未提交工具块；自动压缩关闭 | interruption.test.js cancelled committed batch reopen/aborted reload；transcript-recovery.test.js autoCompactionEnabled | 通过 |

中断处理记录 `coordinator_drafts`（每 generation 最多 64 KiB 的明确截断快照）与
`coordinator_usage_resolutions`。草稿只供审计；取消/中断归档为 aborted assistant，
未提交 toolCall 不进入执行历史。核对接口不接受模型调用：可信 host 必须提供每个
缺失 generation 的已验证 input/output usage 与 source/reference；计数、核对审计、
新消息及 lifecycle 同事务提交。重复相同核对幂等，矛盾核对拒绝；未决执行/children
禁止重试。取消 job 不能通过该接口复活。没有用量证据时继续 needs_attention，
不猜测、清零或自动重试；精确账单和上游中止时点仍未知。

**P0 的八条接口能力验收已通过，可进入 P1。**这不代表生产 MVP 已完成：single-owner
锁、认证/协议、FIFO/DAG、多 worker 注册、Rust/WSS、远程进程终止核验与 RFC8785
互通仍按 P1–P7 实施，不能以此 spike 代替其验收。历史增量中的“P0 未通过”是对应
提交时的记录，以此矩阵作为当前结论。

Bugbot 收口复核补充：final commit 异常、无 durable finish 出口，以及已进入 needs_attention 的恢复提前返回，都会归档 streaming 草稿；归档与阻塞状态同事务，重复恢复不追加记录。新增实际 Pi final commit failure / binding failure reload 回归。
