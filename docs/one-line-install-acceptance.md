# 一行安装验收记录

日期：2026-10-10。覆盖安装器、CA 复用、控制台生成命令和 Docker 初始化。安装不等于实际模型的业务验收；首次正式 Release 前，下载环节使用本地构建产物的校验夹具。

## 已验证

- Bash 3.2 语法兼容；离线安装器测试 6 个测试组覆盖四平台映射、最新/固定版本、无 Release、校验错误、下载错误、不合法账户、带空格/单引号路径、临时目录清理、重装保留数据、隐藏输入、已有文件保护和主节点启动失败保留配置。
- Node 24.19.0：`pnpm check`、`pnpm build`、`pnpm test` 通过。协议 3 项、Web 9 项、服务端 109 项；协议生成无差异。
- Rust：正常与 fault-injection 测试各 31 项通过；rustfmt、debug 和 macOS arm64 Release 构建通过。新增测试验证 legacy service-ca 迁移、移除原 CA 后复用副本、权限和 shell 引号。
- 真实 HTTPS/WSS 测试：CLI 不设置 SSL_CERT_FILE 时使用已保存 CA；显式 SSL_CERT_FILE 覆盖保存副本；join 指纹与主节点公钥摘要一致；授权、任务、取消、超时、重启、撤销及重新批准均通过。
- macOS arm64 实机用户级 LaunchAgent：安装器下载校验夹具产物并真实安装服务、申请、批准、对账、执行任务、再次安装；online=1、reconciled=1、blocked=0，任务 succeeded，ledger_id 保持不变。结束时卸载服务并删除隔离目录。
- 经用户授权的 Linux x86_64 实机：使用已有普通账户及独立临时安装根目录，安装真实 systemd 系统级服务；经 loopback SSH 反向隧道连接隔离主节点，完成申请、批准、对账、真实任务和重装。online=1、reconciled=1、blocked=0，任务 succeeded，账本身份保持。结束时卸载服务、清理目录并关闭隧道。
- Compose 密钥往返：真实容器验证 10 个组合，包含单引号、反斜杠紧邻引号、末尾反斜杠、双引号、美元符号、Unicode 与 Tab；已纳入两架构 Docker CI。
- Docker 初始化：在 Linux 容器中运行真实交互向导，使用本地构建的 main/Caddy 镜像；生成独立 Compose 项目、环境文件 0600；HTTPS 就绪、管理员登录成功，首次密码从文件移除后重新启动仍就绪。容器实际 API key 保留 `$`/`#`，管理员密码保留单引号及 `$`/`#`。Release 元数据与模板下载为本地校验夹具。
- Chrome：真实 HTTPS 测试页面登录，打开“机器授权 → 添加机器”，验证用户/系统级切换、拒绝 root、带空格及单引号 CA 路径、生成命令、剪贴板内容一致。390px 手机宽度下无横向溢出；桌面与手机截图已视觉检查。测试浏览器只对生成的隔离 HTTPS 夹具忽略证书错误；worker 和安装器使用真实 CA 校验。

## 发布验证边界

上述服务和任务验证使用真实二进制、服务管理器、HTTPS/WSS 和脚本模型；正式 GitHub Release 下载未由本地夹具替代证明。公开交付需要合入后的 Pages 发布、四平台 Release 产物和两架构 GHCR 镜像成功，并核对匿名下载与页面展示命令。

原始浏览器截图保存于本地临时验收目录，不包含在 Git 提交中。可复用实机验收入口为 `apps/server/test/support/install-worker-acceptance.ts`：默认 macOS，Linux 使用 `WORKER_PLANE_ACCEPTANCE_MODE=linux WORKER_PLANE_TEST_SSH_TARGET=colo`，仅用于明确授权的隔离验收。
