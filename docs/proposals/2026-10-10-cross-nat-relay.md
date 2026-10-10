# 跨 NAT 连接：可选内置中继

日期：2026-10-10。状态：草案，未排期，暂不实施。设计依据见 [架构](../architecture.md) §10 与 [运维手册](../operations.md)。

## 背景

worker 到主节点只有一条出站 WSS（Caddy 终止 TLS，再反代到 Fastify 的 `/ws/worker`）。主节点从不主动连 worker，业务层也不依赖对端地址或 TLS 细节。所以"worker 必须能访问主节点才能加入"实质上是"主节点要有一个 worker 能路由到的地址"。

当主节点和 worker 各自在不同局域网、都在 NAT 后、路由器不开放端口时，这个地址不存在。物理上双方只靠自己找不到对方，必须有一个双方都能出站连到的落脚点。

## 约束（已与用户确认）

- 系统内直接集成，作为可选特性开启。不配置时行为与现在完全一致。
- 不依赖 Tailscale、frp 一类需要单独安装的外部组件。
- **TLS 端到端**：中继只转发字节，看不到明文。主节点内部 CA、worker 的 `wss://` 校验和 Bearer token 认证全部保持不变。
- 本期只保证 worker 经中继。浏览器 UI 经中继只写文档说明（浏览器机器加 hosts 记录即可）。

## 已在代码中核实的事实

- **worker 换底层流的代价很小。** `type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>`（`worker/src/main.rs` 第 36 行）是唯一的具体类型引用；`connect()` 是唯一创建点；其余代码只用 `send`/`next`。`tokio_tungstenite::client_async_tls_with_config(request, TcpStream, cfg, None)` 返回同一类型，SNI 和证书校验取自 request 的 host。所以 URL 保持 `wss://plane.internal:8443/ws/worker`，TCP 另拨到中继即可，`Socket` 别名不用改。
- **worker 配置有 `deny_unknown_fields`。** 新键必须加进 `Config`，旧二进制会拒绝带新键的配置文件。
- **主节点没有可选子系统的先例。** `apps/server/src/config.ts` 的 `loadConfig` 只校验环境变量、不读文件；`main.ts` 负责组装和 SIGTERM 关停顺序。
- **`/health` 被三处引用。** `health.test.ts` 做 deepEqual，`docs/operations.md` 和 `deploy/acceptance-wizard.sh` 引用 `phase:P7`。新增字段要同步这三处。
- **测试基础设施可复用。** `apps/server/test/support/worker-harness.ts` 的 `createCertificates`、`startWorker(…, extraConfig)`、`startTlsProxy`，以及 `main-node.ts` 的 `startScenario` 和 `main-process.ts` 的 `freePort()`。
- **Rust 依赖。** 本地 cargo registry 没有 `hmac` crate；`sha2` 和 `getrandom 0.3.4`（uuid 的传递依赖）已在 lock 里。新增 bin 需要显式 `[[bin]]`，否则会被自动命名为 `relay`。
- **发布。** `cargo build/test --locked` 自动覆盖所有 bin；`release.yml` 的 Package worker 步骤需多拷一个产物；`build-main.sh` 整体拷贝 `deploy/systemd`。

## 候选方案

| | A. 自托管 Rust 中继（裸 TCP） | B. Cloudflare Worker + Durable Object |
|---|---|---|
| 落脚点 | 一台双方都能到的 VPS | Cloudflare，`*.workers.dev` 子域，不需要自己的域名 |
| 需要维护的机器 | 一台 | 无，`wrangler deploy` 一次 |
| 外部依赖 | 无 | Cloudflare 账号 |
| 费用 | VPS 月费 | 免费额度大概率够几台 worker，超出为付费计划 **[未核实，实施前按当时价格核对]** |
| 端到端 TLS | 天然：中继透传 TCP | 需要把内层 TLS 记录装进 WebSocket 二进制帧 |
| 延迟 | 一跳 | 两端各到最近 PoP，再到 DO 所在机房，往返多几十到一两百毫秒 **[未核实]** |
| 中继代码 | Rust 约 400 行 | JS 约 200 行，仓库内附 wrangler 配置，由用户自己部署 |
| worker 改动 | 加 `connect_addr`，其余不变 | 外层 WSS 到 Cloudflare，内层 TLS 到 Caddy，需要两套根证书 |

不采用的方向：

- **UPnP / NAT-PMP 端口映射**：运营商 CGNAT 或路由器关闭 UPnP 时不可用，公网 IP 变化还要重新发现。
- **纯 P2P 打洞**：对称 NAT 下经常失败，仍需要信令服务。
- **Cloudflare Tunnel / ngrok**：TLS 在服务商终止，与端到端 TLS 约束冲突。

## 推荐

把客户端（worker、主节点代理）一侧设计成**通用的 WebSocket 二进制隧道协议**，中继只是协议的一个实现：

1. 想零机器维护，先实现 B（Cloudflare）。
2. 以后要完全自托管，再写一个说同样协议的 Rust 中继，可以放在 Caddy 后面，客户端不用再改。

如果明确接受维护一台 VPS、又不想引入任何外部服务，就直接实施 A，用下文更简单的裸 TCP 协议。

## 待决问题

1. 中继形态：只做 B；B 与 A 同期做；还是只做 A。
2. B 方案中 worker 到 Cloudflare 的外层 TLS 用哪套根证书。候选是内置 `webpki-roots`（行为可预测，跨平台一致），或读系统根证书库（不加 crate，但最小化 Linux 镜像可能没有证书库，且要改 `SSL_CERT_FILE` 的现有用法）。内层到 Caddy 始终只信任 ca.pem。
3. `/health` 的 `phase` 是否随之升到 `P8`。

## 安全论证

- 数据流是 worker 与 Caddy 之间的端到端 TLS，中继只能看到 TCP 元数据和 SNI。
- 代理用 HMAC-SHA256 加每连接新 nonce 认证，只有持有 secret 的一方能注册为代理或认领流，抓包得到的 MAC 无法重放。
- 控制通道被中间人或 secret 泄露时，攻击者能收到 worker 的流，但没有主节点私钥，完不成 TLS 握手。最坏结果是拒绝服务和元数据泄露（worker 来源 IP、连接时间）。
- 中继的 worker 入口对公网开放。未认证的连接只消耗一次 `open` 和一次本地拨号，受下文上限约束，最终被 Caddy 和 Bearer 校验拒绝。B 方案建议 worker 侧也带 relay key，避免陌生人消耗免费额度。

## 实施草案 A：自托管 Rust 中继

模式是 frp 风格的"控制连接 + 按流建立的数据连接"，不写多路复用器，中继不做 TLS。

### 协议 `wpr1`（中继与主节点代理之间）

传输：TCP 到中继的 `--main-listen` 端口，换行分隔 JSON，每行一个对象。

| 方向 | 消息 | 字段 | 时机 |
|---|---|---|---|
| 中继 → 客户端 | `challenge` | `v:"wpr1"`、`nonce`（32 随机字节的 hex） | 每个 main-listen 连接一接受就发，每连接新 nonce |
| 客户端 → 中继 | `auth` | `role:"control"`、`mac` | `mac = hex(HMAC-SHA256(secret, "wpr1:control:"+nonce))` |
| 客户端 → 中继 | `auth` | `role:"data"`、`conn`、`mac` | `mac = hex(HMAC-SHA256(secret, "wpr1:data:"+conn+":"+nonce))`，`conn` 必须待配对 |
| 中继 → 代理 | `ok` | 无 | 仅控制连接认证通过时发；数据连接认证后直接是原始字节 |
| 中继 → 代理 | `open` | `conn` | worker 入口来了一条 TCP 连接 |
| 中继 → 代理 | `ping`，代理回 `pong` | 无 | 控制连接保活 |
| 中继 → 代理 | `close` | `reason:"replaced"` | 新控制连接顶替旧的之前 |

常量：

| 名称 | 值 | 作用 |
|---|---|---|
| `MAX_LINE` | 1024 字节 | 超长行关闭连接 |
| `AUTH_TIMEOUT` | 5 秒 | challenge 后未收到有效 auth 即关闭 |
| `KEEPALIVE` | 15 秒 | 控制连接 ping 周期 |
| `CONTROL_SILENCE` | 45 秒 | 双方各自在静默这么久后断开 |
| `PENDING_TIMEOUT` | 10 秒 | 未被认领的 worker 连接关闭 |
| `MAX_PENDING` | 64 | 超出的 worker 连接立即关闭 |
| `MAX_STREAMS` | 1024 | 超出的 worker 连接立即关闭 |
| secret | 去空白后至少 32 字节 | 建议 `openssl rand -hex 32` |

规则：

- 没有已认证的控制连接时，worker 连接立即关闭，worker 看到 EOF 后按现有退避重试。
- 中继配对前不读 worker socket。配对后对 worker socket 和"读完认证行的 `BufReader<数据连接>`"做 `copy_bidirectional`，缓冲字节不丢。
- 新控制连接替换旧的；已配对的流不受影响；待配对的 worker 连接由超时清理。
- 错误 MAC、非待配对 `conn`、重复 `auth` 都直接关闭连接。

### A-1：中继二进制（Rust）

- 新建 `worker/src/bin/relay.rs`，完全自包含（crate 没有 lib，不能从 `main.rs` 导入）。`worker/Cargo.toml` 加 `[[bin]] name = "worker-plane-relay"` 和 `getrandom = "=0.3.4"`，刷新 `Cargo.lock`。
- 命令行：`--worker-listen`、`--main-listen`，secret 来自 `--secret-file`（0600 检查，规则同 worker 的 `TokenSource`）或环境变量 `RELAY_SECRET`，二选一。
- HMAC 基于 `sha2` 手写，配常量时间比较，用 RFC 4231 向量测试。
- 启动后 stdout 打印一行 `listening worker=<addr> main=<addr>`，供测试和运维使用。超时与上限放进 `Limits` 结构体，测试可用毫秒级值。
- 日志不打印 secret 或 MAC。
- 内联测试：HMAC 向量、参数解析、超长行、端到端回显、无控制连接时拒绝、未认领超时、错误 MAC 与重放、控制连接替换。

### A-2：主节点代理与 worker `connect_addr`

- **主节点代理** `apps/server/src/relay.ts`：只用 `node:net` 和 `node:crypto`。控制循环认证、处理 `open`，每个流并行拨中继数据连接和本地 Caddy（默认 `127.0.0.1:8443`），然后双向 pipe。断线按 1 秒到 30 秒退避重连。暴露 `status()` 和 `close()`。
- **主节点配置** `config.ts`：`RELAY_ADDR`（`host:port`）、`RELAY_SECRET_FILE` 或 `RELAY_SECRET` 二选一、`RELAY_LOCAL_TARGET`。只设了部分变量时启动报错，错误信息不含密钥。
- **主节点入口** `main.ts`：listen 成功后启动代理；关停顺序为先关代理、再 `app.close()`、关库、释放锁。
- **健康检查** `/health` 增加 `relay` 字段（未配置为 `null`）。
- **worker**：`Config` 加可选 `connect_addr`。设置时先 `TcpStream::connect(connect_addr)`，再 `client_async_tls_with_config`；否则走原路径。整个连接过程加 30 秒超时，超时归为 Retry，直连路径也受益。TCP 层错误归为 Retry；证书失败和 4xx 仍是致命错误。

重试映射：

| 情况 | worker | 主节点代理 |
|---|---|---|
| 中继宕机或拒绝连接 | Retry，1 到 30 秒退避 | 1 到 30 秒退避重连 |
| 中继在，代理不在 | 连接立即被关，Retry | 不适用 |
| 中继和代理在，Caddy 或主节点宕机 | TLS 握手 EOF，Retry | 记录本地拨号失败，关闭该流 |
| worker token 错误 | 经隧道收到 401，致命（与现在一致） | 不适用 |
| 中继 secret 错误 | 永远配不上，持续 Retry | 认证被拒，记录 `last_error`，退避 |

### A-3：集成测试

新建 `apps/server/test/p8-relay.test.ts` 和 `test/support/relay.ts`。worker 的 `url` 仍指向测试 TLS 代理（SNI `localhost` 匹配测试证书），`extraConfig` 加 `connect_addr`；主节点代理的本地目标指向测试 TLS 代理，代替 Caddy。用例：

1. 经中继注册并跑完一个 bash 任务。
2. 中继被杀后代理断开、worker 离线；中继在同端口重启后 epoch 递增、任务成功。
3. secret 错误时代理连不上、中继日志有拒绝记录；换成正确 secret 的代理后，worker 不重启即上线。
4. worker 先于代理启动时持续重试且进程存活；代理启动后上线。
5. 同 `worker_id` 的第二个进程经中继替换旧连接，epoch 递增。
6. `loadConfig` 与 secret 读取的校验用例。
7. 主进程带 `RELAY_*` 启动，`/health` 显示中继已连接；SIGTERM 退出码 0，锁已释放。

### A-4：部署、发布与文档

- `deploy/systemd/worker-plane-relay.service`：`DynamicUser=yes` 加 `LoadCredential` 读 secret，监听 8444（worker 入口）和 8445（主节点入口），常规加固项；注释说明 systemd 247 以下改用静态用户。
- `deploy/main.env.example`、`deploy/worker.config.toml`、`worker/config.example.toml` 加注释示例。
- `release.yml` 多发布 `worker-plane-relay-<tag>-<os>-<arch>`。
- `deploy/acceptance-wizard.sh` 加一个可选的"内置中继"阶段。
- 文档：新增 `docs/p8-development.md`；`development-plan.md` 加 P8；`architecture.md` §10 加"中继传输（可选）"小节并更新拓扑图；`operations.md` 加安装、防火墙、验证、浏览器 hosts 说明和排障条目。

## 实施草案 B：Cloudflare Worker + Durable Object

在 A 的基础上替换传输层，认证和上限规则沿用 `wpr1`。

- **中继**：一个 Cloudflare Worker 接收 WebSocket 升级，转给单个 Durable Object（单租户，一个主节点一个实例）。DO 持有主节点代理的控制 WebSocket，worker 来一条 WebSocket 就发 `open`，代理再开一条数据 WebSocket 认领，然后 DO 双向转发二进制帧。代码放在仓库内（例如 `relay-cloudflare/`），附 `wrangler.toml`，secret 用 `wrangler secret put` 注入。
- **worker**：外层连 `wss://<name>.workers.dev/...`，用公共根证书校验；拿到 WebSocket 后，把它包成 `AsyncRead + AsyncWrite` 的字节流，在上面跑现有的 rustls + tungstenite 到 Caddy，内层只信任 ca.pem。配置键从 `connect_addr` 变为类似 `relay_url` 和 `relay_key`。
- **主节点代理**：控制连接和数据连接都改为出站 WebSocket（Node 端已有 `ws` 依赖），数据连接上的二进制帧与本地 Caddy 的 TCP 字节互相转发。
- **需要实施前核对的点**：Durable Object 单条消息上限 **[未核实]**（内层 TLS 记录最大 16 KiB，预计远低于上限）；WebSocket Hibernation 下的计费方式与免费额度 **[未核实]**；worker 每 10 秒一次心跳，加上日志流量后的日消息量要按当时额度估算。
- **测试**：用 `wrangler dev` 或 Miniflare 在本地跑中继，复用 A-3 的用例清单。

## 验证（两种方案通用）

- Rust：`cargo fmt --check`、`cargo test --locked`、`cargo build --locked`。
- Node：`pnpm check`、`pnpm test`，包括更新后的 `health.test.ts` 和新的中继集成测试。
- 发布：`deploy/build-main.sh` 与 `deploy/smoke-main.sh`，确认 tarball 带上新的部署模板。
- 手工端到端：本机起中继、主节点（带 `RELAY_*`）、Caddy dev 配置和一个配置了中继的 worker。在 UI 里确认 worker 在线并能执行任务；停掉中继后 worker 离线，恢复后自动重连；`/health` 的 `relay` 字段随之变化。
- 回归：不配置中继时，现有全部测试和 `/health` 行为不变（新增字段为 `null` 除外）。
