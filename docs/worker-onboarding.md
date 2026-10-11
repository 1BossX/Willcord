# Worker 安装与授权

**首次接入请按 [安装与首次使用](installation.md) 操作**，从控制台复制带 CA 指纹的一行命令即可（v0.3.0 起；细节见 [CA 指纹自动接入](installation.md#ca-指纹自动接入)）。本文覆盖手动二进制安装、系统级服务细节、工作目录、私有 CA，以及升级、撤销与卸载。

新机器无需填写 TOML 或复制 token。安装 worker、申请加入、在控制台核对指纹并批准后，worker 自动领取凭据，注册并对账。默认工作目录自动创建；已有项目按需添加。

## 推荐：一行安装

首次部署和机器接入优先按 [安装与首次使用](installation.md) 操作。控制台“机器授权 → 添加机器”可生成命令。下面保留手动安装、已有节点管理与运维细节。

## 安装

从版本 Release 下载匹配平台的 `willcord-<版本>-<os>-<arch>` 及其 `.sha256`；Linux/macOS 各支持 x86_64 与 arm64（文件架构名由 uname 给出，arm64 为 aarch64 或 arm64）。Linux 二进制按 glibc 2.17 链接，可在 CentOS 7、Debian 10、Ubuntu 20.04 及更新的发行版上运行；发布流程会在旧发行版容器中实际运行它。Linux 需要 systemd 用户会话；macOS 需要登录图形会话。

```sh
shasum -a 256 -c willcord-<版本>-<os>-<arch>.sha256
chmod +x willcord-<版本>-<os>-<arch>
./willcord-<版本>-<os>-<arch> worker install
```

安装输出已安装二进制的绝对路径和服务名称。后面的 `willcord` 指该二进制（所有执行机器的命令都在 `willcord worker` 之下，`willcord main` 是主节点的命令）；默认不会改写 shell PATH。Linux 二进制位于 `~/.local/share/willcord/bin/willcord`；macOS 位于 `~/Library/Application Support/Willcord/bin/willcord`。

```sh
willcord worker join https://plane.internal:8443
willcord worker status --json
```

控制台打开“机器授权”，核对终端节点 ID 与控制台指纹，再批准。服务每 5 秒检查授权；获准后自动注册、完成对账。机器上线不等于可执行，需显示“可执行”。创建独立会话时选择默认 workspace 即可。

Linux 服务名含数据目录摘要；`willcord worker status` 显示 `service_name`。用户级服务在用户退出后及重启时保持运行，需要管理员配置 `loginctl enable-linger <用户名>`；macOS LaunchAgent 只在用户登录后启动。服务器需要开机即运行时，改用下面的系统级服务。

## 系统级服务

系统级服务开机启动、不依赖登录会话，所有命令以指定的普通账户运行。账户需事先存在、不能是 root，并对要执行的工作目录有权限：

```sh
sudo ./willcord-<版本>-<os>-<arch> worker install --system --user <账户>
sudo <安装输出的路径> worker join --system https://plane.internal:8443
sudo <安装输出的路径> worker status --system --json
```

| | Linux | macOS |
|---|---|---|
| 服务定义 | `/etc/systemd/system/<服务名>.service`，`WantedBy=multi-user.target` | `/Library/LaunchDaemons/<服务名>.plist` |
| 二进制与 `system.json` | `/var/lib/willcord-system/`，root 所有 | `/Library/Application Support/Willcord/`，root 所有 |
| 身份、账本、token、默认目录 | 上述目录下的 `data/`，服务账户所有，0700 | 同左 |

二进制和 `system.json` 归 root 所有，服务账户不能替换自己运行的程序。`worker join`、`worker status`、`worker workspace` 加 `--system` 后先切换到服务账户再读写数据，不会生成 root 所有的文件，可以用 sudo 运行，也可以直接以服务账户运行。私有 CA 在 install 时用 `sudo SSL_CERT_FILE=/absolute/ca.pem ... worker install --system --user <账户>` 传入，安装器把它复制为安装根目录下的 `ca.pem`（0644，root 所有），之后的命令和服务自动使用这份副本，原文件放在 `/root` 等服务账户读不到的位置也可以。更换 CA 时带上新的 `SSL_CERT_FILE` 重新 install。macOS 的 LaunchDaemon 写入服务账户的 `HOME`；systemd 的 `User=` 会自动设置。

同一台机器上的用户级安装和系统级安装是两个独立节点，各有身份和服务名。升级时用新二进制重新运行同样的 `willcord worker install --system --user <账户>`；更换账户需要先卸载。`WILLCORD_SYSTEM_ROOT` 可指定其他安装根目录。

## 工作目录

默认目录位于应用数据目录的 `workspaces/default`，不自动克隆项目，不映射整个 home。连接已有项目：

```sh
willcord worker workspace add my-app /absolute/projects/my-app
willcord worker workspace list
```

目录必须已存在，ID 不重复。服务必须运行、机器已授权并空闲；有在途任务时命令失败且不修改配置。成功后更新映射版本并重新注册；旧会话需要重新创建，不静默改绑目录。文件读写继续受 workspace 边界保护。

## 私有 CA

把受信任 CA 的 PEM 放在持久绝对路径。安装时设置 `SSL_CERT_FILE`，安装器将证书复制到安装目录，服务和后续 join/status 自动使用这份副本；显式 SSL_CERT_FILE 优先。既有 service-ca 外部路径在重新 install 时迁移为副本。不要使用关闭 TLS 校验的参数。

```sh
SSL_CERT_FILE=/absolute/ca.pem willcord worker install
willcord worker join https://plane.internal:8443
willcord worker status --json
```

安装成功后原始 CA 文件可以移走，必须保留安装目录内副本；更换 CA 时带新 SSL_CERT_FILE 重新 install。凭据只保存在私有文件，主节点只保存摘要。入网挑战 5 分钟有效、单次使用，签名绑定操作和申请元数据。

## 升级、撤销与卸载

升级前暂停主节点调度，等待任务结束，再运行校验过的新二进制的 install。安装器保留身份、配置、账本和 token；检测到执行槽占用时拒绝在线升级。完成后检查 status、账本对账及真实任务，再恢复调度。

控制台撤销设备授权会撤销它的全部 token 并断开连接；不会释放在途执行槽或把未知调用重新执行。重新批准后服务自动领取新凭据并重新对账；需要人工核对的调用仍须按运维流程处置。仅撤销某个 token 和撤销设备授权含义不同：设备仍获授权时可以重新领取凭据。

```sh
willcord worker uninstall                 # 停止服务，保留数据
willcord worker uninstall --delete-data   # 同时删除该安装的数据
sudo willcord worker uninstall --system [--delete-data]   # 系统级服务；--delete-data 删除整个安装根目录
```

私钥和账本应一起保留，不能克隆给第二台机器。身份丢失时不要按相同显示名称接管旧机器；撤销旧设备、核对未完成任务，以新身份重新加入。token 文件丢失且旧凭据已确认时，先撤销设备再批准，允许安全重新签发。

`WILLCORD_HOME` 可指定隔离数据目录；同一目录只有一个执行进程，服务名随目录区分。手动部署（systemd、launchd 单元，见[运维手册](operations.md)）用 `willcord worker run --config worker.toml` 启动，仍可使用 `token` 文件；既有节点不自动转换。

## 验收记录

具体验收结果与未完成项见 [安装注册验收记录](dev/acceptance/worker-onboarding.md)。
