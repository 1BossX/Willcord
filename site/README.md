# Willcord 产品介绍页

Willcord 的静态介绍页，使用 B「错位牵引」品牌图形。纯 HTML 和 CSS，无 Node.js 构建，不含 API、登录、分析脚本或运行数据。入口为 `index.html`，样式和图形均为本地相对路径。

## 发布

通过 `.github/workflows/pages.yml` 发布到 GitHub Pages，地址 https://1bossx.github.io/Willcord/ 。仓库改名后以工作流返回的 `page_url` 为准。

以下情况会自动重新发布：

- `main` 上的 `site/**` 或工作流文件有变更
- 发布新的正式 Release

也可以在 Actions 中手动运行 **Publish Willcord site**。由 GitHub Actions 默认 token 发布的 Release 不会触发该工作流，此时需要手动运行一次。

## 一行安装器

站点提供的 `install.sh` 取自最新正式 Release（校验 `.sha256` 后复制进 `site/`），而不是 `main` 上的 `deploy/install.sh`，所以它与自己下载的二进制和镜像始终同版本。`main` 上修改安装器后，要等下一次正式发布才会上线。

站点发布成功不代表下载版本可用；安装器还依赖对应 Release 的产物和镜像。

## 维护

页面只放产品介绍与安装概览：先 `install.sh`（只安装命令），再 `willcord main init` / `willcord worker join`。完整步骤链接到主仓库的 README、安装指南、Docker 部署指南、worker 安装文档和运维手册，不在此处重复。修改命令或参数时，对照 `deploy/install.sh` 和 `worker/src/cli.rs`。不需要另建 `willcord-site` 仓库。
