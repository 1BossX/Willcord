# P0 PiRuntime Spike 结果

日期：2026-10-06  
Pi SDK：`@earendil-works/pi-coding-agent` 1.0.4  
验证模型：自动化 spike 测试使用 Pi faux provider；2026-10-07 另以 OpenRouter 实际请求验证 `deepseek/deepseek-v4.1-flash`
状态：SDK seam 验证通过；P0 阶段整体仍未通过

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
