# 用 Docker 部署主节点

适用于 v0.2.0 及以上版本。主节点和 Caddy 各一个容器，用 Docker Compose 管理；行为与 [运维手册](operations.md) 的 systemd 部署相同，本文只写不同之处。worker 仍装在每台被管理的机器上（[worker 安装与授权](worker-onboarding.md)），不放进容器：它要在宿主机上执行命令。

## 镜像

| 镜像 | 内容 |
|---|---|
| `ghcr.io/1bossx/worker-plane-main:<版本>` | Node 主节点，以 `node` 用户（uid 1000）运行，监听容器内 3000 端口 |
| `ghcr.io/1bossx/worker-plane-caddy:<版本>` | Caddy、内部 CA 和网页 UI |

每个 `v*` 标签发布 linux/amd64 和 linux/arm64 两个架构，版本号去掉前缀 `v`，例如 `v0.3.0` 对应 `0.3.0`。不发布 `latest`，部署时固定版本。也可以在仓库根目录自行构建：`docker build -f deploy/docker/Dockerfile --target main .`（Caddy 用 `--target caddy`）。

## 推荐：初始化向导

新的 Linux 部署（或 macOS Docker Desktop 本机试用）可运行一行安装向导，自动生成配置、启动服务并导出 CA；步骤与成功标志见 [安装与首次使用](installation.md)。已有部署请按本文升级章节操作。下面保留手动配置方式。

## 安装

1. 准备目录，复制 `deploy/docker/compose.yaml`，并在同一目录写 `.env`：

   ```bash
   WORKER_PLANE_VERSION=0.4.1
   WORKER_PLANE_SITE=plane.internal:8443
   WORKER_PLANE_PORT=8443
   ```

   `WORKER_PLANE_SITE` 是浏览器和 worker 访问的地址，端口必须等于 `WORKER_PLANE_PORT`，宿主机上发布的也是这个端口。

2. 复制 `deploy/main.env.example` 为同目录的 `main.env`，权限 0600，填入值。`PUBLIC_BASE_URL` 必须是 `https://` 加 `WORKER_PLANE_SITE`；`DATA_DIR`、`HOST`、`PORT` 已由镜像设置，不要填。`INITIAL_ADMIN_PASSWORD` 只在第一次启动时需要，启动成功后删掉这一行。

3. 启动并检查：

   ```bash
   docker compose up -d
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./ca.pem
   curl --cacert ca.pem https://plane.internal:8443/health
   ```

   预期 `alive` 和 `scheduling_ready` 均为 true、`dispatch_paused` 为 null。启动失败看 `docker compose logs main`，配置问题会一次全部列出。

4. 让浏览器所在机器信任 `ca.pem`。worker 默认从已信任控制台复制带 CA 指纹的安装命令；安装器会验证并保存根证书，无需先把文件交给每台 worker。手动 CA 和旧版本兼容流程仍可使用 `ca.pem`。

## 控制台里的模型设置

在控制台“模型连接”保存的 provider、模型和 API key 存在 `main-data` 卷：设置在 `main.sqlite` 里，API key 经 AES-256-GCM 加密，密钥文件 `model-secret.key`（0600）在同一卷。在线备份只含 `main.sqlite`，不含密钥文件，所以备份本身不带明文 key；把备份恢复到另一个数据卷后，控制台会提示“已保存的 API key 无法解密”，重新输入一次即可。控制台设置优先于 `main.env`；“恢复为环境变量”回到 `main.env` 的配置。

## 必须保留的两个卷

- `main-data`：`main.sqlite`、`main.lock` 和运行数据。放在本地磁盘；不要放在 NFS 或 Docker Desktop 的共享目录上，SQLite 的 WAL 和锁在那里不可靠。
- `caddy-data`：Caddy 的内部 CA。这个卷丢失后 CA 会重新生成；从可信控制台重新复制带新指纹的安装命令，并重新安装各 worker。

`docker compose down` 保留卷；不要加 `-v`。

## 停止与异常退出

`docker compose stop main` 发送 SIGTERM，主节点关闭连接和数据库并释放 `main.lock`，compose 中的 `stop_grace_period: 30s` 与 systemd 单元一致。

主节点容器设为 `restart: "no"`，原因同 [运维手册 §10](operations.md#10-主节点异常退出后)：被 `docker kill`、OOM 或宿主机断电结束后，锁会留下，再次启动以 `EEXIST ... main.lock` 退出。处理：

```bash
docker compose ps -a main          # 确认状态是 exited，没有正在运行的 main
docker compose run --rm --no-deps -T main cat /var/lib/worker-plane/main.lock/owner.json
docker compose run --rm --no-deps -T main node -e "require('fs').rmSync('/var/lib/worker-plane/main.lock',{recursive:true})"
docker compose start main
```

容器里主节点的 pid 总是 1，`owner.json` 里的 pid 不能用来判断旧进程；以 `docker compose ps` 和宿主机上没有其他容器挂载 `main-data` 为准。只运行一个 main 容器，不要扩容副本。

## 备份与恢复

在线备份（主节点不停）：

```bash
docker compose exec -T main node dist/admin.js backup /var/lib/worker-plane/backup-$(date +%F).sqlite
docker compose cp main:/var/lib/worker-plane/backup-$(date +%F).sqlite ./
```

再把文件复制到另一台机器或对象存储。

恢复：

```bash
docker compose stop main
docker compose run --rm --no-deps -T main sh -c 'cat > /var/lib/worker-plane/restore.sqlite' < ./backup.sqlite
docker compose run --rm --no-deps -T main node dist/admin.js restore /var/lib/worker-plane/restore.sqlite
docker compose start main
```

备份文件经容器内的 `node` 用户写入数据卷；不要用 `docker compose cp` 往里复制，它保留宿主机的属主和 0600 权限，主节点读不到。启动后 `/health` 显示 `"dispatch_paused":"restored"`，之后按 [运维手册 §8](operations.md#8-从备份恢复) 第 3 步起核对并恢复调度。

## 升级

1. 按 [运维手册 §6](operations.md#6-升级) 暂停调度、等待任务结束并备份。
2. 修改 `.env` 里的 `WORKER_PLANE_VERSION`，执行 `docker compose pull && docker compose up -d`。有新迁移时主节点先在数据卷里保存迁移前快照。
3. 检查 `/health`，再恢复调度。回滚时把版本改回旧值，并用旧版本镜像的 `admin.js restore` 恢复迁移前快照。

## 安全设置

compose 中主节点以非 root 用户运行，根文件系统只读（`/tmp` 为 tmpfs），去掉全部 capability 并设置 `no-new-privileges`；容器 3000 端口只在 compose 内部网络开放，对外只有 Caddy 的 HTTPS 端口。模型 key 只在 `main.env` 里，不进入镜像。

## 验收

`deploy/docker/smoke.sh` 在本机构建两个镜像，用 compose 启动并检查：经 Caddy 内部 CA 的 HTTPS 就绪、在线备份校验、`docker stop` 退出码 0 且释放锁、再次启动就绪。CI 在 GitHub 托管的 amd64（`ubuntu-24.04`）和 arm64（`ubuntu-24.04-arm`）runner 上各自原生构建并运行它，通过后才推送镜像。
