# 安装与首次使用

推荐路线：**安装 willcord 命令 → 启动主节点 → 信任内部 CA → 登录控制台 → 绑定模型 API key → 启动 worker → 核对指纹批准 → 等待可执行 → 完成第一次诊断**。先装命令，再用命令启动：主节点用 `willcord main init`，执行机器用 `willcord worker join`。主节点通过 Docker Compose 部署；worker 装在每台执行机器的宿主机上。

安装器需要 Bash 3.2+、curl 和 shasum/sha256sum。

- 只使用已发布的正式 Release，并校验 SHA-256；没有正式版本时退出，不使用草稿、预发布或源码构建结果。正式版本是 `vX.Y.Z`，以及不勾选 GitHub prerelease 的 `vX.Y.Z-beta.N`（例如 `v0.1.0-beta.1`）。
- 省略 `--version` 时安装 GitHub latest 指向的正式版本并显示实际版本，所以一行安装可以装到 `0.1.0-beta.1` 这种 beta 号；固定版本加 `--version`。
- 其他预发布版本（如 `v0.3.0-rc.1`）只用于验收，须用 `--version` 显式指定，安装器会标明“预发布”。一行安装和 Pages 不会把它们当成 latest。
- Pages 上的 `install.sh` 是最新正式 Release 附带的那一份，与它下载的二进制和镜像同版本；需要旧版本的安装器时，从对应 Release 下载 `install.sh` 并校验 `.sha256`。

## 0. 安装 willcord 命令

每台机器（主节点和执行机器）先装同一个 `willcord` 命令：

```sh
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash
```

这一步只下载、校验 SHA-256，并把 `willcord` 放到 `~/.local/bin`；**不启动任何服务，不改 shell 配置**。目录不在 `PATH` 里时会打印一行 `export PATH="$HOME/.local/bin:$PATH"`，加进去即可。需要装给所有用户时加 `--system`（放到 `/usr/local/bin`，通过 sudo 完成）：

```sh
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash -s -- --system
```

装好后按机器角色启动：

| 机器 | 启动命令 | 说明 |
|---|---|---|
| 主节点 | `willcord main init` | 见 [1. 启动主节点](#1-在主节点机器部署) |
| 执行机器 | `willcord worker join 'https://主节点地址#sha256=<指纹>'` | 见 [3. 启动 worker](#3-在每台执行机器安装-worker) |

**一步完成**：还没装命令的机器，`install.sh main …` 和 `install.sh worker '加入链接'` 等于“安装命令后立刻执行 `willcord main init` / `willcord worker join`”。控制台“添加机器”两种都会给出。

## CA 指纹自动接入

控制台“机器授权 → 添加机器”默认选择“自动获取 CA”。浏览器仍需先信任主节点导出的根证书；执行机器无需提前复制证书。控制台通过已信任的 HTTPS 获取公开根证书，计算证书 DER 的 SHA-256 指纹，并写进命令。`willcord main init` 和 `willcord main status` 也会直接打印同样的命令。

命令里的地址取自主节点的 `PUBLIC_BASE_URL`，不是浏览器当前打开的地址；用 localhost 打开控制台时会提示“其他机器连不上”。

在执行机器上运行；命令带一个**加入链接**，即主节点地址 + `#sha256=` + 根证书指纹：

```sh
# 已装过 willcord 命令
willcord worker join 'https://plane.internal:8443#sha256=<控制台提供的64位十六进制指纹>'

# 还没装命令：一步完成安装并加入
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash -s -- worker 'https://plane.internal:8443#sha256=<控制台提供的64位十六进制指纹>'
```

CA 指纹接入从 v0.3.0 起提供，主节点与 worker 须同为 v0.3.0 或更新版本。更早的版本使用[手动 CA 兼容流程](#手动-ca-兼容流程)。

`willcord` 仅在获取 `/.well-known/willcord/ca.pem` 这一个请求中暂不验证证书，不携带登录凭据、不跟随重定向，并限制响应大小。核对根证书指纹后，所有 HTTPS/WSS 请求恢复完整证书链及主机名验证。错误指纹会在安装前退出，什么都不会安装。不要从同一条未经验证的连接取得并信任指纹；应从已信任的控制台或其他独立渠道复制。

系统级安装加 `--system`，服务以执行 sudo 的账户运行；换账户加 `--user 'ops'`。手动 `--ca '/absolute/ca.pem'` 继续可用；公共证书或系统已信任的内部 CA 可只写地址、不带 `#sha256=`。链接里的指纹不能与 `--ca`、`--ca-fingerprint` 同用；分开写的 `--ca-fingerprint` 仍然可用。自动取得的 CA 会保存到安装目录，后续命令及服务自动复用。

主节点 CA 指纹与授权时核对的 worker 公钥指纹不同。CA 更新后应从可信控制台重新获取命令。浏览器证书信任、管理员批准设备和首次任务验收仍需分别完成。

## 1. 在主节点机器部署

先按 [0. 安装 willcord 命令](#0-安装-willcord-命令) 装好命令。

准备 Linux x86_64/arm64 主机、Docker 和 Docker Compose v2。macOS（Docker Desktop）同样可以运行向导，适合本机试用：Docker Desktop 退出后服务随之停止，生产环境请使用 Linux。浏览器和执行机器必须能解析并访问同一个主节点地址；仅在本机试用时可以用 `https://localhost:8443`，但 `localhost` 在其他执行机器上指向它们自己，跨机器部署须使用对方能解析的主机名或 IP。向导不安装 Docker，不改变系统权限。

```sh
willcord main init
```

`willcord main init` 完成配置（安装的是同一个二进制，之后也用它管理主节点；镜像版本取自这个二进制自身的版本）。向导通过终端只收集两项：主节点的 HTTPS 地址，以及至少 16 字符的管理员密码（输入不回显）。地址会自动探测本机网卡，按“私有网段（192.168/16、10/8、172.16/12）→ 100.64/10（含 Tailscale）→ 其他”列出候选，已排除回环、链路本地、Docker 等容器网卡、虚拟机网桥（如 macOS 的 `bridge*`）和代理软件的虚拟网卡（198.18.0.0/15）。Tailscale、ZeroTier、NetBird 的地址会保留并标注：`tailscale0`、`wt0`（NetBird）、`zt*` 和 macOS 上 ZeroTier 使用的 `feth*` 按名字识别，macOS 上落在 100.64.0.0/10 的 `utun*` 标为“Tailscale / NetBird”（二者默认同一网段，无法区分）。同一网段内真实网卡（`en*`、`eth*`、`wl*`）排在前面，其次是覆盖网络；输入序号选择，直接回车取第 1 项，也可以输入完整的 `https://` 地址或域名。探测不到任何地址时默认 `https://plane.internal:8443`。DHCP 分配的 IP 换网络后会变，长期使用建议改用固定 IP 或域名；覆盖网络地址通常稳定，但执行机器必须加入同一个覆盖网络才能访问它。模型不在向导里设置，登录后在控制台绑定（见下文）。向导结束时会先给出 `willcord trust-ca` 命令（信任根证书，见[下文](#2-信任内部-ca)），并把 `willcord` 命令装到 PATH（见[下文](#willcord-命令放在哪里)）。也可以预先指定地址和目录：

```sh
willcord main init --server 'https://plane.internal:8443' --dir '/opt/my-plane'
```

没有先装命令时，也可以一步完成：`curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash -s -- main`（参数与上面相同）。

目录默认 `./willcord`，当前账户必须可写。向导生成 `compose.yaml`、`.env` 和 `main.env`，固定镜像版本；环境文件权限 0600，不要提交到 Git。不同目录使用独立的 Compose 项目及数据卷。已有部署文件时拒绝覆盖。

`main.env` 只含 `PUBLIC_BASE_URL` 和首次管理员密码，不含 `MODEL_*`。在绑定模型之前主节点照常启动，控制台顶部会显示“尚未绑定模型”的提示，任务暂时无法执行。

**成功标志**：向导显示“主节点已就绪”、控制台地址及 `ca.pem` 路径，HTTPS `/health` 的 `scheduling_ready` 为 true。成功后环境文件不再保留首次管理员密码；登录使用刚才输入的密码。

**启动失败**：配置和数据卷会保留。在部署目录执行 `docker compose logs main caddy`，检查主机名解析、端口及模型配置；修复后 `docker compose up -d`。确认 HTTPS 就绪后从 `main.env` 删除 `INITIAL_ADMIN_PASSWORD`，再执行 `docker compose up -d main`。不要通过重跑向导覆盖既有部署。

**日常管理**：在任意目录直接运行 `willcord main …`。向导记住了它刚创建的部署目录；在另一个部署目录里运行，或用 `--dir` 指定，则以那个为准。

```sh
willcord main status                      # 容器状态，加上用部署自己的 CA 检查 /health
willcord main logs main caddy --tail 100  # 其余参数原样交给 docker compose logs
willcord main down                        # 停止，数据卷保留
willcord main up
willcord main upgrade --image-version vX.Y.Z   # 改 .env 里的镜像版本，pull 并重启
```

v0.5.0/v0.6.0 部署的 `compose.yaml` 默认仍指向已失效的旧镜像路径 `ghcr.io/1bossx`。`upgrade` 发现这种情况会在改动任何文件之前报错退出（拉取镜像失败时也会把 `.env` 恢复成升级前的样子）；先在 `.env` 里设置 `WILLCORD_REGISTRY=ghcr.io/bossoptional` 再升级（见[迁移说明](migrating-to-willcord.md)）。判断与 Compose 一致：shell 环境变量优先，其次是 `.env` 里**最后一次**赋值，最后才是 `compose.yaml` 的默认值，所以文件里残留的旧行只要后面有新值就不影响。

查找顺序：`--dir`，然后是 `willcord` 所在目录、当前目录，最后是上次 `main init` 记下的目录（保存在 `~/.config/willcord/main-dir`）。记下的目录不存在时会直接指出路径，而不是悄悄换一个。

升级前先按 [Docker 指南](docker.md#升级)备份；`main upgrade` 不会替你备份，也不会改写 `compose.yaml`。

手动 Docker 部署与升级见 [Docker 指南](docker.md)，Linux systemd 部署见 [运维手册](operations.md#2-安装主节点linux)。

### 在控制台绑定模型连接

首次登录后，点击顶部提示里的“绑定模型”（或侧栏“模型连接”），默认 provider 为 openrouter、模型为 `deepseek/deepseek-v4.1-flash`，只需填入 API key 即可；也可以更换 provider、模型和 API key，并先“测试连接”（发送一个很短的请求，消耗极少量 token）。控制台的设置优先于 `main.env` 中的 `MODEL_*`，只影响之后开始的任务；“恢复为环境变量”会删除控制台设置。API key 用数据卷中的密钥文件加密后保存，不会回显，也不会下发给 worker。任务因 API key 无效而失败时，任务详情的“结束原因”会写明“模型服务拒绝了 API key”，不必再翻容器日志。

## 2. 信任内部 CA

本次安装使用 Caddy 内部 CA，即使地址是公网域名也需要分发根证书。`ca.pem` 是公开根证书，不包含私钥。

- **控制台所在的机器（推荐）**：运行 `willcord trust-ca`，把主节点地址和根证书指纹一起交给它；`willcord main init` 结束时打印的命令已经带好这两项。

```sh
willcord trust-ca 'https://plane.internal:8443#sha256=<控制台或 willcord main init 给出的 64 位指纹>'
```

  命令按下面的顺序执行，任何一步失败都不会导入证书：

  1. 只在取 `/.well-known/willcord/ca.pem` 这一个请求中暂不校验证书；请求不带凭据、不跟随重定向，并限制响应大小。
  2. 计算证书 DER 的 SHA-256，必须与链接 `#sha256=` 或 `--ca-fingerprint` 给出的指纹一致。两者都没有时，命令会打印指纹，并要求你输入从已信任或独立渠道取得的指纹（大小写、冒号不敏感）；直接回车或输入不一致则取消。这个打印出来的值与证书来自同一次未验证的连接，本身不能证明证书可信，不能作为核对依据。非终端环境下直接拒绝，需要用 `--ca-fingerprint` 指定。
  3. 只用这张根证书验证主节点 `/health`，不叠加本机已有的系统根证书；本机已信任的其他证书不能让这一步通过，也不能因此导入这份 CA。之后的请求都正常校验证书链和主机名。
  4. 导入系统信任库：macOS 用 `security add-trusted-cert` 写入 System.keychain，需要管理员密码；Debian/Ubuntu 用 `update-ca-certificates`；其他系统打印手动步骤（如 Fedora 的 `update-ca-trust`）。

  命令可以重复运行：同一根证书每次保存到同一个文件，Linux 信任库里的文件名也由指纹决定，不会堆积重复项。
  **Firefox 不使用系统信任库，需要单独导入**：设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入，选择 `ca.pem`，并勾选“信任此 CA 以标识网站”。

- **不想用命令**：控制台登录页的「信任证书」一节提供 `ca.pem` 下载、根证书指纹，以及 macOS / Linux / Windows / Firefox 的操作步骤。页面上显示的指纹与 `ca.pem` 来自同一次连接，登录页本身不是独立的信任起点，不能用它核对自己。请先从已信任或独立的渠道（例如管理员另行告知的值）取得指纹，与页面显示的值逐位核对，一致后再信任。
- **执行机器**：默认不需要保存 `ca.pem`。从已经信任的控制台复制带 CA 指纹的安装命令；安装器下载公开根证书、核对指纹并把它保存到 worker 的私有安装目录。

**成功标志**：浏览器能安全打开控制台；`willcord trust-ca` 显示“HTTPS 校验通过”及导入结果；worker 安装器显示“CA 指纹已核对”。保留主节点 `caddy-data` 卷；丢失此卷会生成新 CA，须从可信控制台获取新的安装命令。

### 手动 CA 兼容流程

仅在主节点或 worker 低于 v0.3.0，或无法从控制台取得指纹时使用。把 `ca.pem` 复制到执行机器的绝对路径，安装 worker 时用 `--ca` 指定；复制后可确认：

```sh
curl --cacert '/absolute/ca.pem' 'https://plane.internal:8443/health'
```

## 3. 在每台执行机器安装 worker

登录控制台，打开“机器授权 → 添加机器”，复制生成的命令（需要换成系统级服务或手动 CA 时展开“高级选项”）。它包含主节点地址和 CA 指纹，不包含模型 key、管理员密码或设备 token。已装好 willcord 命令的机器用第二条，还没有的用第一条：

```sh
# 个人电脑：用户级服务，不加 sudo
willcord worker join 'https://plane.internal:8443#sha256=<控制台提供的64位指纹>'

# 常驻服务器：系统级服务（命令需用 --system 装到 /usr/local/bin，sudo 才找得到）
sudo willcord worker join 'https://plane.internal:8443#sha256=<控制台提供的64位指纹>' --system
```

机器名默认是主机名；用 `--name 名称` 指定，之后也能在控制台改。

### 个人电脑：用户级服务

以普通账户运行，不加 sudo：

```sh
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash -s -- worker 'https://plane.internal:8443#sha256=<控制台提供的64位指纹>'
```

Linux 需要 systemd 用户会话；管理员可以通过 `loginctl enable-linger <账户>` 让服务退出登录后及重启时继续运行。macOS LaunchAgent 在用户登录后启动。

### 常驻服务器：系统级服务

先准备已有的非 root 账户，它的实际权限决定任务能访问的文件和执行的命令。服务默认以运行安装命令的账户（用 sudo 时是执行 sudo 的账户）运行，换账户加 `--user 'ops'`。安装器不创建账户、不调整已有项目权限；需要时只通过 sudo 执行系统级安装与 join：

```sh
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash -s -- worker 'https://plane.internal:8443#sha256=<控制台提供的64位指纹>' --system
```

支持 Linux/macOS x86_64/arm64；Linux 二进制需要 glibc 2.17 或更新。安装器自动选择文件并校验 SHA-256，然后交给 `willcord worker join` 一步完成：核对 CA 指纹、安装服务、提交加入申请。CA 被保存到安装目录，后台服务及后续 CLI 自动使用。`willcord` 命令同时装到 PATH（见[下文](#willcord-命令放在哪里)），之后的命令都直接写 `willcord worker …`。

**成功标志**：终端显示节点 ID、公钥 SHA-256 指纹及授权状态。申请成功并不意味着已经可执行。

### willcord 命令放在哪里

`install.sh`（不带角色）、主节点向导和 worker 安装器都会把同一个 `willcord` 放到固定位置，所以先装哪一个都行：

| 安装方式 | 命令位置 |
|---|---|
| 用户级（`install.sh`、主节点向导、个人电脑的 worker） | `~/.local/bin/willcord` |
| 系统级（`install.sh --system`、系统级 worker） | `/usr/local/bin/willcord` |

- 目录不在 `PATH` 里时，安装器只打印一行 `export PATH="$HOME/.local/bin:$PATH"`，不会改 `~/.zshrc` 等任何 shell 配置文件；想永久生效请自己加进去。
- 该位置已有不是 willcord 安装的同名文件时，不覆盖，并告诉你；服务照常运行，命令则继续显示带引号的绝对路径。
- 服务运行的是它自己数据目录里的那份，不是 PATH 上这份。替换或删除 PATH 上的命令不会影响正在运行的服务；重新运行安装命令即升级。
- worker 的 `uninstall` 会保留 PATH 上的命令（主节点命令也在用它）。不再需要时运行 `willcord self-uninstall`（系统级加 `sudo` 和 `--system`），它只删除 willcord 自己装的那份。
- 也可以手动放置：`willcord self-install [--system]`。

## 4. 在控制台授权

在“机器授权”中核对终端指纹与申请的指纹完全一致，再点击批准。节点 ID 就是公钥 SHA-256 指纹；安装器不会自动批准设备。

| 状态 | 含义与下一步 |
|---|---|
| 等待授权 | 申请已提交，需要管理员批准 |
| 已授权 / 离线 | 已获授权，等待服务领取凭据并连接；持续离线时检查服务和网络 |
| 对账中 | 已连接，正在核对账本，暂不发起任务 |
| 需要核对 | 有无法证明执行状态的调用，按运维手册人工处置 |
| 可执行 | 在线、完成对账且空闲，可以创建会话 |

后台服务每 5 秒检查授权。后续诊断使用 `willcord worker status --json`；系统级命令前加 `sudo`、后面带 `--system`。

## 5. 第一次诊断

机器显示“可执行”且控制台已绑定模型 API key 后，工作台首页会出现**首次诊断**入口，三个场景任选其一：

1. Docker 服务起不来  
2. 磁盘用量异常  
3. 部署后检查  

点选后会创建默认工作目录上的独立会话并发送诊断任务。**成功标志**：任务进入执行并完成，回复与任务时间线有实际检查输出；在场景入口合入后，结果会按「结论、证据、建议的下一步」展示。

批准 worker 后，若模型已绑定，工作台会自动打开第一个场景（Docker 服务起不来）的会话；也可在机器卡片里手动换场景。

已有项目通过 `willcord worker workspace add my-app /absolute/projects/my-app` 添加，再创建绑定该 workspace 的新会话。机器须已授权、服务运行且空闲；系统级命令带 `--system`。跨机器任务通过 Main Agent 委派，文件不会自动在机器之间传输。

### 常见卡住点（各有一句原因与下一步）

| 情况 | 原因与下一步 |
|---|---|
| 未安装 Docker / Compose v2 / 无法访问守护进程 | `willcord main init` 或 `install.sh main` 会说明需要先安装 Docker Engine 与 Compose v2、启动服务并确认账户权限；向导**不会**替你安装 Docker 或改系统权限。 |
| 浏览器尚未信任 CA | 登录页无法连接或证书报错时，按登录页「信任证书」或运行 `willcord trust-ca` 导入根证书后再登录。 |
| worker 连不上主节点 | 控制台机器离线：在执行机器上运行「添加机器」命令，确认服务运行且加入链接地址与主节点 `PUBLIC_BASE_URL` 一致（避免其他机器无法用的 localhost）。 |
| 尚未绑定模型 key | 控制台顶部「尚未绑定模型」：打开「模型连接」填入 API key 并保存。 |

## 升级与故障处理

- 升级前暂停主节点调度、等待任务结束并备份。worker 使用同样的安装命令，指定新的正式版本；身份、token 和账本保留，忙时安装失败。升级后验证对账和真实任务，再恢复调度。
- 主节点向导只用于新部署；升级按 [Docker 指南](docker.md#升级) 操作，不能用新目录冒充原部署的升级。
- 下载、校验失败或没有正式 Release：安装器返回非零，不运行下载的二进制；确认网络与版本号，必要时从 Releases 页面手动下载并校验。
- TLS 失败：确认地址和浏览器/控制台的信任状态。根 CA 变化后，从可信控制台重新复制带新指纹的安装命令；手动 CA 模式则重新运行带新 `--ca` 的安装命令。
- 用户级与系统级安装各有独立身份，不要克隆数据目录到第二台机器。撤销、未知执行状态和恢复见 [worker 安装与授权](worker-onboarding.md) 与 [运维手册](operations.md)。

安装器与实机验收的历史记录见 [一行安装验收](dev/acceptance/one-line-install.md)。每次发版后以新用户视角走一遍的流程见 [新用户走查流程](dev/acceptance/first-run-walkthrough.md)。外人从安装到第一次诊断的步骤记录见 [安装到首次诊断](dev/acceptance/install-to-first-diagnosis.md)。
