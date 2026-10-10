# 运维手册

适用版本：P7 起。本文给出主节点和 worker 的安装、升级、备份恢复、token 轮换和故障处理步骤。设计依据见 [架构 §13](architecture.md#13-部署与运维)，各项行为的测试证据见 [P7 开发记录](p7-development.md)。

文中路径是建议值，和 `deploy/` 下的模板一致。改动路径时，单元文件、配置和命令要一起改。任何密钥（模型 key、管理员密码、worker token）都不要写进仓库、聊天或命令行参数。

新节点优先使用 [简化安装与授权流程](worker-onboarding.md)，下文保留手动配置部署方式。

## 1. 组成

| 部件 | 运行在 | 产物 | 由谁管理 |
|---|---|---|---|
| 主节点（Node 24） | 一台常驻 Linux 主机 | `worker-plane-main-<版本>-linux-<arch>-node24.tar.gz` | systemd：`worker-plane-main.service` |
| Caddy（TLS、WSS、SSE、静态 UI） | 同一台主机 | 系统包 | Caddy 自己的 systemd 单元 |
| worker（Rust 单文件） | 每台 Linux/macOS 机器 | `worker-plane-worker-<版本>-<os>-<arch>` | Linux：systemd；macOS：launchd |
| 每日备份 | 主节点主机 | 主节点产物里的 `admin.js` | `worker-plane-backup.timer` |

主节点主机上的目录：

| 路径 | 内容 | 权限 |
|---|---|---|
| `/opt/worker-plane/releases/<版本>/` | 解开的主节点产物 | root，只读 |
| `/opt/worker-plane/current` | 指向当前版本的符号链接 | root |
| `/etc/worker-plane/main.env` | 环境变量和密钥 | root:root 0600 |
| `/var/lib/worker-plane/` | `DATA_DIR`：`main.sqlite`（WAL）、`main.lock`、`pi-sessions/`、迁移前快照 | worker-plane 0700 |
| `/var/backups/worker-plane/` | 备份 | worker-plane 0700 |

worker 机器上的目录（macOS 用 `/usr/local/etc/worker-plane/` 代替 `/etc/worker-plane/`）：

| 路径 | 内容 | 权限 |
|---|---|---|
| `/usr/local/bin/worker-plane-worker` | 二进制 | root，0755 |
| `/etc/worker-plane/worker.toml` | 配置 | worker 用户，0600 |
| `/etc/worker-plane/token` | worker token | worker 用户，0600 |
| `/etc/worker-plane/ca.pem` | 主节点内部 CA 根证书 | 0644 |
| `data_dir`（例如 `/var/lib/worker-plane-worker`） | 账本、输出日志、数据目录锁 | worker 用户，0700 |

## 2. 安装主节点（Linux）

前提：Node 24（`node --version` 显示 v24.x）、Caddy 2、`curl`。产物里的原生模块按 Node 24 和 runner 的架构构建，主机必须是同一架构。

```bash
sudo useradd --system --home /var/lib/worker-plane --shell /usr/sbin/nologin worker-plane
sudo install -d -m 0755 /opt/worker-plane/releases
sudo install -d -o worker-plane -g worker-plane -m 0700 /var/backups/worker-plane
sudo install -d -m 0755 /etc/worker-plane
```

1. 从 GitHub Release 下载主节点产物和它的 `.sha256`，校验后解开：

   ```bash
   shasum -a 256 -c worker-plane-main-v0.1.0-linux-x86_64-node24.tar.gz.sha256
   sudo tar -C /opt/worker-plane/releases -xzf worker-plane-main-v0.1.0-linux-x86_64-node24.tar.gz
   sudo ln -sfn /opt/worker-plane/releases/worker-plane-main-v0.1.0 /opt/worker-plane/current
   ```

   也可以在同架构的 Linux 机器上从源码构建：`deploy/build-main.sh <目录>`。

2. 写环境文件：复制 `deploy/main.env.example` 到 `/etc/worker-plane/main.env`，权限设为 0600，用编辑器填入值。
   - `PUBLIC_BASE_URL` 必须和浏览器地址栏里的源完全一致（协议、主机、端口），登录和 CSRF 检查都和它比较。
   - `MODEL_API_KEY` 缺失时主节点拒绝启动。
   - `INITIAL_ADMIN_PASSWORD` 只在第一次启动时需要，至少 16 个字符。

3. 安装并启动服务：

   ```bash
   sudo cp /opt/worker-plane/current/deploy/systemd/worker-plane-main.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now worker-plane-main
   curl -s http://127.0.0.1:3000/health
   ```

   预期返回 `{"alive":true,"scheduling_ready":true,"dispatch_paused":null,"phase":"P7"}`。启动失败时看 `journalctl -u worker-plane-main`，配置问题会一次全部列出。

4. 第一次启动成功后，从 `main.env` 删掉 `INITIAL_ADMIN_PASSWORD` 这一行。管理员密码只以 Argon2id 散列的形式存在数据库里。

5. 配置 Caddy：
   - 把 `deploy/Caddyfile.production` 的内容放进 `/etc/caddy/Caddyfile`。
   - 用 `sudo systemctl edit caddy` 加两行环境变量：
     - `Environment=WORKER_PLANE_SITE=plane.internal:8443`
     - `Environment=WORKER_PLANE_ROOT=/opt/worker-plane/current`
   - 执行 `sudo systemctl restart caddy`。
   - `WORKER_PLANE_SITE` 可以是主机名或 IP，worker 和浏览器都用这个地址访问。

6. 分发内部 CA：Caddy 第一次签发证书后，根证书在它的数据目录里。用系统包安装时一般是 `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`。
   - 把这个文件复制到每台 worker 的 `ca.pem`。它是公开证书，不是密钥。
   - 浏览器所在的机器也要信任这个根证书，否则无法登录。
   - 在 worker 上用 `curl --cacert ca.pem https://plane.internal:8443/health` 验证。

7. 启用每日备份：

   ```bash
   sudo cp /opt/worker-plane/current/deploy/systemd/worker-plane-backup.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now worker-plane-backup.timer
   ```

   备份留在本机。还需要定期把 `/var/backups/worker-plane/` 复制到另一台机器或对象存储；具体方式由你决定。

## 3. 签发 worker token

UI 里还没有签发入口，用管理员会话调用 API。下面的脚本从终端读取密码，不会留在命令历史里，签发的 token 直接写进文件：

```bash
BASE=https://plane.internal:8443; WORKER=worker-a
read -rs -p "admin password: " PW; echo
JAR=$(mktemp)
CSRF=$(curl -s --cacert ca.pem -c "$JAR" -H "Origin: $BASE" -H 'content-type: application/json' \
  --data "$(printf '{"password":"%s"}' "$PW")" "$BASE/auth/login" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')
unset PW
(umask 077; curl -s --cacert ca.pem -b "$JAR" -H "Origin: $BASE" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  --data "{\"worker_id\":\"$WORKER\"}" "$BASE/api/worker-tokens" > "$WORKER.token.json")
rm -f "$JAR"
```

- 脚本用 `printf` 拼 JSON，密码里不能有双引号或反斜杠。登录接口每分钟最多 5 次。
- `$WORKER.token.json` 里的 `token` 只会出现这一次，`token_id` 是它的公开 ID。
- 把 `token` 的值写进该 worker 的 token 文件（0600），然后删除这个 JSON 文件。
- `GET /api/worker-tokens` 列出所有 token 的 ID、所属 worker、是否吊销、是否正在使用，不返回 token 本身。

## 4. 安装 worker

1. 下载对应平台的二进制和 `.sha256`，校验后安装：

   ```bash
   shasum -a 256 -c worker-plane-worker-v0.1.0-linux-x86_64.sha256
   sudo install -m 0755 worker-plane-worker-v0.1.0-linux-x86_64 /usr/local/bin/worker-plane-worker
   ```

   macOS 上如果文件是用浏览器下载的，要先执行 `xattr -d com.apple.quarantine <文件>`。

2. 准备运行账号和目录。worker 以这个账号执行所有命令，所以它应该拥有 workspace，并且只拥有完成工作所需的权限。
   - Linux 用户名：`worker-plane`。
   - macOS 用户名：`workerplane`。

   创建 `data_dir`（0700），写入 `worker.toml`（从 `deploy/worker.config.toml` 修改）、`token`（0600）和 `ca.pem`。
   - `worker_id` 必须和签发 token 时用的一致。
   - 每个 workspace 的 `path` 必须是已存在的绝对路径，并且只能有一个默认 workspace。
   - Apple Silicon 上设置 `command_path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"`。

3. 启动服务：
   - Linux：
     ```bash
     sudo cp deploy/systemd/worker-plane-worker.service /etc/systemd/system/
     sudo systemctl daemon-reload
     sudo systemctl enable --now worker-plane-worker
     journalctl -u worker-plane-worker -f
     ```
   - macOS：
     ```bash
     sudo install -d -o workerplane -m 0700 /usr/local/var/log/worker-plane
     sudo cp deploy/launchd/com.workerplane.worker.plist /Library/LaunchDaemons/
     sudo launchctl bootstrap system /Library/LaunchDaemons/com.workerplane.worker.plist
     tail -f /usr/local/var/log/worker-plane/worker.log
     ```

4. 在 UI 的机器列表里，这台机器应该显示"在线"和"可执行"。第一次注册时会自动建立这台机器和它的 workspace。

## 5. 健康与监控

- `GET /health` 不需要登录：
  - `alive`：进程存活。
  - `scheduling_ready`：启动恢复已完成、数据库可用、没有在关闭、调度未暂停。
  - `dispatch_paused`：暂停原因（`restored`、`disk_low`、`operator`），没有暂停时为 null。
- 监控建议：`alive` 为 false 或请求失败时立即告警；`scheduling_ready` 持续为 false 超过几分钟时告警；`dispatch_paused` 为 `disk_low` 时告警。
- 每台机器的在线、对账和阻塞状态在 UI 和 `GET /api/workers` 里查看。需要人工核对的事项在 UI 的"需要核对"里。

## 6. 升级

主节点：

1. 暂停调度：用 §3 的方式登录后调用 `POST /api/ops/pause`，附说明，例如 `{"note":"升级到 v0.2.0"}`。UI 里只有恢复按钮，没有暂停按钮。
2. 等正在运行的任务结束，或者确认可以中断它们。中断的任务在重启后会从 SQLite 恢复。
3. 执行 `sudo systemctl start worker-plane-backup` 做一次备份。
4. 解开新版本，然后执行 `sudo ln -sfn /opt/worker-plane/releases/<新版本> /opt/worker-plane/current`，再执行 `sudo systemctl restart worker-plane-main`。
   - 有新的迁移时，主节点会先把旧库复制成 `DATA_DIR/pre-migrate-<旧版本>-<时间>.sqlite`，再执行迁移。
   - 未结清的调用、去重水位和父子等待在升级后都保留。
5. 检查 `/health`，然后 `POST /api/ops/resume` 并附说明。升级前的暂停在重启后仍然有效，必须手动恢复。

回滚：停止主节点，把 `current` 指回旧版本，再用**旧版本**的 `admin.js restore` 恢复迁移前的快照（见 §8）。恢复后调度处于暂停状态，按 §8 的步骤核对后再恢复。

worker：先执行 `systemctl stop`（或 `launchctl bootout`），等它停下（正在运行的命令会通过取消路径停止，结果写入账本），然后替换二进制并启动。重连后先对账，再继续接任务。

## 7. 备份

- 在线备份：`cd /opt/worker-plane/current/apps/server && DATA_DIR=/var/lib/worker-plane node dist/admin.js backup <目标文件>`。
  - 使用 SQLite backup API，主节点不需要停。
  - 备份后会做完整性检查，并输出计数：未结清调用、调用序号水位、队列水位、等待中的父任务、未结束的子任务。
- 检查任意一份备份：`node dist/admin.js verify <文件>`。
- 只需要备份 `main.sqlite`。`pi-sessions/` 每次运行时都从数据库重建。
- worker 的账本不在主节点的备份里。它是去重的依据，在 worker 本机保留，不要手动删除。

## 8. 从备份恢复

1. 停止主节点：`sudo systemctl stop worker-plane-main`。`main.lock` 存在时恢复会被拒绝。
2. 恢复：`cd /opt/worker-plane/current/apps/server && sudo -u worker-plane DATA_DIR=/var/lib/worker-plane node dist/admin.js restore <备份文件>`。
   - 恢复后的库先在旁边生成并迁移，成功后才替换现有库。
   - 现有库和它的 `-wal`、`-shm` 改名为 `main.sqlite.replaced-<时间>`，不会被删除。
   - 恢复后调度处于暂停状态，原因是 `restored`。
3. 启动主节点。所有 worker 会重连并对账，这期间不会启动或重发任何调用。
4. 在 UI 的暂停横幅里查看还没对账的机器。全部对账后，检查"需要核对"：
   - 如果 worker 账本里有主库没有记录的调用，这台机器会以 `ledger_contradiction` 阻塞，需要人工核对后解除。
   - 备份里还在执行中的调用，恢复调度后由 worker 账本返回已保存的结果，不会再执行一次。
5. 在横幅里填写说明，恢复调度。某台机器确实无法连接时，可以用 API 加上 `force: true` 和说明跳过它；跳过的机器会记在审计事件里。

## 9. token 轮换与吊销

1. 按 §3 为同一个 `worker_id` 签发新 token。
2. 把新 token 写进该 worker 的 `token_file`，替换旧内容。
3. 按 ID 吊销旧 token：`POST /api/worker-tokens/revoke`，请求体为 `{"token_id":"<旧 ID>"}`。主节点会关闭旧连接；worker 重连时重读文件，用新 token 注册、对账后继续工作，进程不需要重启。

只吊销、不提供新 token 时，worker 会收到 401 并以 1 退出。systemd 在 10 分钟内重试 5 次后停止，launchd 每 60 秒重试一次。这时停掉服务即可。

## 10. 主节点异常退出后

主节点只有在正常退出时才释放 `DATA_DIR/main.lock`。崩溃、断电或被 SIGKILL 后，这个锁会留下，下次启动会被拒绝。这是故意的设计：在确认旧进程已经不在之前，不能有第二个进程使用同一个数据目录。

处理步骤：

1. 执行 `systemctl status worker-plane-main` 和 `pgrep -af 'dist/main.js'`，确认没有主节点进程。
2. 查看 `main.lock/owner.json` 里的 pid 和启动时间，确认对应的进程已经退出。
3. 删除锁目录：`sudo rm -r /var/lib/worker-plane/main.lock`。
4. 执行 `sudo systemctl start worker-plane-main`。启动时会从 SQLite 恢复：worker 重连并对账后，执行中的任务继续；无法证明执行结果的调用会进入"需要核对"，不会自动重跑。

所以主节点的单元设置了 `Restart=no`，自动重启只会被锁拒绝。

## 11. 磁盘与保留

- 主节点：
  - 每小时运行一次维护：清理过期登录；终态任务结束超过 `MAIN_RETENTION_DAYS`（默认 30 天）后，删除它的输出分块和 Pi 会话文件。结果和对话记录保留。
  - 数据目录剩余空间低于 `MAIN_MIN_FREE_BYTES`（默认 1 GiB）时以 `disk_low` 暂停调度，空间恢复后自动继续。
  - 事件流保留最近 7 天，最多 10 万条。
  - 存储的输出总量上限由 `MAIN_LOG_CAPACITY_BYTES` 控制，默认 1 GiB。超出上限后，每个输出流只保存前 64 KiB。
- worker：
  - 存储的输出超过 `log_disk_budget_bytes`，或剩余空间低于 `min_free_bytes` 时，拒绝新的调用。
  - 已确认的结果保留 `result_retention_secs`（默认 7 天），之后只留下用于去重的 tombstone。
- 进程日志：
  - 主节点和 Linux worker 的日志由 journald 收集。
  - macOS worker 的日志写到 `/usr/local/var/log/worker-plane/worker.log`。worker 只在连接变化和出错时写日志，增长很慢。
  - 这个文件由 launchd 打开并一直持有，newsyslog 改名或压缩后 worker 仍会写进旧文件，所以不要用 newsyslog 轮转它。需要清理时，先停止服务（正在运行的命令会正常停止），移走文件，再启动：

    ```bash
    sudo launchctl bootout system/com.workerplane.worker
    sudo mv /usr/local/var/log/worker-plane/worker.log /usr/local/var/log/worker-plane/worker.log.1
    sudo launchctl bootstrap system /Library/LaunchDaemons/com.workerplane.worker.plist
    ```

## 12. 故障排查

| 现象 | 原因与处理 |
|---|---|
| worker 日志出现 `UnknownIssuer` 或证书错误后退出 | `SSL_CERT_FILE` 没有指向 Caddy 的内部根证书，或者 CA 已重新生成。重新复制 `root.crt` 后重启 worker |
| worker 收到 401 后退出 | token 已被吊销，或不属于这个 `worker_id`。按 §9 处理 |
| worker 启动时报 `data directory already locked` | 同一个 `data_dir` 上已经有一个 worker 在运行 |
| 主节点启动时报 `EEXIST ... main.lock` | 见 §10 |
| 登录返回 403 `origin` 或操作返回 `csrf` 错误 | `PUBLIC_BASE_URL` 和浏览器访问的地址不一致 |
| UI 显示"调度已暂停" | 横幅里写明了原因：`restored` 见 §8，`disk_low` 需要清理磁盘，`operator` 表示有人手动暂停 |
| 机器显示"阻塞"或任务"需要核对" | 无法证明某个调用是否执行过。在 UI 里核对后解除阻塞，或者放弃这个任务 |
| SSE 或 worker 连接每隔几分钟断一次 | 检查 Caddy 前面是否还有其他代理设置了空闲超时。Caddy 自身对代理连接不设读超时 |

## 13. 验收向导

在真实环境做第一次完整验收时，可以在运维人员的电脑上运行 `deploy/acceptance-wizard.sh`。它按本手册的顺序，带你完成安装、注册、执行、超时、取消、重启、长连接、token 轮换、真实模型委派、备份和恢复，能自动检查的项目会自动检查，结果记在 `~/.worker-plane-acceptance/results.env`。中途退出后可以重新运行，已填写的值会作为默认值。
