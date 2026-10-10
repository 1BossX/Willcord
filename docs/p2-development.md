# P2 单 worker 执行闭环

日期：2026-10-08

P2 当前实现固定 worker/workspace session、离线等待队列、按 worker FIFO 派发、Pi tool checkpoint、read/write/bash worker 调用和聊天任务界面。Pi SDK 1.0.4 与模型由服务端配置；`P2_FAKE_MODEL=1` 仅用于隔离验收，重放固定 read/write/large-write/bash/final 脚本，不请求外部模型。

## 接口与执行流程

- `POST /api/sessions` 必须带 `worker_id` 和 `workspace_id`，可附 `repo_id` 以拒绝错误仓库；多 workspace 通过 `GET /api/workers/:worker_id/workspaces?all=true` 列出后显式选择。
- `POST /api/sessions/:session_id/messages` 带 `client_request_id` 与消息文本。重复 ID、相同消息返回既有 job，不同消息返回 409。创建消息、FIFO 序号、job 和用户历史在 SQLite 事务内提交。
- `GET /api/sessions/:session_id/jobs` 与 `/messages` 提供认证后的任务状态和聊天/工具结果。页面每两秒轮询任务和历史；刷新从 Cookie 恢复登录，并从 `/auth/session` 恢复 CSRF token。
- Coordinator 先持久占用 `worker_slots`，再启动 Pi。Pi 完整 assistant 工具意图先提交 SQLite；工具按序经 WSS 派发，结果事务提交后回 ACK 并继续 Pi 下一轮。完成后的 job 释放槽。
- offline worker 的 job 进入 `waiting_worker`，默认保留 24 小时，可用 `WORKER_WAIT_MS` 配置；worker 完成 reconcile 后按序恢复派发。超时 job 每分钟扫描并标为 failed。

## Worker 协议与工具

协议共用 `packages/protocol/schema.json` 和生成的 TS/Rust 类型。`tool_call`/`tool_result`/`tool_ack` 增加 request hash、固定 workspace 版本和连接 epoch；write 内容通过有序 `tool_data` Base64 帧分块，单帧仍不超过 65,536 字节，单次内容上限 1 MiB，worker 重组后校验 SHA-256 与请求 hash 再执行。

read 只接受 UTF-8 文本，文件上限 256 KiB、单次最多返回 6,000 字符。write 校验 expected hash，同目录临时文件同步后原子替换并保留既有权限。read/write 用 workspace 根目录和逐级 `openat(O_NOFOLLOW)` 目录句柄拒绝绝对路径、`..` 与符号链接逃逸。bash 固定 workspace cwd、非交互 bash、显式 PATH/HOME、关闭 stdin、无 PTY，600 秒超时，保留非零 exit code。

worker 在 SQLite 中先记 running，再执行并保存结果；同 call ID 不同 hash 拒绝。主节点 result ACK 仅在结果提交后发送。不确定调用保留执行槽并阻止 worker。P3 仍负责断线/崩溃后的完整账本对账、tombstone 与跨重启恢复验收。

## 验收记录

验收环境：macOS arm64 主节点、`linux-test-worker` Linux x86_64 worker、Rust 1.93.1 容器工具链、临时 CA。worker 通过 `wss://control.example.com:8443/ws/worker（地址已脱敏）` 直连；远端证书 IP SAN 和 CA 校验通过。临时 worker、主节点和监听器在验收后停止；远端隔离目录保留用于检查验收文件。

| 验收项 | 证据/结果 |
|---|---|
| 指定 worker/workspace 与 repo 不匹配拒绝 | `apps/server/test/p2.test.ts`：匹配创建 201，repo mismatch 409 |
| 请求幂等 | 同 ID 同消息复用 job；内容不同返回 409；真实 SQLite 测试通过 |
| 每机 FIFO/互斥 | `apps/server/test/p2.test.ts` 跨两个 session 并发 pump，验证按 queue_seq 执行且 worker_slots 同时最多一个活动 job |
| 离线可提交 | SQLite/API 测试创建 `waiting_worker` job；真实 UI 见下方离线截图 |
| WSS 注册与对账 | linux-test-worker 最终验收连接代次 12，online/reconciled=1；worker_ready 后恢复调度 |
| Pi 和远程工具闭环 | Job `a8a081ff-5c9a-4b90-8165-3bc118cde44b` 经 UI 创建，offline 时等待，worker 重连后执行 read、README write、138,000 字节 large write 和 bash，最终 succeeded；四个 call 按 1–4 序号完成且远端 ledger 均标为 acked |
| 未选 workspace 不变 | `[redacted-home]/workspace/worker-plane-p2/workspaces/other/marker.txt` 保持 `DO NOT MODIFY`，SHA-256 `08e3dfc089e66c44ae8abd3476b0f810f11f4cfc2ab925f1607c7df21345d639` |
| 64 KiB 帧分块 | `apps/server/test/execution.test.ts` 用 100 KB write 验证每帧 ≤ 65,536 字节；真实 linux-test-worker 写入 138,000 字节，worker 校验传输 SHA-256，远程 `wc -c` 与 bash 校验通过 |
| Pi/SQLite 与协议回归 | Pi spike 80 项、协议 3 项、Rust worker 5 项、服务端 14 项通过；Linux x86_64 远端 Rust 1.93.1 `cargo build --locked --release` 与 `cargo test --locked` 通过 |
| 浏览器证据 | 等待 worker 上线（原始截图仅本地保留，见 output/playwright/README.md）、远程任务完成（原始截图仅本地保留，见 output/playwright/README.md） |

## 边界

P2 提供受控单 worker 演示能力。当前 worker 进程组取消、完整重启对账、跨进程未决调用恢复、预算、日志分块补读和人工处置仍按 P3/P4 验收；本阶段未安装常驻服务，也未配置公网域名。
