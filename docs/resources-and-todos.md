# 资源与开工待办

状态：准备中  
最后更新：2026-10-06

本文记录开始实施和进入联调/发布阶段所需的外部资源。凭据不得提交到此文件、仓库或聊天中；使用主机环境变量或部署密钥管理。

## 用户需提供或决定

| 项目 | 需要时间 | 要求 | 状态 |
|---|---|---|---|
| 远端 Git 仓库 | 推送代码前 | GitHub/GitLab 等仓库地址、可推送权限；提供组织/命名约定及公开/私有选择 | 待提供 |
| 模型供应商和模型名 | P0 实际模型验证前 | 指定兼容 provider/model；密钥通过安全环境变量注入 | 待决定 |
| 第一台 worker | P2 联调前 | 可安装 Rust worker 的 Linux 或 macOS 机器；有管理员权限安装/启动服务 | 待准备 |
| 主节点可访问地址 | P2 worker 联调前 | worker 能出站访问的 HTTPS/WSS 地址；开发阶段可用临时隧道或测试网络 | 待准备 |
| 第二台 worker | P5 双机委派联调前 | 第二台 Linux/macOS 机器及唯一 worker 身份/token | 待准备 |
| Workspace 映射 | P2 联调前 | 每台机器的 workspace_id、cwd、repo_id、remote、默认 workspace | 待提供 |
| 域名与证书 | P7 上线前 | 若使用自有域名，提供 DNS 控制权；否则选择其他 TLS 终结方式 | 待决定 |
| 主机与持久存储 | P7 上线前 | 单台常驻 Linux 主机；SQLite、账本、日志和备份有持久磁盘与空间预算 | 待准备 |
| 管理员凭据配置方式 | P1 部署联调前 | 选择初始密码注入或首次启动设置流程；密码本身不发到聊天 | 待决定 |

## 可立即开始的工作

- [x] 创建本地仓库 `/workspace/worker-plane` 并初始化 `main` 分支。
- [x] 纳入最终架构和开发阶段验收文档。
- [x] P0 Pi SDK spike：固定 Pi SDK 1.0.4；faux-provider 验证工具隔离、执行前完整调用 checkpoint seam、串行调用、transcript 恢复、取消信号、预算 gate 和委派等待 seam。
- [x] P0 SQLite checkpoint adapter：整轮/工具意图事务提交、幂等重试、调用序号、派发/结果状态约束；已从真实 Pi hook 集成测试，SQLite 重开后保留待对账调用。
- [ ] P0 剩余验收：选择 provider/model 并安全配置密钥，验证真实 provider 的取消与 usage；覆盖 Pi transcript 和 SQLite 双存储崩溃对账、未决 RPC/worker 账本恢复、job/root 累计预算及持久父子等待。
- [ ] 初始化 TypeScript/Rust workspace、CI 与协议 Schema。
- [ ] 写入数据库初始 migration 与部署模板。

P0 不需要真实 worker、域名或线上主机。已完成的 faux-provider spike 证明 Pi SDK seam 与应用侧编排可行，但没有外部模型请求。真实 provider 取消与 usage 尚需用户选定 provider/model，并在环境中安全配置密钥；mock 结果不能替代这一验收。

## 远端仓库待办

- [ ] 决定仓库托管平台、组织/用户、仓库名和可见性。
- [ ] 创建远端仓库并配置当前执行环境可用的推送身份。
- [ ] 添加 `origin` 并在用户授权范围内推送初始提交。

本地仓库和文档已创建；远端尚未创建或连接。

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
