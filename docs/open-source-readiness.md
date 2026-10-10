# 开源准备记录

日期：2026-10-10。当前工作树基于 main `cc7e36e`。此记录不代表远端已合入或仓库已公开。

## 已处理

- 用户选择 Apache-2.0；官方许可证全文保存为根目录 `LICENSE`。README 加入许可证及品牌使用说明。
- `SECURITY.md` 和 README 明确单管理员、实际账号权限、工作目录不是 shell 沙箱、模型数据外发和不承诺任意命令 exactly-once 的边界。
- PR、Pi spike 和 Release 工作流改为 GitHub-hosted runners，移除自托管 runner；没有更改组织 runner 配置。
- macOS 验证和 arm64 发布使用 macos-15；官方 macos-14 runner 在 2026-11-02 停用，避免新工作流很快过期。
- macOS P1 工作流先安装 GNU Bash，再设置 Node 24，防止 PATH 中的 Homebrew Node 22 覆盖项目要求。
- 远端 runner 策略已核验：该仓库当前无自托管 runner，组织 Default runner group 的 `allows_public_repositories=false`；未扩大其访问范围。
- 新增 Secret scan 工作流，使用固定版本 Gitleaks 扫描可见历史，日志脱敏。
- 当前文档的真实机器别名与内网地址已替换；3 份状态 JSON 隐去设备身份、服务名、路径和任务标识，保留验收结论并标明脱敏。
- 14 张含环境信息或执行详情的截图移动到本地忽略目录 `.private-evidence/output/`，原始证据未销毁。公开文档的截图引用已注明只在本地保留。保留 4 张 P1 隔离登录与连接状态截图；本轮新生成的品牌与网站 PNG 预览仅本机保留。
- 用户明确接受历史中的旧环境标识公开，选择保留历史；未重写任何 Git 历史。
- 已同步 main 的系统级服务安装能力，修正静态页的旧用户级服务描述。
- 第三方声明涵盖 258 个 JavaScript 包（含 Pi spike）和 225 个 Rust crate；声明许可证均非空。见 `THIRD_PARTY_NOTICES.md` 和 `dependency-licenses.json`。这不是逐文件版权审计；二进制分发仍须保留实际依赖的许可及版权文本。

## 凭据与附件检查

Gitleaks 8.30.1 扫描本地全部引用，并获取 origin 全部分支后再次扫描：136 个提交，约 3.69 MB，未发现凭据。对拟公开当前工作树快照（包括未提交文档和静态页）另行扫描：约 1.62 MB，未发现凭据。未添加忽略规则来压制扫描发现。

18 张原有截图已在本轮做视觉概览检查；设备授权截图中的指纹与路径促使其转为本地保留。该检查不能保证图片中没有任何低可见度敏感信息，历史保留决定仍适用。

GitHub 查询时没有 Actions artifacts 或 Releases。PR／issue 讨论、所有历史 Actions 日志和组织级其他资产没有逐条内容审计，不声称它们已全部脱敏。

## 本地验证

- `pnpm check`：通过。
- `pnpm --filter @worker-plane/web build`：通过，Vite 资源转换约 2 分半；没有修改 tree-shaking 或锁文件。
- `pnpm --filter @worker-plane/web test`：7 项通过。
- 按 CI 前置步骤构建普通 worker 和 fault-injection worker 后，`pnpm test` 全部通过：服务端 108 项、协议 3 项、前端 7 项。首次运行因缺少这两个二进制失败，补齐后未修改测试或运行逻辑。
- `cargo test --locked --manifest-path worker/Cargo.toml`：30 项通过。
- 5 个 Actions YAML 通过解析，`git diff --check` 通过。
- 静态介绍页先前已检查桌面及 390px 布局；没有横向溢出。本轮只修正系统级安装说明。

GitHub-hosted runner 的完整 CI 尚未实际运行，不能把本地检查当作两平台 CI 通过。

## 发布操作

1. 将任务改动提交、评审并合入，等待 GitHub-hosted CI。
2. 由仓库所有者将仓库设为 public；本轮未修改可见性。
3. 在 GitHub Settings → Security 中启用 private vulnerability reporting，并确认安全报告入口可用。
4. 按 `site/README.md` 启用 Pages 并手动发布，核验实际 URL。
5. 发布二进制前补齐分发包的第三方许可／版权文件，并完成平台及真实环境验收。

公开 Git 历史是持久披露；把仓库重新设为私有不能回收他人已经获取的副本。此处记录用户已选定保留历史的范围，不据此自动发布。
