# 从 worker-plane 迁移到 willcord

v0.5.0 把所有仍叫 `worker-plane` / `WorkerPlane` 的名称统一为 `willcord`，**且不兼容旧名称**。旧版本安装的主节点和执行机器不会被新版本识别，需要按下面的步骤重新部署。

## 变了什么

| 项目 | 旧 | 新 |
|---|---|---|
| 环境变量 | `WORKER_PLANE_*` | `WILLCORD_*` |
| worker 二进制 | `worker-plane-worker`，安装为 `<数据目录>/bin/worker`，命令 `install`、`join`… | `willcord`，安装为 `<数据目录>/bin/willcord`，命令改为 `willcord worker install`、`willcord worker join`… |
| worker 用户级数据目录 | `~/.local/share/worker-plane`、`~/Library/Application Support/WorkerPlane` | `~/.local/share/willcord`、`~/Library/Application Support/Willcord` |
| worker 系统级数据目录 | `/var/lib/worker-plane-system`、`/Library/Application Support/WorkerPlane` | `/var/lib/willcord-system`、`/Library/Application Support/Willcord` |
| 服务名 | systemd `worker-plane-<12位>`；launchd `org.workerplane.worker.<12位>` | systemd `willcord-worker-<12位>`；launchd `org.willcord.worker.<12位>` |
| 发布资产 | `worker-plane-worker-<版本>-<os>-<arch>`、`worker-plane-main-<版本>-…tar.gz` | `willcord-<版本>-<os>-<arch>`、`willcord-main-<版本>-…tar.gz` |
| 镜像 | `ghcr.io/1bossx/worker-plane-{main,caddy}` | `ghcr.io/1bossx/willcord-{main,caddy}` |
| Docker 数据卷前缀 | `worker-plane-<hash>_` | `willcord-<hash>_` |
| 手工部署路径和账户 | `/etc/worker-plane`、`/var/lib/worker-plane`、`/opt/worker-plane`，账户 `worker-plane` | 同名换成 `willcord` |
| 管理工具 | `worker-plane-admin` | `willcord-admin` |
| 主节点管理 | 进部署目录手敲 `docker compose …` | `./willcord main status｜logs｜down｜up｜upgrade`（`install.sh main` 只负责下载，向导在 `willcord main init` 里） |
| 手工部署的 worker 单元 | `ExecStart=… /etc/worker-plane/worker.toml` | `ExecStart=/usr/local/bin/willcord worker run --config /etc/willcord/worker.toml`；旧的“把配置文件路径当第一个参数”写法不再支持 |
| 机器注册签名串 | `workerplane-enrollment-v1` | `willcord-enrollment-v1` |

最后一项意味着：新旧版本的 worker 和主节点之间**不能**互相完成机器注册。请两端一起升级。

## 主节点（Docker）

旧部署目录和数据卷不会被新版本使用，也不会被自动删除。

1. 在**旧**部署目录里备份（仍用旧版本镜像）：
   ```bash
   docker compose exec -T main node dist/admin.js backup /var/lib/worker-plane/backup-final.sqlite
   docker compose cp main:/var/lib/worker-plane/backup-final.sqlite ./
   ```
2. 记下旧主节点的 HTTPS 地址和端口。新旧部署不能同时监听同一个端口，所以先 `docker compose down` 停掉旧的（数据卷保留）。
3. 用新安装器部署到**新**目录，向导走完后主节点已就绪：
   ```bash
   curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- main --dir ./willcord
   ```
4. 把备份恢复进新部署，步骤见 [Docker 部署 §备份与恢复](docker.md)，其中的路径已经是 `/var/lib/willcord/…`。恢复后调度处于暂停状态，按[运维手册 §8](operations.md#8-从备份恢复)核对后再恢复。
5. 新部署的 Caddy 会生成**新的**根证书。浏览器要重新信任新的 `ca.pem`；worker 用控制台“添加机器”里的新命令安装时会自动核对。
6. 确认一切正常后，在旧目录执行 `docker compose down -v` 删除旧数据卷。这一步不可恢复，请先确认备份文件已保存。

## 主节点（systemd 手工部署）

1. 停止并禁用旧单元：`systemctl disable --now worker-plane-main worker-plane-backup.timer`。
2. 用旧版本的 `admin.js backup` 备份 `/var/lib/worker-plane/main.sqlite`。
3. 按[运维手册](operations.md)全新部署 v0.5.0（路径为 `/etc/willcord`、`/var/lib/willcord`、`/opt/willcord`，账户 `willcord`，单元 `willcord-main.service`、`willcord-backup.timer`）。
4. 用新版本的 `admin.js restore` 恢复备份，再按 §8 核对并恢复调度。
5. 清理旧的单元文件、`/etc/worker-plane`、`/var/lib/worker-plane` 和旧账户。

## 执行机器（worker）

机器身份保存在数据目录里，目录名变了，新版本会当作一台全新的机器。

1. 在旧机器上用**旧版本**二进制卸载服务并删除数据：
   ```bash
   <旧数据目录>/bin/worker uninstall --delete-data   # 旧版本的命令没有 worker 前缀
   ```
   系统级服务加 `--system` 并用 sudo。手工部署的 worker 则停用并删除 `worker-plane-worker.service` 或 `com.workerplane.worker.plist`。
2. 在控制台“机器授权”里吊销旧机器记录。
3. 用控制台“添加机器”生成的新命令重新安装并 join，核对指纹后批准，等机器显示“可执行”。

## 浏览器

控制台的登录状态和未发送的草稿保存在浏览器的 localStorage 里，键名也已改名。升级后需要重新登录，未发送的草稿会丢失。

## 回滚

旧数据卷、旧目录和备份文件在你手动删除之前一直保留。迁移出问题时，停掉新部署，在旧目录里 `docker compose up -d` 即可回到旧版本。
