# P7 部署、运维与发布验收

日期：2026-10-09。P7 分三步交付，本文随每步更新。阶段验收标准见 [开发阶段](development-plan.md#p7部署运维与发布验收)，设计依据见 [架构](architecture.md)。

| 步骤 | 内容 | 状态 |
|---|---|---|
| P7-A | 主节点运维语义：配置校验、调度暂停、在线备份与恢复、升级快照、token 列表与轮换、保留策略与磁盘检查、worker 优雅停止、认证与隔离测试 | 完成 |
| P7-B | 打包与部署产物：release 构建、systemd/launchd、生产 Caddy、运维 runbook | 完成 |
| P7-C | 发布验收：从产物安装的端到端测试、真实环境向导、总验收 | 进行中：自动化部分完成，真实环境待运行，见 [总验收](#总验收) |

已定决策：

- 主节点部署在单台 Linux 主机。Caddy 用内部 CA，worker 通过 `SSL_CERT_FILE` 信任这个 CA，不需要公网域名。
- 先完成本机和 CI 两个平台上能验证的部分。真实双机和真实模型联调由向导带用户完成，机器准备好后再跑。
- worker 二进制由打 tag 触发的 CI 在两台 self-hosted runner 上构建，附到 GitHub Release。

## P7-A：主节点运维语义

### 数据（`migrations/012_p7_ops.sql`）

- 新表 `dispatch_state`（单行）：`paused`、`reason`（`restored`、`disk_low`、`operator`）、`note`、`since`。更新时触发 `dispatch` 事件，UI 实时显示。
- `call_log_state` 新增 `pruned_at`：保留策略删掉输出分块后，状态行保留并记下时间，缺口有原因可查。
- 迁移计数现在是 12。

### 配置（`apps/server/src/config.ts`）

- 主节点的环境变量集中在 `loadConfig` 里读取和校验，启动时一次报告所有问题，消息里不出现密钥值。
- 非脚本模式下缺少 `MODEL_API_KEY`（或 `OPENROUTER_API_KEY`）直接拒绝启动，不再等到第一个任务运行时才失败。
- 新变量：`MAIN_RETENTION_DAYS`（默认 30）、`MAIN_MIN_FREE_BYTES`（默认 1 GiB）。
- `dataDir` 和模型配置显式传给 `createApp`，执行模块不再自己读 `DATA_DIR` 和模型变量。

### 调度暂停（`apps/server/src/app.ts`、`execution.ts`）

- 暂停期间 `pump` 和 `pumpMain` 不启动、不恢复任何任务。已在运行的执行照常结束。worker 照常注册、对账，ACK、取消和 resolve 也照常发送。
- `/health` 返回 `{ alive, scheduling_ready, dispatch_paused, phase: "P7" }`。暂停时 `scheduling_ready` 为 false，`dispatch_paused` 是原因。
- `POST /api/ops/pause`、`POST /api/ops/resume` 都要求填写说明，`GET /api/ops/dispatch` 读取当前状态。恢复会写一条 `dispatch_resumed` 审计事件，然后推进所有队列。
- 因恢复备份而暂停时，所有已知 worker 都要在本次启动后完成对账才能恢复，否则返回 409 `workers_not_reconciled`。连不上的机器可以用 `force: true` 加说明跳过，审计事件会记下未对账的机器。
- 因磁盘不足而暂停时，手动恢复返回 409。空间恢复后由维护任务自动解除，它只解除自己设下的暂停。
- UI 在页面顶部显示暂停横幅和原因。恢复需要填写说明；从备份恢复后，有未对账的机器时按钮不可用。

### 备份、恢复与升级（`apps/server/src/ops.ts`、`admin.ts`）

`worker-plane-admin`（`pnpm --filter @worker-plane/server admin <命令>`，或 `node dist/admin.js`）：

| 命令 | 作用 |
|---|---|
| `backup <dest>` | 用 SQLite backup API 在线备份，主节点不停。备份后做完整性检查，文件权限 0600 |
| `verify <file>` | 完整性检查，并报告恢复依赖的计数：未结清调用、调用序号水位、队列水位、等待子任务的父任务、未结束的子任务 |
| `restore <file>` | 要求主节点已停止（检查 `main.lock`）。先在旁边的临时文件里生成恢复后的库，执行迁移并写入 `paused=1, reason='restored'`；任何一步失败，现有库都不受影响。成功后，现有库和遗留的 `-wal`、`-shm` 各自改名放在旁边（不删除），再把临时文件换到原位 |

- Pi 会话目录 `pi-sessions/` 不需要备份：每次运行都从 SQLite 里的 transcript 重建。
- 升级：`openDatabase` 发现有待执行的迁移时，先用 `VACUUM INTO` 把当前库复制到 `pre-migrate-<最后版本>-<时间>.sqlite`，再迁移。新库没有可保留的内容，不复制。
- 从备份恢复后的行为（测试 `p7-ops.test.ts` 第 2 条）：
  - 备份里处于 `dispatched` 的调用，在恢复调度前不会重发。
  - 恢复调度后，worker 账本对重发的调用直接返回已保存的结果，命令不会再执行一次。
  - 备份之后才执行的任务不在主库里，也不会被重新派发。
  - worker 账本报告的调用如果和主库矛盾，仍按 P3 的 `ledger_contradiction` 阻塞机器。

### token 管理

- `GET /api/worker-tokens` 按公开 ID（摘要前 16 位十六进制）列出 token：worker、吊销时间、是否正被当前连接使用。不返回 token 本身，也不返回摘要。
- `POST /api/worker-tokens` 的返回里增加 `token_id`。吊销可以传 `token_id`，原来传明文 `token` 的方式保留。
- 轮换流程：签发新 token → 写入 worker 的 `token_file` → 按 ID 吊销旧 token。服务端以 1008 关闭旧连接，worker 重连时重读文件，用新 token 注册、对账后继续工作，进程不重启。

### 保留与磁盘（维护任务，启动时运行一次，之后每小时一次）

- 删除过期的登录会话。
- 终态任务的调用结束超过保留期后，删除输出分块，并在 `call_log_state` 上标记 `pruned_at`。提交给模型的结果在 `runtime_calls.result_json` 里，不受影响。
- 删除 `pi-sessions/<session>`，条件是该会话的所有任务都已结束，并且都早于保留期开始。
- 数据目录剩余空间低于 `MAIN_MIN_FREE_BYTES` 时以 `disk_low` 暂停调度。启动时先做这项检查，再执行恢复，所以磁盘已满时恢复流程不会启动任何任务。

### worker 优雅停止（`worker/src/main.rs`）

- SIGTERM 与 SIGINT 走同一条停止路径：通过取消路径停止正在运行的命令，等结果写入账本后以 0 退出。这样 systemd 和 launchd 的停止不会留下孤立的进程组。
- 现有测试里对 worker 发 SIGTERM 的地方，现在走的就是这条优雅停止路径。

### 验证（`apps/server/test/p7-ops.test.ts`）

1. 暂停时有可用的 worker，worker 任务和 Main 任务也都停在 `queued`，side effect 为 0。健康检查显示未就绪，快照带有暂停原因。填写说明后恢复，两个任务都完成，并写入审计事件。
2. 在调用执行途中做在线备份，备份里该调用为 `dispatched`。之后再跑一个备份不知道的任务。停机并恢复：
   - 持有 `main.lock` 时拒绝恢复；
   - 启动后处于 `restored` 暂停，worker 对账前拒绝恢复调度，对账后到恢复调度前也不重发；
   - 恢复调度后调用以 `completed` 结束，两个任务的 marker 都只有一行。
   - 停止 worker 前先读它的账本，确认要测的状态已经落盘。第二个用例丢掉 `after-1` 的 ACK，让 worker 账本保留一个已完成但未确认、而备份里没有的调用：恢复后 worker 以 `ledger_contradiction` 阻塞，`slow-1` 不再发送，新任务不执行，所有 marker 不变。

   CI 上这条测试最初偶发超时。诊断输出显示，SIGKILL 有时在 worker 记下 `after-1` 的 ACK 之前到达，于是出现了第二种情况。这是预期的安全行为，原测试错误地假设 ACK 已经落盘，因此拆成了两个确定的用例。
3. 用 011 版本的库构造未结清调用、调用序号水位、队列水位和父子等待。升级后各项计数不变，留下一份 011 的快照；再次打开不再复制。
4. 用 `token_file` 启动 worker，签发第二个 token 写入文件，按 ID 吊销第一个。worker 不退出，用新 token 重连，列表正确，之后的任务能执行。
5. 保留期设为 0：输出分块被删、日志接口显示 `pruned_at` 和缺口，提交的结果仍在，Pi 会话目录和过期登录被清理。模拟磁盘不足时暂停，手动恢复被拒，空间恢复后自动恢复，新任务完成。
6. 命令执行中对 worker 发 SIGTERM：worker 以 0 退出，命令的子进程也已结束。重启后调用以 `completed` 结束。
7. 遍历所有已注册路由：除 `/health`、`/auth/login`、`/auth/session`、`/ws/worker` 外，未登录一律 401；`/ws/worker` 没有 worker token 也是 401。
8. `ROLE_TOOLS.main` 恰好是 `list_workers`、`delegate`、`get_job`。脚本让 Main 调用 `bash` 时，没有任何 `tool_call` 发到 worker，side effect 为 0。
9. worker 源码和 `Cargo.toml` 不含任何模型客户端、模型密钥或模型变量。
10. 恢复一个无法迁移的备份时失败，现有库原样保留，也不留下临时文件。只剩 `-wal` 没有主库时（改名中途崩溃），这个 WAL 也会被移开。
11. 磁盘已满时重启，恢复流程不会启动排队中的 Main 任务，调度以 `disk_low` 暂停。去掉这个修复后此测试失败。

另外：`health.test.ts` 更新为新的返回结构，`identity.test.ts` 的迁移计数改为 12，web 的 `feed.test.ts` 增加暂停状态的快照和事件测试。

浏览器检查：在走查环境（`test/support/walkthrough.ts`）里通过 API 暂停调度，页面显示暂停横幅和说明。在横幅里填写说明并点"恢复调度"后，横幅随 `dispatch` 事件消失；再次通过 API 暂停，横幅不刷新页面就出现。web 的 SSE 订阅加上了 `dispatch` 这一类事件。

测试：server 98、web 7、protocol 3 项全部通过。

## P7-B：打包与部署产物

### 主节点产物（`deploy/build-main.sh`、`deploy/smoke-main.sh`）

- `build-main.sh <目录>` 生成一个独立于仓库的发布目录：
  - `apps/server`：编译结果、生产依赖和 `package.json`，由 `pnpm deploy --prod` 生成；
  - `apps/web/dist`；
  - `migrations`：按 `apps/server/dist` 的相对位置查找，所以目录结构和仓库保持一致；
  - `deploy`：Caddy、systemd 模板和示例配置；
  - `REVISION`：构建所用的 commit。
- `better-sqlite3`、`argon2` 是原生模块，所以主节点产物要在和目标主机相同的 OS、架构和 Node 主版本上构建。release 只构建 Linux 版本。
- `apps/server` 和 `packages/protocol` 加了 `files: ["dist"]`，这样 `pnpm deploy` 只带编译结果。`apps/server` 增加了 `start` 和 `admin` 两个脚本。
- `smoke-main.sh <目录>` 按 systemd 单元的方式（`node dist/main.js`）启动发布目录，然后依次检查：
  1. `/health` 就绪且没有暂停；
  2. 在线备份和 verify 都通过；
  3. SIGTERM 后以 0 退出，并释放 `main.lock`。

### worker 二进制

- `worker/Cargo.toml` 增加 `[profile.release]`（`lto`、`codegen-units = 1`、`strip`）。本机 arm64 macOS 的 release 二进制为 6.7 MB，只依赖系统库（Security、CoreFoundation、libiconv、libSystem）。SQLite 是静态链接的，TLS 用 rustls，不依赖系统 OpenSSL。
- 新配置项 `command_path`：命令的 PATH，默认值仍是 `/usr/local/bin:/usr/bin:/bin`，每一项都必须是绝对路径。在 Apple Silicon 上用它加入 `/opt/homebrew/bin`。worker 自己的环境变量照旧不会传给命令。

### CI 与 release

- `p1.yml`：`pnpm build` 之后，在两个平台上从 release 目录启动主节点并跑一遍 smoke，再构建 worker 的 release 二进制。
- 新增 `release.yml`：推送 `v*` tag 时触发。
  - 在 macOS 和 Linux 两台 self-hosted runner 上各自原生构建 `worker-plane-worker-<tag>-<os>-<arch>`。
  - Linux runner 额外构建并 smoke `worker-plane-main-<tag>-linux-<arch>-node24.tar.gz`。
  - 每个文件附带 `.sha256`。
  - 最后用 `gh` 建一个 **draft** release，人工检查后再发布。publish 这一步要求 Linux runner 上装有 `gh`。

### 部署模板（`deploy/`）

| 文件 | 要点 |
|---|---|
| `Caddyfile.production` | 内部 CA（`tls internal`）。`/api`、`/auth`、`/ws/worker`、`/health` 转发给主节点，其余路径提供 UI。`flush_interval -1` 让 SSE 不经缓冲；`stream_close_delay 5m` 让配置重载时不会一次断开所有 worker。站点地址和发布目录通过环境变量 `WORKER_PLANE_SITE`、`WORKER_PLANE_ROOT` 指定 |
| `systemd/worker-plane-main.service` | 专用用户；`EnvironmentFile` 权限 0600；`ProtectSystem=strict`，只有数据目录可写。`Restart=no`：崩溃后 `main.lock` 会故意留下，需要人工确认后删除（运维手册 §10） |
| `systemd/worker-plane-worker.service` | 停止信号 SIGTERM，等待 60 s，大于 `kill_grace_secs + 7`；`KillMode=control-group`；`StartLimitBurst=5`，避免被吊销的 token 导致无限重启 |
| `systemd/worker-plane-backup.{service,timer}` | 每天在线备份一次，删除 14 天前的备份 |
| `launchd/com.workerplane.worker.plist` | LaunchDaemon，`KeepAlive` 只在非正常退出时重启，`ThrottleInterval` 60 s，`ExitTimeOut` 60 s；日志写入文件，由 `worker-plane.newsyslog.conf` 轮转 |
| `main.env.example`、`worker.config.toml` | 生产配置示例：worker 使用 `token_file`，`data_dir` 放在持久目录 |

### 文档

- 新增 [运维手册](operations.md)，内容包括：
  - 组成和目录；
  - 安装主节点和 Caddy、分发 CA；
  - 签发 token（密码从终端读取，token 直接写进文件）；
  - 安装两个平台的 worker；
  - 监控；
  - 升级与回滚；
  - 备份和恢复；
  - token 轮换；
  - 主节点异常退出后处理 `main.lock`；
  - 保留策略；
  - 故障排查表。
- 修正过时的说明：
  - `p1-development.md` 里"连接断开后退出"的描述；
  - `architecture.md` 里 `token_file` 标着"待核实"，命令 PATH 也写成固定值。
- `resources-and-todos.md` 的配置模板改成实际使用的变量名，"域名与证书"一项改为已决定（内部 CA）。

### 验证

- `apps/server/test/p7-deploy.test.ts`：`command_path` 含相对路径时 worker 拒绝启动（退出码 1，有错误说明）；改用一个额外目录后，命令能调用该目录里的工具，并且命令看到的 PATH 和配置完全一致。
- 本机：`deploy/build-main.sh <临时目录> --skip-build` 后跑 `deploy/smoke-main.sh`，健康检查、备份和停止三步都通过。`cargo build --release` 通过。`plutil -lint` 检查 plist 通过。
- 本机没有装 Caddy 和 systemd，所以 Caddyfile 和 systemd 单元还没有经过 `caddy validate` 和 `systemd-analyze verify`；它们在 P7-C 的安装验收里实际运行。release workflow 要推一个 tag 才会运行，在 P7-C 里征得同意后验证。

## P7-C：发布验收

### 从产物安装的端到端测试（`apps/server/release-test/release.test.ts`）

- 被测对象只有发布产物：`WP_RELEASE_DIR` 指向 `deploy/build-main.sh` 生成的目录，`WP_WORKER_BIN` 指向 release 版 worker 二进制。源码树只提供测试本身和测试证书。
- 安装方式与运维手册一致：
  - 主节点用 `node dist/main.js` 启动，第一次启动带 `INITIAL_ADMIN_PASSWORD`；
  - 通过 API 签发 token，写进 0600 的 `token_file`；
  - worker 的环境里没有 token，`SSL_CERT_FILE` 只指向部署用的 CA；
  - 两个进程都用 SIGTERM 停止。
- 用 `pnpm --filter @worker-plane/server test:release` 运行，依次检查：
  1. 安装、登录、签发 token、注册；
  2. 执行；
  3. 超时：1 秒的时间限制终止了 30 秒的 sleep，后续命令没有执行；
  4. 取消：被取消命令的进程已经不存在；
  5. worker 重启（SIGTERM）后恢复；
  6. 主节点重启：停机时排队的任务在重启后只执行一次，SIGTERM 释放了 `main.lock`；
  7. 用 release 里的 `admin.js` 在线备份；
  8. 设置 `CADDY_BIN` 时：把 release 里未改动的 `Caddyfile.production`（内部 CA）放在主节点前面，`/health`、UI 和前端路由回退都经过 Caddy。SSE 和 worker 的 WSS 连续保持 `WP_LONG_SECS`（默认 75 秒），期间心跳经 Caddy 到达，worker 的连接 epoch 不变，之后的任务和事件照常通过。
- 本机结果（macOS arm64，Node 22，Caddy 2.11.7）：9/9 通过，包括经 Caddy 的 75 秒长连接。

### 这一步发现并修复的问题

- **主节点在 SIGTERM 下可能直接被杀，`main.lock` 留在原地。**
  - 原因：Pi SDK 依赖的 `proper-lockfile` 会装入 `signal-exit` 3.0.7。原来的处理函数用 `process.once` 注册，触发时会先移除自己；`signal-exit` 随后发现没有其他监听者，就把信号重新发给进程。
  - 后果：只要有任务运行过，`systemctl stop` 就会让下次启动因为锁存在而被拒绝。
  - 修复：`main.ts` 改用 `process.on`，并让关闭流程只执行一次。
  - 回归测试：`p7-deploy.test.ts` 里先让主进程跑完一个任务再发 SIGTERM，断言以 0 退出且锁已释放。去掉修复后这个测试失败。
- **`deploy/Caddyfile.production` 补了两项全局设置。**
  - `skip_install_trust`：根证书由人工分发，不尝试写入主机的信任库。
  - `admin {$CADDY_ADMIN:localhost:2019}`：可以通过环境变量改 admin 地址。
  - 改完后的文件通过 `caddy validate` 和 `caddy fmt` 检查。

### 真实环境向导（`deploy/acceptance-wizard.sh`）

- 在运维人员的电脑上运行，共 16 步：
  1. 准备机器和地址；
  2. 下载并校验产物；
  3. 安装主节点；
  4. 配置 Caddy 和内部 CA，并自动检查 `/health`；
  5. 浏览器信任证书并登录；
  6. 签发 token；
  7. 安装 Linux worker，并自动检查可执行状态；
  8. 安装 macOS worker，并自动检查可执行状态；
  9. Linux worker：执行、超时、取消、重启；
  10. macOS worker：执行、超时、取消、重启；
  11. 主节点重启恢复；
  12. 经 Caddy 保持 10 分钟，自动比较连接 epoch；
  13. token 轮换，自动检查；
  14. 真实模型双机委派：是否同一轮委派、是否带 verify、最终结果；
  15. 备份和恢复演练；
  16. 汇总。
- 结果写在 `~/.worker-plane-acceptance/results.env`，不在仓库里。
- 模型 key 和管理员初始密码只在主机上输入。向导自己用到的管理员密码是隐藏输入，用完就丢弃。token 只写入本机 0600 文件，装好 worker 后删除。

### 总验收

自动化环境：macOS arm64（本机），Node 22.22.3，Caddy 2.11.7，release 版 worker。CI 在 self-hosted macOS 和 Linux 上跑全量测试和产物 smoke。

| # | 验收标准 | 证据 | 结果 |
|---|---|---|---|
| 1 | 两个平台从干净机器按文档安装，注册、执行、超时、取消和重启恢复通过 | 发布产物端到端测试第 1–6 项：本机 macOS 通过 | macOS 通过；Linux 待 CI 接入、待真实环境（向导第 7–10 步） |
| 2 | 主节点常驻，WSS/SSE 经 Caddy 长连接可用；健康检查区分存活与调度就绪 | 端到端测试第 8 项（经生产 Caddyfile 保持 75 秒）；`health.test.ts`；`p7-ops` 第 1 条 | 本机通过；10 分钟真实环境待运行（向导第 12 步） |
| 3 | 在线备份和迁移可验证；升级不丢失未确认调用、去重水位和父子等待关系 | `p7-ops`：在线备份（第 2 条）、从 011 升级（第 3 条）；端到端测试第 7 项 | 通过 |
| 4 | 恢复旧备份先停止自动调度并核对 worker 账本，不因主库缺少记录启动重复执行 | `p7-ops`：执行途中备份后恢复，分 worker 已确认和未确认两种情况；恢复不覆盖现有库；磁盘不足时启动即暂停 | 通过；恢复演练待真实环境（向导第 15 步） |
| 5 | token 撤销、更新 token 后对账、数据目录锁、磁盘预算与日志保留在部署环境生效 | `p7-ops`：token 轮换、保留与磁盘；`p7-deploy`：SIGTERM 后释放锁；端到端测试第 6 项；`wss.test.ts`：目录锁与吊销 | 通过；部署环境的轮换待运行（向导第 13 步） |
| 6 | worker 无模型进程/密钥；主节点 runtime 无本地执行工具；所有公开入口通过认证 | `p7-ops` 第 7–9 条 | 通过 |
| 7 | Spec v2 对照表全部通过，故障场景不以 happy-path 代替 | 下表 | 见下表 |

| Spec v2 | 内容 | 证据 | 结果 |
|---|---|---|---|
| 1 | 双 worker、离线队列、token 撤销 | `wss.test.ts`（两个真实 worker、吊销）、P2 离线排队、`p7-ops` 轮换 | 通过；真实双机待运行 |
| 2 | 指定目标执行与拒绝误路由 | [P2](p2-development.md)、`p2.test.ts` | 通过 |
| 3 | remote 规范化、多 workspace | [P1](p1-development.md)、[P2](p2-development.md) | 通过 |
| 4 | 成功后依赖委派、失败阻止 | `p5-wait.test.ts`、`p5-delegate.test.ts` | 脚本模型通过；真实模型待运行（向导第 14 步） |
| 5 | 子会话隔离、追问与固定目标 | [P5](p5-development.md)、`p6-conversation.test.ts` | 通过 |
| 6 | 用户与委派共同 FIFO、每机串行 | [P2](p2-development.md)、[P5](p5-development.md) | 通过 |
| 7 | 结果丢失后副作用不重复 | `worker-ledger.test.ts`、`p3-faults.test.ts` | 通过 |
| 8 | 调用/ACK/结果/取消重复帧 | `p3-faults.test.ts`、`p4-faults.test.ts` | 通过 |
| 9 | worker 重启不确定状态阻塞 | `p3-recovery.test.ts` | 通过 |
| 10 | 主节点各提交窗口恢复 | `p3-main-process.test.ts`、`p5-faults.test.ts` | 通过 |
| 11 | 全状态取消并确认旧执行结束 | `p4-control.test.ts`、`p5-wait.test.ts`、端到端测试第 4 项 | 通过 |
| 12 | 大输出、超时与进程终止核查 | `worker-process.test.ts`（P4-A）、`p4-output.test.ts`、端到端测试第 3 项 | 通过 |
| 13 | 新连接替换、先对账再派发 | `wss.test.ts`、`p3-recovery.test.ts` | 通过 |
| 14 | 模型/工具隔离与认证 | P0 spike、`p7-ops` 第 7–9 条 | 通过 |

全部自动化测试在本机通过：server 105、web 7、protocol 3，另有 release 端到端测试 9/9。发布条件：上表中"待运行"的各项通过向导完成，Linux 平台的端到端测试接入 CI 并通过，然后打 `v0.1.0`。
