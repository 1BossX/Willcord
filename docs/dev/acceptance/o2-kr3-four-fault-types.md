# O2-KR3 四类故障验收（厚轨）

> 开发内部文档：记录 **O2-KR3** 厚轨验收路径与自动化证据。OKR 原文见项目 OKR；机制说明见 [P3](../../p3-development.md)、[P4](../../p4-development.md)、[P6](../../p6-development.md) 与 [运维手册 §10](../../operations.md)。

## KR 与验收标准

**O2-KR3** — 四类故障验收通过：断线、主节点重启、取消、结果丢失。不得盲目重跑；不确定状态须展示依据并允许人工处理。

| 原则 | 含义 | 验收方式 |
|---|---|---|
| 不盲目重跑 | 已接受或可能已执行的调用不因重连、重启或重复帧而再次执行 | `marker.log` 行数、账本对账、故障程序用例 |
| 不确定须有据 | `needs_attention`、worker `blocked`、调用 `unknown` 与 `attention_actions` 记录原因 | API `/api/attention`、事件流、集成测试断言 |
| 人工可处理 | 放弃任务、填写依据、按调用解析、解除阻塞、新 ID 重试 | `p4-control`、`p6-faults`、控制台「需要核对」 |

本 PR **不**修改：诊断模式 argv 上限、批准具体动作流程、文档版本号、Compose 已发布端口绑定。主节点崩溃后的 `main.lock` 仍由运维按文档手工清除（见下文「主节点重启 · Compose」）。

## 自动化命令

在仓库根目录，与 CI `P1 foundations` 一致：

```bash
cargo build --locked --manifest-path worker/Cargo.toml --features fault-injection --target-dir worker/target/fault
pnpm test
python3 deploy/test-o2-kr3-acceptance.py
```

Docker 镜像路径（含 `restart: "no"` 与崩溃后锁）：

```bash
deploy/docker/smoke.sh    # 含 SIGTERM 释放锁、SIGKILL 留锁与人工清除后恢复
```

## 1. 断线（disconnection）

WSS 在帧传输中途断开；重连后**先对账**，再补发或观察缓存结果，副作用至多一次。

| 场景 | 预期 | 证据（测试） |
|---|---|---|
| `tool_call` 丢失 | 重连后按原 `call_id` 重发一次 | `p3-faults.test.ts`（lose-1） |
| `tool_accepted` 丢失 | worker 返回缓存结果，不重新执行 | `p3-faults.test.ts`、`worker-ledger.test.ts` |
| `tool_result` 丢失 | 结果重传并提交，工具消息一条 | `p3-faults.test.ts` |
| `tool_ack` 丢失 | 对账后重发 ACK，不重复工具消息 | `p3-faults.test.ts`、`p3-main-process.test.ts`（`after_result_commit`） |
| 断线期间新任务 | 阻塞 worker 上后续任务 `waiting_worker` | `p3-faults.test.ts` worker SIGKILL 窗口 |

## 2. 主节点重启（main node restart）

主节点进程 SIGKILL 或宿主机异常退出后，**仅从 SQLite 恢复**；不重新向模型请求同一工具轮次，不重复 worker 副作用。数据目录锁在非正常退出后**故意保留**，第二个实例启动被拒绝，直到运维确认旧进程已消失并删除锁。

### 进程内故障程序

| 崩溃点 | 恢复后 job 终态 | 副作用次数 | 证据 |
|---|---|---|---|
| `before_dispatch` / `after_dispatch` / `after_result_commit` | `succeeded`（已提交结果从库恢复） | 1 | `p3-main-process.test.ts` |
| `after_cancel_commit` | 取消帧在重启后发出，不恢复推理 | 见用例 | `p4-faults.test.ts` |
| `after_delegate_commit` / `after_advance_commit` | 子任务不重复、命令不二次执行 | 1 | `p5-faults.test.ts`（Linux 上 `after_advance_commit` 偶发 `ECONNRESET`，[#69](https://github.com/BossOptional/Willcord/issues/69)，本验收不阻塞） |

锁行为：

| 步骤 | 预期 | 证据 |
|---|---|---|
| SIGKILL 后再次启动同一数据目录 | 拒绝，`EEXIST` / `main.lock` | `p3-main-process.test.ts`、`lock.test.ts` |
| 运维删除 `main.lock` 后启动 | 从 SQLite 恢复，进行中任务继续或进入需要核对 | 上表 + `p3-main-process.test.ts` |
| SIGTERM 正常停止 | 释放锁 | `p3-main-process.test.ts`、`deploy/smoke-main.sh` |

### 主节点重启 · Compose（`restart: "no"` 与崩溃锁）

与 [docker.md §停止与异常退出](../../docker.md#停止与异常退出)、[运维手册 §10](../../operations.md#10-主节点异常退出后) 一致：

| 步骤 | 预期 | 证据 |
|---|---|---|
| `docker compose stop main`（SIGTERM） | 退出码 0，`main.lock` 已删除 | `deploy/docker/smoke.sh` |
| `docker kill -s SIGKILL` 主节点容器 | 容器 **不会** 被自动拉起（`restart: "no"`） | `deploy/docker/smoke.sh` |
| 锁仍存在时 `docker compose start main` | 主进程启动失败（非 0），**不得**在锁未清除时对外服务 | `deploy/docker/smoke.sh` |
| 按文档查看 `owner.json` 并删除 `main.lock` 后 `docker compose start main` | `/health` 再次 `scheduling_ready` | `deploy/docker/smoke.sh` |

运维手工步骤（验收走查时可照抄，与生产一致）：

```bash
docker compose ps -a main
docker compose run --rm --no-deps -T main cat /var/lib/willcord/main.lock/owner.json
docker compose run --rm --no-deps -T main node -e "require('fs').rmSync('/var/lib/willcord/main.lock',{recursive:true})"
docker compose start main
```

## 3. 取消（cancellation）

取消与完成竞争、离线取消、worker 在取消路径上崩溃；不得以 `cancel_ack`  alone 证明已停止。

| 场景 | 预期 | 证据 |
|---|---|---|
| queued 取消 | 无 `runtime_calls`，直接 `cancelled` | `p4-control.test.ts` |
| 运行中取消，worker 在 `after_cancel_recorded` / `after_term_sent` 崩溃 | `unknown` → `needs_attention`，旧进程组不被陈旧 PGID 误杀 | `p4-faults.test.ts` |
| 主节点在 `after_cancel_commit` 崩溃 | 重启后发出 `cancel_call`，不恢复推理 | `p4-faults.test.ts` |
| 放弃任务 + 依据 + 解除阻塞 | `abandon` 不解除 `blocked`；`unblock` 须覆盖每个 unknown 调用 | `p4-control.test.ts`、`p6-faults.test.ts` |
| 父任务取消与子任务执行不明 | 父任务不宣称安全取消 | `p5-faults.test.ts` |

## 4. 结果丢失（lost results）

不得以「账本无记录」证明未执行；已落库结果在 worker 重启后应返回原结果。

| 场景 | 预期 | 证据 |
|---|---|---|
| worker 在 accepted/running/effect 窗口 SIGKILL | `needs_attention`，不重跑，worker `blocked` | `p3-faults.test.ts` |
| worker 在 `after_result_persisted` SIGKILL | 重连后返回原结果，job `succeeded` | `p3-faults.test.ts` |
| worker 账本目录丢失或 `ledger_id` 变化 | `blocked`，不向新账本重发在途调用 | `p3-faults.test.ts`（lost-1） |
| 主节点结果已提交但 worker 未收到 ACK | 重启后重发 ACK | `p3-main-process.test.ts` |

## 人工处理 API（验收抽查）

| 操作 | 方法 | 说明 |
|---|---|---|
| 查看待核对 | `GET /api/attention` | jobs + blocked workers + 近期 actions |
| 放弃任务 | `POST /api/jobs/:id/abandon` | 不解除 worker 阻塞 |
| 解除阻塞 | `POST /api/workers/:id/unblock` | 须 `evidence` 与每个 unknown 调用的 `resolutions` |
| 新 ID 重试 | `POST /api/jobs/:id/retry` | 生成新 job，不复活原执行 |

控制台：任务「需要核对」、worker「需要核对」与 SSE 事件与 SQLite 一致（`p6-faults.test.ts`）。

## 记录模板

每次厚轨验收通过后记录：git tip SHA、`pnpm test` 计数、平台（macOS / Linux）、`deploy/docker/smoke.sh` 是否在本机跑过、mmg-bo PASS 日期。
