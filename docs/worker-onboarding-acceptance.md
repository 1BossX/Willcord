# 简化安装注册验收记录

日期：2026-10-10。此记录仅覆盖本次安装注册增强，不能代替 P7 全量发布验收。

## 已验证

- Node 24.12.0：`pnpm check` 通过，`pnpm test` 全量通过（服务端 108 项）；新增 signed enrollment 与 managed worker HTTPS/WSS 端到端测试通过。
- Rust：`cargo test --locked --manifest-path worker/Cargo.toml` 28 项通过；正常构建及 rustfmt 检查通过。发布默认不启用 fault-injection。
- Vite 生产构建通过。当前 Rollup 4.64.1 对 React DOM 的分析耗时约 2 分半；未为了缩短构建改变 tree-shaking 或依赖版本。
- 注册安全：公钥规范编码与旧节点 ID 防接管、签名伪造/元数据篡改、挑战单次消费与过期、重复加入、未批准禁止领取凭据、凭据响应丢失后重领作废旧 token、已确认凭据禁止重复领取、撤销全部凭据、禁止申请绕过撤销、重新批准恢复。
- 真实 Rust managed worker：自动默认目录执行；忙时添加目录失败且配置不变；空闲添加后重新注册；取消、超时、断线恢复；重启保留 ledger_id；撤销后离线及重新批准后恢复。副作用 marker 没有重复或执行到被取消/超时命令的尾部。
- macOS arm64 Release 二进制（默认无 fault-injection）构建成功，安装副本 SHA-256 与产物一致；升级后浏览器任务 `30e12903-1cd1-44b0-a199-457cb4119ca2` succeeded，marker 仍仅一行。
- macOS arm64：隔离服务配置/应用数据目录中实际安装 LaunchAgent，私有 CA 经服务环境生效；批准后 online=1、reconciled=1、blocked=0；原地 install 升级成功，机器身份保持稳定且对账不阻塞。
- 远端 Linux x86_64：通过 loopback SSH 反向隧道连入隔离测试主节点，完成 Release 安装、签名申请、管理员批准、账本对账及默认 workspace 任务。worker `online=1, reconciled=1, blocked=0`；任务 `cf8633b0-f1f5-4f9a-bb21-734aabdc3024` succeeded，marker 已确认；升级后 ledger_id 保持不变。隐藏凭据的逐项证据见 `output/playwright/worker-enrollment/colo-linux.json`（公开版隐藏环境标识）。
- 远端 Linux 验收结束后，systemd user service、worker 数据、暂存文件和 SSH 隧道均已清理。构建容器与镜像也已从本机移除；只保留 Linux Release 文件于 `worker/target/x86_64-unknown-linux-gnu/release/worker-plane-worker`，其 SHA-256 与远端运行的文件一致。
- 浏览器：登录、待授权、拒绝、重新批准、默认 workspace 会话创建、真实任务成功、机器名称修改、撤销后离线/不可执行。任务 `5c4535c3-0167-4339-b92d-939add7af9cd` succeeded，默认目录 `acceptance.txt` 仅一行 `enrollment-ok`。
- 卸载会等待服务退出和数据目录解锁（最多 60 秒），超时保留数据；实际 LaunchAgent 卸载已验证。
- 发布 YAML 已解析验证，配置 Linux x86_64/arm64、macOS x86_64/arm64 四个原生构建目标，并检查实际架构及生成 SHA-256 文件。

浏览器使用本机 HTTP 走查入口；worker 的申请、凭据领取及执行连接使用真实证书校验的 HTTPS/WSS。未关闭 TLS 校验。测试服务结束后卸载，临时机器数据由走查环境清理。

## 本地证据

`output/playwright/worker-enrollment/` 保留公开版脱敏 JSON 与校验记录；待授权、已授权和任务等原始截图只在本地保存。公开记录包括 `status.json`、`release-status.json` 和安装副本校验文件（最终二进制见 `release-sha256-final.txt`）。截图已人工视觉检查。它们尚未上传为长期 CI 或 Release 附件。

## 尚未验收

- 四平台 GitHub Release workflow 尚未运行，MVP 二进制尚未发布；目前仅验证 Linux x86_64 与 macOS arm64。
- macOS Intel 和 Linux arm64 的 runner 构建、启动检查仍待 CI 执行。
- 此增强没有完成或重新证明 P7 的全部主节点部署、备份恢复、真实模型及双机发布验收。

可从仓库根目录运行 Linux 实机验收脚本：`cd apps/server && WORKER_PLANE_TEST_SSH_TARGET=<your-test-host> node --import tsx test/support/colo-worker-acceptance.ts`。该脚本把 worker 和默认 workspace 放在独立目录，通过绑定测试机器 loopback 的短时 SSH 反向隧道连接隔离测试主节点；结束时卸载服务、删除该目录并关闭隧道。
