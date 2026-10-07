# P1 工程与身份基础

2026-10-07。开发阶段实现，P1 全量验收尚未完成；不开放任务执行，也不调用模型。

## 构建与检查

需要 Node 24（本次验证 24.12.0）、Corepack/pnpm 10.18.3、Rust/Cargo（本次验证 1.93.1）、C/C++ 编译工具及 OpenSSL。Linux/macOS CI 使用同一组命令；远端 CI 尚未运行。

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

`pnpm test` 包含真实 SQLite 与网络测试，WSS 验证会启动两个实际 Rust worker、创建临时 CA 和服务端证书，不访问外部服务，不关闭 Rust 证书校验。必须先构建 Rust binary。UI 当前只有登录与机器连接状态；UI 无自动化测试用例，浏览器验证单独记录。

协议源是 `packages/protocol/schema.json`；生成 TS/Rust 类型需提交生成文件。两端读取同一份合法/非法 frame 与 RFC 8785 hash fixtures。当前协议仅包含 register/register_ack/heartbeat/resume/reconcile/ack；未来 tool/cancel/result/log 帧尚未加入，不能将当前协议视为完整 Spec v2。

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

Worker 数据目录有 OS 独占文件锁；worker_id 与 ledger_id 持久化 SQLite，boot_id 每次启动随机变化。退出重启保留 ledger_id；用其他 worker_id 打开同一数据目录拒绝启动。当前连接断开后 worker 退出，需要服务管理器/人工重启；自动重连与退避尚未实现。

主节点首次迁移后设置 WAL/FULL/foreign_keys/busy_timeout。迁移按文件版本事务执行。已有 001 数据库升级至 002 的测试保留身份、epoch 和执行槽；重开数据库清除 online/reconciled，不恢复虚假在线状态。

主节点启动使用 `main.lock` 目录防止第二实例。正常退出删除锁；异常退出保留锁，不根据时间偷取锁。操作员核对旧进程确实退出后，才可手工移除锁目录。该策略尚未完成异常退出运维验收。

## 已验证与剩余验收

| P1 条目 | 当前证据和边界 |
|---|---|
| 1 | Node 24 类型检查/构建；真实 SQLite 空库、001→002、重开测试；Rust macOS 编译。干净 Linux 与远端 CI 未验证。 |
| 2 | 未登录任务/取消/历史/日志/事件请求返回 401；登录 Origin、变更 CSRF、退出失效测试。相关业务入口目前未实现。 |
| 3 | 无效 token 升级拒绝；注册伪造身份拒绝；真实 WSS token 撤销断连，槽保留。 |
| 4 | Argon2id 管理员 hash，worker token/session 仅存 digest；结构化日志脱敏。模型密钥尚无使用入口。 |
| 5 | 两个真实 Rust 进程，重复目录启动拒绝；重启 boot_id 变化、ledger_id 保持，worker_id 固定。 |
| 6 | 两端同组 schema fixtures、帧大小限制、同组 JCS hash 样例。真实超大 WSS 帧与完整工具请求 hash 契约仍待补。 |
| 7 | Rust 10 秒 heartbeat；30 秒截止测试使用可控时钟驱动真实 socket；断开离线；更高 epoch 与空槽对账测试。 |
| 8 | SSH/HTTPS remote 规范化单测；注册 default/重复 ID 校验。多 workspace 的业务选择与配置版本绑定未完成。 |
| 9 | 专用 WSS 升级鉴权；worker token 被用户接口拒绝。UI 只访问主节点。SSE 与广播机制尚未实现。 |
| 10 | 版本化注册/ACK/resume/reconcile/schema fixtures；连接替换、旧 epoch、身份冲突测试。完整调用/ACK/重复帧矩阵未完成。 |
| 11 | 连接与 worker_slots 分开；旧连接关闭/超时/撤销保留槽。含未决调用的完整对账尚未实现；非空槽或 ledger 改变一律阻塞。 |

当前 reconcile 仅验收 P1 空账本/空执行槽，不能作为 P3 的调用对账。主节点保留原 ledger_id，检测新 ledger_id 时设置 blocked；不自动清空阻塞或把账本变化当作未执行证明。

本次改动尚未提交、推送或发布。仓库根目录是 Codex 管理的 bare 仓库，普通 `git status` 失败；当前文件检查使用 `git --work-tree=.`。未修改共享 bare 配置，未删除其他工作树。应用提示的工作树设置失败尚未宣称已修复。

## 本次本地验收记录

Node 24.12.0 / pnpm 10.18.3 / Rust 1.93.1 / macOS arm64。`pnpm check`、`pnpm test`（协议 3 项、主节点 5 项）、Rust 测试 2 项及主节点/UI 构建通过；WSS 采用受控 localhost CA 签发证书，并启动两个真实 Rust 进程。受控 heartbeat clock 测试不代表等待实际 30 秒的网络长跑。

浏览器另用 HTTPS 预览和受控协议 peer，完成登录、注册状态、断开状态及刷新后的会话恢复检查；这组截图不是 Rust/Pi 执行业务 E2E，也没有使用真实管理员凭据。测试预览的 favicon 请求返回 401，属于临时静态转发器缺少 favicon；正式 Caddy 静态入口另行处理。

- [登录页](../output/playwright/p1/01-login.png)
- [在线机器](../output/playwright/p1/02-worker-online.png)
- [离线机器](../output/playwright/p1/03-worker-offline.png)

三张截图已实际打开检查。Linux 构建、线上部署与远端 CI 不属于本次通过记录。
