# 外人从安装到第一次诊断（票 4 步骤记录）

> 开发内部文档：记录 O1-KR2 厚轨验收路径。面向用户的步骤见 [安装与首次使用](../../installation.md)。

## 前提

- Linux x86_64/arm64，已安装 **Docker Compose v2**（`docker compose version` 成功）。
- 自备临时管理员密码与模型 API key（验收后作废）。
- 公开安装命令解析到的版本与 GitHub Latest Release、README/SECURITY 中的当前版本一致（当前为 **v0.1.0-beta.4**；发版前不打新 tag 时，文档对齐已发布的 latest）。

## 步骤

| # | 动作 | 成功标志 |
|---|---|---|
| 1 | `curl -fsSL https://bossoptional.github.io/Willcord/install.sh \| bash` | `willcord` 在 `~/.local/bin`（或 `--system` 在 `/usr/local/bin`） |
| 2 | `willcord main init`（或 `install.sh main`） | 打印「主节点已就绪」、`ca.pem` 路径、`willcord trust-ca` 提示 |
| 3 | `willcord trust-ca 'https://…#sha256=…'`（或按登录页导入 CA） | 浏览器可安全打开控制台 |
| 4 | 登录控制台 | 进入工作台 |
| 5 | 侧栏「模型连接」保存 API key | 顶部「尚未绑定模型」消失 |
| 6 | 控制台「添加机器」→ 在执行机运行 `install.sh worker '…'` | 终端显示 pending 与节点指纹 |
| 7 | 控制台批准，等「可执行」 | 侧栏机器状态为可执行 |
| 8 | 首页「首次诊断」选场景（或批准后自动打开 Docker 场景） | 任务运行并完成，时间线有工具输出 |

## 四类卡住验收（各一句原因 + 下一步）

在刻意制造或模拟时，应看到下列文案（控制台或 CLI），且**不要求**用户去翻 `docker compose logs`：

1. **Docker**：`willcord main init` / `install.sh main` 在未安装或未就绪时退出，并说明安装 Compose v2、启动守护进程、检查账户权限；向导不安装 Docker。  
2. **CA**：未信任时登录失败，提示 `willcord trust-ca` 或登录页导入步骤。  
3. **worker**：已批准但离线时，工作台安装进度区说明检查服务、地址与网络。  
4. **模型 key**：顶部横幅与安装进度区引导打开「模型连接」。

## 依赖说明

- 诊断场景的**结构化结果**（结论 / 证据 / 建议下一步 UI）由票 2 交付；本路径在票 2 合入前通过任务 prompt 要求模型按该结构回复。  
- 诊断模式执行层限制（票 1）在另一分支；本路径不验收写拦截。

## 记录模板

每次走通后记录：版本 tag、平台、日期、是否自动进入首场景、摩擦点（附复现步骤）。
