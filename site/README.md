# Willcord

Willcord 的静态产品介绍页，使用已选定的 B「错位牵引」品牌图形。

## 发布

GitHub Pages 通过主仓库的 `.github/workflows/pages.yml` 发布，从最新正式 Release 下载并校验 `install.sh`，放入 `site/` 后上传该目录，无 Node.js 构建依赖。入口为 `index.html`，样式和图形均为本地相对路径。站点不含 API、登录、分析脚本或产品运行数据。

仓库仍私有时，发布 job 自动跳过。仓库开源后：

1. 将此工作流及 `site/` 合入 `main`。
2. 在仓库 Settings → Pages → Build and deployment 中，将 Source 设为 **GitHub Actions**。
3. 在 Actions 中手动运行 **Publish Willcord site**。单独改变仓库可见性不会触发此工作流。
4. 确认工作流成功后，打开 deployment 返回的 `page_url`，检查页面及 Logo 实际可访问。

按当前仓库名，发布地址为 https://1bossx.github.io/Willcord/ （已发布）；改仓库名后以工作流返回的地址为准。

后续 `main` 上的 `site/**` 或发布工作流变更，以及每次发布正式 Release，都会自动触发更新，不需要 Node.js 或 Vite。

此目录承载公开介绍页。产品仍在开发与受控验收阶段，此页包含安装与首次任务概览，完整操作步骤链接至主仓库 README、Docker 部署指南、worker 安装授权和运维手册。不需要另建 `willcord-site` 仓库。

站点上的一行安装器取自最新正式 Release，而不是 `main` 上的 `deploy/install.sh`，因此与它下载的二进制和镜像始终同版本；`main` 上改了安装器，要等下一次正式发布才会上线。由 GitHub Actions 的默认 token 发布 Release 不会触发此工作流，此时需手动运行一次。安装器依赖正式 Release 和对应镜像；站点发布成功不等于下载版本已经可用。
