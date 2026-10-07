# 资源与开工待办

状态：准备中  
最后更新：2026-10-07

本文记录开始实施和进入联调/发布阶段所需的外部资源。凭据不得提交到此文件、仓库或聊天中；使用主机环境变量或部署密钥管理。

## 用户需提供或决定

| 项目 | 需要时间 | 要求 | 状态 |
|---|---|---|---|
| 远端 Git 仓库 | 推送代码前 | 私有 GitHub 仓库 `1BossX/WorkerPlane`；当前 Git CLI 身份具备 `repo` 权限 | 已配置 |
| 模型供应商和模型名 | P0 实际模型验证前 | OpenRouter + `deepseek/deepseek-v4.1-flash`；`OPENROUTER_KEY` 已在本机 `~/.zshrc` 配置，运行时映射为 `OPENROUTER_API_KEY`，不写入仓库 | 已验证真实 usage 和 Pi 端到端取消；取消请求最终费用未知 |
| 第一台 worker | P2 联调前 | 可安装 Rust worker 的 Linux 或 macOS 机器；有管理员权限安装/启动服务 | 待准备 |
| 主节点可访问地址 | P2 worker 联调前 | worker 能出站访问的 HTTPS/WSS 地址；开发阶段可用临时隧道或测试网络 | 待准备 |
| 第二台 worker | P5 双机委派联调前 | 第二台 Linux/macOS 机器及唯一 worker 身份/token | 待准备 |
| Workspace 映射 | P2 联调前 | 每台机器的 workspace_id、cwd、repo_id、remote、默认 workspace | 待提供 |
| 域名与证书 | P7 上线前 | 若使用自有域名，提供 DNS 控制权；否则选择其他 TLS 终结方式 | 待决定 |
| 主机与持久存储 | P7 上线前 | 单台常驻 Linux 主机；SQLite、账本、日志和备份有持久磁盘与空间预算 | 待准备 |
| 管理员凭据配置方式 | P1 部署联调前 | 已实现 INITIAL_ADMIN_PASSWORD 首次启动环境注入；密码本身不发到聊天 | 已提供配置方式，部署联调待验证 |

## 可立即开始的工作

- [x] 创建本地仓库 `/workspace/worker-plane` 并初始化 `main` 分支。
- [x] 纳入最终架构和开发阶段验收文档。
- [x] P0 Pi SDK spike：固定 Pi SDK 1.0.4；faux-provider 验证工具隔离、执行前完整调用 checkpoint seam、串行调用、transcript 恢复、取消信号、预算 gate 和委派等待 seam。
- [x] P0 SQLite checkpoint adapter：整轮/工具意图事务提交、幂等重试、调用序号、派发/结果状态约束；已从真实 Pi hook 集成测试，SQLite 重开后保留待对账调用。
- [x] P0 八条验收：实际 Pi/SQLite 历史投影、账本对账、worker/Main Coordinator、预算、父子等待、取消历史重载和明确中断重试；见 spike 结果矩阵。受控本地传输验证不代表生产 WSS/Rust 已实现。
- [x] 初始化 TypeScript/Rust workspace、双平台 CI 与首版身份/连接协议 Schema；完整协议矩阵尚未验收。
- [x] 写入初始及升级 migration 与 Caddy 开发入口；发布服务模板留给 P7。

P0 不需要真实 worker、域名或线上主机。用户已选择 OpenRouter + `deepseek/deepseek-v4.1-flash`，并在 `~/.zshrc` 配置 `OPENROUTER_KEY`。普通沙盒网络无法解析外部 DNS；提升网络权限后 `registry.npmjs.org` 与 `openrouter.ai` 均可连接，锁定依赖安装成功。2026-10-07 已完成真实模型 usage、Pi AgentSession 到 OpenRouter 的取消验证，以及 SQLite job/root 预算与父子等待 adapter 的持久化验证；已接入 single-owner spike Coordinator 并完成 P0 八条受控验收；生产调度、协议与身份仍属 P1–P7。密钥不得写入仓库或聊天。

## 远端仓库状态

- [x] GitHub 私有仓库 `1BossX/WorkerPlane` 已存在。
- [x] 初始文档和 P0 spike 已提交到远端 `main`；最新提交见仓库历史。
- [x] 本地仓库配置 `origin`；Git CLI 已切换到可用的 `agentx1boss` 身份，供原生 `git push` 使用。

Git CLI 使用系统钥匙串中的 GitHub 凭据；不要将凭据写入仓库或聊天。

## 集成配置模板（不填入秘密值）

主节点运行时至少需要：

```text
DATABASE_PATH=
SESSION_SECRET=
INITIAL_ADMIN_PASSWORD=   # 仅首次设置流程需要，部署后移除
MODEL_PROVIDER=
MODEL_NAME=
MODEL_API_KEY=
PUBLIC_BASE_URL=
```

Worker 配置至少需要：

```text
WORKER_ID=
WORKER_TOKEN=
CONTROL_PLANE_WSS_URL=
WORKER_DATA_DIR=
WORKSPACES_FILE=
```

最终变量名称以实施中的配置 schema 为准。秘密应通过部署环境变量或密钥管理器注入；不需要把秘密内容分享给协作者。
