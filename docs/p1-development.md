# P1 工程与身份基础

2026-10-07。P1 交付仅包含工程、协议、身份、workspace 映射与连接状态。任务 API、Agent runtime 和 worker 工具执行保持关闭。

## 构建与检查

需要 Node 24（本次验证 24.12.0）、Corepack/pnpm 10.18.3、Rust/Cargo（本次验证 1.93.1）、C/C++ 编译工具及 OpenSSL。GitHub Actions 为 Linux/macOS 矩阵，每次 PR 更新后重跑。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm protocol:generate
cargo build --locked --manifest-path worker/Cargo.toml
cargo test --locked --manifest-path worker/Cargo.toml
pnpm check
pnpm test
pnpm build
```

`pnpm test` 包含真实 SQLite 与网络测试，WSS 验证会启动实际 Rust worker、创建临时 CA 和服务端证书，不访问外部服务，不关闭 Rust 证书校验。测试还验证超限帧在 TLS/WSS 连接中被 Rust worker 拒绝。必须先构建 Rust binary。UI 当前只有登录、机器连接状态与固定 workspace 查询；UI 无自动化测试用例，浏览器验证单独记录。

协议源是 `packages/protocol/schema.json`，其中也定义两端共用的 65,536 字节帧上限。生成 TS/Rust 类型需提交生成文件；TypeScript 和 Rust runtime 都检查 schema 并运行同一组合法/非法帧与 RFC 8785 请求 hash 样例。P1 帧包括注册、确认、心跳、resume、reconcile 和 ACK，不含工具执行帧。

## 本地 HTTPS/WSS

从仓库根目录执行。管理员密码通过环境注入，至少 16 字符；不要写进命令历史或仓库。首次启动后数据库只保留 Argon2id hash，可移除环境变量。模型密钥不属于 Rust worker 配置，本阶段无模型调用。

```sh
export PUBLIC_BASE_URL=https://localhost:8443
export DATA_DIR=/absolute/private/server-data
# 在安全的本地环境中设置 INITIAL_ADMIN_PASSWORD，不在这里填写真实值。
pnpm --filter @worker-plane/server dev
# 另一个终端，已安装 Caddy 时：
caddy run --config deploy/Caddyfile
```

Caddy 对外提供 HTTPS/WSS 与静态 UI，Fastify 仅监听 127.0.0.1:3000。浏览器访问 `https://localhost:8443`。开发 CA 的信任需按本地环境显式配置；worker 可用 `SSL_CERT_FILE=/absolute/ca.pem` 指定开发 CA。不要关闭证书验证。

登录 `POST /auth/login`，JSON `{password}`，必须携带与 PUBLIC_BASE_URL 完全一致的 Origin。响应返回 CSRF，Cookie 为 Secure/HttpOnly/SameSite=Strict。后续变更请求同时携带 Cookie、Origin、`x-csrf-token`。登录限速每分钟 5 次；会话 8 小时过期。

`POST /api/worker-tokens` 的 JSON 为 `{worker_id}`，仅管理员会话可调用；响应一次返回高熵 token，数据库只保存 SHA-256 校验值。`POST /api/worker-tokens/revoke` 的 JSON 为 `{token}`；立即标记离线并关闭该 worker 的当前连接，保留执行槽。重新启用必须签发新 token 并对账。

复制 `worker/config.example.toml` 到本地私有配置，填写稳定 worker_id、绝对数据目录、WSS 地址与 workspace。WORKER_TOKEN 通过进程环境注入，不存 TOML。必须恰好配置一个默认 workspace，workspace ID 不重复，路径存在且为绝对目录。

```sh
cargo run --locked --manifest-path worker/Cargo.toml -- /absolute/private/worker.toml
```

Worker 数据目录有 OS 独占文件锁；worker_id 与 ledger_id 持久化 SQLite，boot_id 每次启动随机变化。退出重启保留 ledger_id；用其他 worker_id 打开同一数据目录拒绝启动。连接中断时进程退出，服务重启后 worker 获得更高 epoch，必须先完成 reconcile；自动网络重连留到后续部署阶段。

主节点首次迁移后设置 WAL/FULL/foreign_keys/busy_timeout。迁移按文件版本事务执行。已有 001 数据库升级至 002 的测试保留身份、epoch 和执行槽；重开数据库清除 online/reconciled，不恢复虚假在线状态。

主节点启动使用 `main.lock` 目录防止第二实例。正常退出删除锁；异常退出保留锁，不根据时间偷取锁。操作员核对旧进程确实退出后，才可手工移除锁目录。单实例行为已由本地测试覆盖；生产服务恢复操作仍需在部署阶段验证。

## P1 验收记录

本地验证环境为 Node 24.12.0、pnpm 10.18.3、Rust 1.93.1、macOS arm64。完整验证命令见“构建与检查”。阶段验收结果如下：

| P1 条目 | 证据 |
|---|---|
| 1 | 冻结 lockfile 安装；TypeScript 主节点/UI 和 Rust worker 构建。真实 SQLite 空库迁移、001 升级至 002 与重开测试；CI 在 Linux/macOS 执行同一流程。 |
| 2 | 未认证的任务、取消、历史、日志、事件与 workspace 请求返回 401；错误 Origin、缺失/错误 CSRF 被拒绝；退出令牌失效。任务 API 尚未开放。 |
| 3 | 未知与撤销令牌不能建立注册连接；升级后、注册前撤销的竞态也会拒绝注册；worker_id 伪造被拒绝；撤销现有连接会立即离线，执行槽保留。 |
| 4 | 管理员密码以 Argon2id 保存；worker token 与 session 仅保存 digest。日志回归测试确认 Authorization、Cookie 与密码不出现在结构化日志中。P1 不调用模型。 |
| 5 | 两个真实 Rust 进程注册；同一 worker 数据目录只能由一个进程持有；worker_id 冲突拒绝启动；重启后 boot_id 改变而 ledger_id 保持。主节点目录锁也有并发测试。 |
| 6 | TS/Rust 帧上限由同一 JSON Schema 生成。两端校验同组合法/非法帧与 RFC 8785 hash 样例；Rust worker 在真实 TLS/WSS 会话中拒绝 65,537 字节帧。 |
| 7 | 心跳发送间隔 10 秒，30 秒断联测试将 worker 标记离线；显式断开立即离线。新连接的 epoch 递增；旧 epoch 被拒绝；resume/reconcile ACK 可安全重传。 |
| 8 | SSH scp、SSH URL 与 HTTPS remote 得到相同 repo_id。默认 workspace 必须恰有一个；多 workspace 查询必须显式提供 workspace_id；活动执行槽存在时，workspace path/repo/version 变更会被拒绝。 |
| 9 | worker WSS token 与管理员 session 分离；管理员 session 不能注册 worker，worker token 不能访问用户 REST。worker socket 不加入用户事件连接集合；尚未实现的事件 URL 仍先经过用户认证门。 |
| 10 | 共享样例包含 register/register_ack、heartbeat、resume/reconcile、ACK、未知版本、非法字段、错误 ACK 和旧 epoch。重复 register 保持原 epoch，重复 resume/reconcile 返回原 ACK；跨 TS/Rust 生成无漂移。 |
| 11 | 连接 epoch 与 worker_slots 分开保存。新连接在槽占用或 ledger 不一致时无法 reconcile；超时、旧连接、撤销和 workspace 冲突均不释放在途槽。 |

P1 不开放 job 创建或工具调用；这正是 P1 出口要求。非空调用 ledger 的 P3 恢复语义、read/write/bash 与模型执行闭环属于后续阶段，不纳入此验收。

最新本地运行：协议 3 项、主节点 11 项、Rust 4 项测试通过；TypeScript 检查、Rust 格式/构建、Vite 构建和生成文件复现检查通过。推送后仍须以当前 PR head 的 Linux/macOS CI 结果作为跨平台验收记录。

## 浏览器证据

浏览器使用临时 HTTPS 预览和受控 worker peer，实际检查登录、在线/离线状态及刷新后的 session 恢复。截图不代表工具执行业务 E2E，也没有使用真实管理员凭据。

- [登录页](../output/playwright/p1/01-login.png)
- [在线机器](../output/playwright/p1/02-worker-online.png)
- [离线机器](../output/playwright/p1/03-worker-offline.png)
