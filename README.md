# Willcord

**大脑留在中心，机器只管执行。**

Willcord 是面向内网与生产环境的 AI 运维控制面。模型调用、会话和调度集中在主节点；每台执行机器上的 worker 通过出站 WSS 连接主节点，在限定的工作目录中执行工具。

- **密钥集中**：模型密钥只保存在主节点，执行机器不需要访问模型服务。
- **无需入站端口**：worker 主动连接主节点，执行机器不开放端口。
- **断线先对账，未知不重跑**：重连后先核对执行账本；无法证明执行状态的调用挂起，等待人工核对。
- **跨机器委派**：Main Agent 查看机器状态并把任务委派给各台 worker，支持取消、超时与预算。

产品名、仓库、包名、CLI、服务名与配置路径统一为 Willcord。

[产品介绍页](https://bossoptional.github.io/Willcord/) · [Releases](https://github.com/BossOptional/Willcord/releases) · [安装与首次使用](docs/installation.md) · [架构](docs/architecture.md)

## 安装与开始使用

流程：**安装 willcord 命令 → 启动主节点 → 信任内部 CA → 登录控制台 → 启动 worker → 核对指纹并批准 → 等待“可执行” → 完成一次只读任务**。

**第 1 步：安装命令**（每台机器都做一次，不启动任何服务）：

```sh
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash
```

它只下载、校验并把 `willcord` 放到 `~/.local/bin`（目录不在 `PATH` 里时会打印一行 `export PATH=…`，不会改你的 shell 配置）；装给所有用户用 `bash -s -- --system`。再按机器角色启动：

**第 2 步 · 主节点**（Linux x86_64/arm64，需预先安装 Docker Compose v2；macOS 可用 Docker Desktop 做本机试用）：

```sh
willcord main init
```

向导只问访问地址（自动列出本机探测到的内网 IP 供选择）和首次管理员密码，生成配置、启动服务并导出 `ca.pem`。模型不在安装时设置：登录控制台后在侧栏“模型连接”绑定 API key。让浏览器信任这个根证书后登录控制台。向导结束后会记住部署目录：在任意目录运行 `willcord main status | logs | down | up | upgrade` 即可。执行机器上的命令都在 `willcord worker …` 之下。

**第 2 步 · worker**（Linux/macOS x86_64/arm64；Linux 需要 glibc 2.17 或更新）：在控制台打开“机器授权 → 添加机器”复制命令，也可以直接用 `willcord main init` / `willcord main status` 结尾打印的那一行。在执行机器上以普通账户运行：

```sh
willcord worker join 'https://plane.internal:8443#sha256=<控制台提供的64位指纹>'
```

引号里是一个**加入链接**：主节点地址，加上 `#sha256=` 和主节点根证书的指纹。还没装 willcord 命令的机器，用控制台给出的第一条命令，一步完成安装并加入：

```sh
curl -fsSL https://bossoptional.github.io/Willcord/install.sh | bash -s -- worker 'https://plane.internal:8443#sha256=<控制台提供的64位指纹>'
```

- 指纹只从已信任的控制台复制，不要手写。安装器核对根证书的 SHA-256 指纹后，才建立 HTTPS/WSS 连接；执行机器不必提前复制证书。公共可信证书可以只写地址。
- 机器名默认是主机名，用 `--name 名称` 指定，之后也能在控制台改。
- 常驻服务器加 `--system`（命令前加 `sudo`），以执行 sudo 的账户运行系统级服务；换账户加 `--user 'ops'`，账户必须已存在且不是 root。
- 用户级服务：macOS 在用户登录后启动；Linux 需要 systemd 用户会话。
- 安装器默认安装最新正式 Release，并校验 SHA-256；固定版本加 `--version vX.Y.Z`。
- CA 指纹接入从 v0.3.0 起提供；更早版本使用手动 `--ca`，见[安装指南](docs/installation.md#手动-ca-兼容流程)。分开写的 `--ca-fingerprint` 仍然可用。

在控制台核对终端显示的指纹后批准，等机器显示“可执行”。然后选择默认工作目录创建会话，输入“列出当前工作目录的文件，并报告工作目录路径”。任务成功后，再添加已有项目目录，或用 Main Agent 跨机器委派任务。

- [安装与首次使用](docs/installation.md)：分步操作、成功标志与故障处理
- [Docker 部署与升级](docs/docker.md)
- [worker 手动安装与管理](docs/worker-onboarding.md)
- [systemd 部署与运维手册](docs/operations.md)

## 安全前提

- Bash 以 worker 服务账户的实际权限运行。工作目录限制**不是 shell 沙箱**，应为 worker 使用独立的最小权限账户。
- 当前为单管理员设计，不要向不可信用户开放执行。
- 文件内容、命令输出和会话可能进入模型上下文；采用前确认模型服务的数据处理策略。

详见[安全策略](SECURITY.md)。

## 当前状态

当前版本 v0.1.0-beta.1，处于开发与受控验收阶段。用于生产前，请在自己的环境完成安全、权限与故障恢复验收。

从 v0.5.0 起所有名称统一为 willcord，旧名称下的部署不会被识别，升级步骤见[迁移说明](docs/migrating-to-willcord.md)。

已具备：

- 一行安装主节点与 worker，CA 指纹接入，设备审批与撤销；主节点向导可在 macOS（Docker Desktop）上本机试用
- 控制台“模型连接”：在线更换 provider、模型与 API key，并先测试连接
- 固定 worker 与工作目录的会话，read/write/bash 工具，FIFO 调度
- 执行账本、重连对账与主节点重启恢复
- 取消、超时、任务预算、分块输出与人工处置
- Main Agent 跨机器委派、等待子任务与取消传播
- 实时工作台：机器状态、任务时间线、排队与等待原因
- 调度暂停、在线备份与恢复、升级前快照、token 轮换

尚未交付：跨 NAT 中继（执行机器必须能直接访问主节点）、多用户与权限分级。

设计与开发记录：[架构](docs/architecture.md) · [开发计划](docs/development-plan.md) · [UI 设计](docs/ui-design.md) · [调研](docs/research/README.md) · 各阶段记录 [P1](docs/p1-development.md)–[P7](docs/p7-development.md)

## 许可证与品牌

项目采用 [Apache License 2.0](LICENSE)，第三方依赖见[第三方声明](THIRD_PARTY_NOTICES.md)。品牌名称与 Logo 的使用边界见[品牌说明](BRAND.md)，品牌资产见 [docs/brand/willcord](docs/brand/willcord/README.md)。
