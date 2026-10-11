# 安装与首次使用

推荐路线：**部署主节点 → 信任内部 CA → 登录控制台 → 安装 worker → 核对指纹批准 → 等待可执行 → 完成只读任务**。主节点通过 Docker Compose 部署；worker 装在每台执行机器的宿主机上。

安装器需要 Bash 3.2+、curl 和 shasum/sha256sum。

- 只使用已发布的正式 Release，并校验 SHA-256；没有正式版本时退出，不使用草稿、预发布或源码构建结果。
- 省略 `--version` 时安装最新正式版本并显示实际版本；固定版本加 `--version vX.Y.Z`。
- 预发布版本（如 `v0.3.0-rc.1`）只用于验收，须用 `--version` 显式指定，安装器会标明“预发布”。
- Pages 上的 `install.sh` 是最新正式 Release 附带的那一份，与它下载的二进制和镜像同版本；需要旧版本的安装器时，从对应 Release 下载 `install.sh` 并校验 `.sha256`。

## CA 指纹自动接入

控制台“机器授权 → 添加机器”默认选择“自动获取 CA”。浏览器仍需先信任主节点导出的根证书；执行机器无需提前复制证书。控制台通过已信任的 HTTPS 获取公开根证书，计算证书 DER 的 SHA-256 指纹，并写入安装命令。

在执行机器运行控制台复制的命令；命令形如：

```sh
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- worker --server 'https://plane.internal:8443' --ca-fingerprint '<控制台提供的64位十六进制指纹>'
```

CA 指纹接入从 v0.3.0 起提供，主节点与 worker 须同为 v0.3.0 或更新版本。更早的版本使用[手动 CA 兼容流程](#手动-ca-兼容流程)。

安装器仅在获取 `/.well-known/willcord/ca.pem` 时暂不验证证书，不携带登录凭据、不跟随重定向，并限制响应大小。核对根证书指纹后，所有 HTTPS/WSS 请求恢复完整证书链及主机名验证。错误指纹会在安装前退出。不要从同一条未经验证的连接取得并信任指纹；应从已信任的控制台或管理员渠道复制。

系统级安装仍需 `--system --user 'ops'`。手动 `--ca '/absolute/ca.pem'` 继续可用；公共证书或系统已信任的内部 CA 可不带这两项。`--ca` 与 `--ca-fingerprint` 不能同时使用。自动取得的 CA 会保存到安装目录，后续命令及服务自动复用。

主节点 CA 指纹与授权时核对的 worker 公钥指纹不同。CA 更新后应从可信控制台重新获取命令。浏览器证书信任、管理员批准设备和首次任务验收仍需分别完成。

## 1. 在主节点机器部署

准备 Linux x86_64/arm64 主机、Docker 和 Docker Compose v2。macOS（Docker Desktop）同样可以运行向导，适合本机试用：Docker Desktop 退出后服务随之停止，生产环境请使用 Linux。浏览器和执行机器必须能解析并访问同一个主节点地址；仅在本机试用时可以用 `https://localhost:8443`，但 `localhost` 在其他执行机器上指向它们自己，跨机器部署须使用对方能解析的主机名或 IP。安装器不安装 Docker，不改变系统权限。

```sh
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- main
```

向导通过终端收集 HTTPS 地址（默认 `https://plane.internal:8443`）、模型 provider/name、API key 和至少 16 字符的管理员密码。密钥输入不回显。provider 不区分大小写，拼错会立即提示并列出可选值；只有 openrouter 有默认模型，其他 provider 需要自己填写模型名称。向导结束时会给出信任根证书的命令（macOS 与 Debian/Ubuntu）。也可以预先指定地址和目录：

```sh
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- main --server 'https://plane.internal:8443' --dir '/opt/my-plane'
```

目录默认 `./willcord`，当前账户必须可写。安装器生成 `compose.yaml`、`.env` 和 `main.env`，固定镜像版本；环境文件权限 0600，不要提交到 Git。不同目录使用独立的 Compose 项目及数据卷。已有部署文件时拒绝覆盖。

向导在写入任何文件之前，会向模型服务商确认 API key（支持 openrouter、openai、anthropic）：只有被明确拒绝（HTTP 401）才会要求重新输入（最多 3 次，第 3 次仍被拒绝才退出，此时未写入任何配置）；无法确认（网络受限、其他 provider、权限受限的 key）时只给出提示并继续。

**成功标志**：安装器显示“主节点已就绪”、控制台地址及 `ca.pem` 路径，HTTPS `/health` 的 `scheduling_ready` 为 true。成功后环境文件不再保留首次管理员密码；登录使用刚才输入的密码。

**启动失败**：配置和数据卷会保留。在部署目录执行 `docker compose logs main caddy`，检查主机名解析、端口及模型配置；修复后 `docker compose up -d`。确认 HTTPS 就绪后从 `main.env` 删除 `INITIAL_ADMIN_PASSWORD`，再执行 `docker compose up -d main`。不要通过重跑向导覆盖既有部署。

手动 Docker 部署与升级见 [Docker 指南](docker.md)，Linux systemd 部署见 [运维手册](operations.md#2-安装主节点linux)。

### 在控制台修改模型连接

登录后点击侧栏“模型连接”，可以更换 provider、模型和 API key，并先“测试连接”（发送一个很短的请求，消耗极少量 token）。控制台的设置优先于 `main.env` 中的 `MODEL_*`，只影响之后开始的任务；“恢复为环境变量”会删除控制台设置。API key 用数据卷中的密钥文件加密后保存，不会回显，也不会下发给 worker。任务因 API key 无效而失败时，任务详情的“结束原因”会写明“模型服务拒绝了 API key”，不必再翻容器日志。

## 2. 信任内部 CA

本次安装使用 Caddy 内部 CA，即使地址是公网域名也需要分发根证书。`ca.pem` 是公开根证书，不包含私钥。

- **浏览器机器**：macOS 将证书导入钥匙串并设为受信任的根证书；Linux 按发行版/浏览器的证书管理导入；Firefox 使用其证书设置导入。只信任自己部署导出的证书，不关闭 TLS 校验。
- **执行机器**：默认不需要保存 `ca.pem`。从已经信任的控制台复制带 CA 指纹的安装命令；安装器下载公开根证书、核对指纹并把它保存到 worker 的私有安装目录。

**成功标志**：浏览器能安全打开控制台，worker 安装器显示“CA 指纹已核对”。保留主节点 `caddy-data` 卷；丢失此卷会生成新 CA，须从可信控制台获取新的安装命令。

### 手动 CA 兼容流程

仅在主节点或 worker 低于 v0.3.0，或无法从控制台取得指纹时使用。把 `ca.pem` 复制到执行机器的绝对路径，安装 worker 时用 `--ca` 指定；复制后可确认：

```sh
curl --cacert '/absolute/ca.pem' 'https://plane.internal:8443/health'
```

## 3. 在每台执行机器安装 worker

登录控制台，打开“机器授权 → 添加机器”，选择安装方式，保留“自动获取 CA”，复制生成的一行命令。它包含主节点地址和 CA 指纹，不包含模型 key、管理员密码或设备 token。

### 个人电脑：用户级服务

以普通账户运行，不加 sudo：

```sh
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- worker --server 'https://plane.internal:8443' --ca-fingerprint '<控制台提供的64位指纹>'
```

Linux 需要 systemd 用户会话；管理员可以通过 `loginctl enable-linger <账户>` 让服务退出登录后及重启时继续运行。macOS LaunchAgent 在用户登录后启动。

### 常驻服务器：系统级服务

先准备已有的非 root 账户，它的实际权限决定任务能访问的文件和执行的命令。安装器不创建账户、不调整已有项目权限；需要时只通过 sudo 执行系统级安装与 join：

```sh
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- worker --server 'https://plane.internal:8443' --ca-fingerprint '<控制台提供的64位指纹>' --system --user 'ops'
```

支持 Linux/macOS x86_64/arm64；Linux 二进制需要 glibc 2.17 或更新。安装器自动选择文件并校验 SHA-256，核对 CA 指纹，再安装服务并提交加入申请。CA 被保存到安装目录，后台服务及后续 CLI 自动使用。安装不修改 PATH，命令输出会给出带引号的绝对路径。

**成功标志**：终端显示节点 ID、公钥 SHA-256 指纹及授权状态。申请成功并不意味着已经可执行。

## 4. 在控制台授权

在“机器授权”中核对终端指纹与申请的指纹完全一致，再点击批准。节点 ID 就是公钥 SHA-256 指纹；安装器不会自动批准设备。

| 状态 | 含义与下一步 |
|---|---|
| 等待授权 | 申请已提交，需要管理员批准 |
| 已授权 / 离线 | 已获授权，等待服务领取凭据并连接；持续离线时检查服务和网络 |
| 对账中 | 已连接，正在核对账本，暂不发起任务 |
| 需要核对 | 有无法证明执行状态的调用，按运维手册人工处置 |
| 可执行 | 在线、完成对账且空闲，可以创建会话 |

后台服务每 5 秒检查授权。后续诊断使用安装器输出的 `status --json` 命令；系统级命令带 `--system`。

## 5. 第一个任务

选择“可执行”的机器及默认 workspace，新建独立会话，输入：

> 列出当前工作目录的文件，并报告工作目录路径。

**成功标志**：任务成功，回复和任务时间线有实际执行结果。默认目录自动创建，不会克隆项目或映射整个 home。

已有项目通过 worker 的 `workspace add my-app /absolute/projects/my-app` 添加，再创建绑定该 workspace 的新会话。机器须已授权、服务运行且空闲；系统级命令带 `--system`。跨机器任务通过 Main Agent 委派，文件不会自动在机器之间传输。

## 升级与故障处理

- 升级前暂停主节点调度、等待任务结束并备份。worker 使用同样的安装命令，指定新的正式版本；身份、token 和账本保留，忙时安装失败。升级后验证对账和真实任务，再恢复调度。
- 主节点向导只用于新部署；升级按 [Docker 指南](docker.md#升级) 操作，不能用新目录冒充原部署的升级。
- 下载、校验失败或没有正式 Release：安装器返回非零，不运行下载的二进制；确认网络与版本号，必要时从 Releases 页面手动下载并校验。
- TLS 失败：确认地址和浏览器/控制台的信任状态。根 CA 变化后，从可信控制台重新复制带新指纹的安装命令；手动 CA 模式则重新运行带新 `--ca` 的安装命令。
- 用户级与系统级安装各有独立身份，不要克隆数据目录到第二台机器。撤销、未知执行状态和恢复见 [worker 安装与授权](worker-onboarding.md) 与 [运维手册](operations.md)。

安装器与实机验收的历史记录见 [一行安装验收](dev/acceptance/one-line-install.md)。每次发版后以新用户视角走一遍的流程见 [新用户走查流程](dev/acceptance/first-run-walkthrough.md)。
