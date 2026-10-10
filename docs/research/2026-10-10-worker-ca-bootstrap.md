# Worker CA 初始化：免人工复制证书

调研日期：2026-10-10。仅调研与建议，没有修改运行时代码、部署或提交。

## 结论

Worker 不必由用户提前下载 CA 文件；它必须有可信的服务器身份验证起点。对目前默认的 Caddy 内部 CA，最小改动是控制台生成包含 **CA 证书 SHA-256 指纹** 的安装命令，安装器自动获取根证书、核对指纹、保存到现有安装目录，再正常验证 HTTPS/WSS。用户只复制一条命令，仍在控制台批准设备。

这是工程建议，尚未实现。不要将“自动下载”做成无限制跳过证书验证，也不要从同一条未经验证的连接同时获取证书与其预期指纹。

## 当前代码约束

- `deploy/install.sh` 的 `worker_install` 强制要求 `--ca` 可读绝对路径；先用 `curl --cacert` 验证 `/health`，再安装。`main_install` 从 Caddy 导出 `/data/caddy/pki/authorities/local/root.crt`。
- `deploy/docker/Caddyfile` 强制 `tls internal`，已有持久化 Caddy 数据卷，未公开根证书下载端点。
- `worker/src/cli.rs` 的用户级安装已经将证书复制为安装目录 `ca.pem`；客户端优先使用显式 `SSL_CERT_FILE`，随后读取保存的 CA，禁止重定向并要求 HTTPS。自动下载后可复用该流程。
- `apps/web/src/enrollment.tsx` 当前要求用户填写 CA 文件路径。应改成展示服务器返回的真实 CA 指纹，默认直接生成命令，保留手动 CA 路径作为高级方式。

以上由本次直接阅读工作区确认。这里的 CA 指纹与批准 worker 时显示的设备公钥指纹是两种身份，界面必须分别命名。

## 官方模式：Smallstep 的指纹 bootstrap

[官方 bootstrap 文档](https://smallstep.com/docs/step-cli/reference/ca/bootstrap/)提供 `step ca bootstrap --ca-url ... --fingerprint ...`，下载根证书并保存默认 CA 配置；`--install` 才额外写入系统信任库。Willcord 可以借鉴机制，不必引入完整 step-ca 服务或要求用户安装 step。

[CLI 入口源码](https://github.com/smallstep/cli/blob/master/command/ca/bootstrap.go)要求 CA URL 和指纹；[CA client 源码](https://github.com/smallstep/certificates/blob/master/ca/client.go)说明真实过程：仅 root 请求使用未验证 TLS 的客户端，从 `/root/<fingerprint>` 读取证书，比较证书原始 DER 的 SHA-256；匹配后建立新的、使用该根证书验证 TLS 的客户端。PEM 文件字节哈希与证书 DER 指纹不是同一种计算，不能混用。

安全推断：可信指纹相当于预先知道“应取得哪张根证书”。攻击者即使替换下载内容也无法通过指纹检查；下载成功后仍须用该根证书验证服务器的签名链、有效期和主机名。若复制命令的控制台已被中间人替换，攻击者也能替换命令里的指纹，这个机制就失去独立信任起点。控制台须事先通过已信任证书、已核对 CA，或管理员可信渠道访问；仅点击浏览器证书警告继续并不能证明真实身份。

## 选项比较

| 方案 | Worker 操作 | 信任起点与代价 | 对现状适用性 |
| --- | --- | --- | --- |
| 内部 CA + 命令携带指纹 | 复制命令；自动取证书 | 可信控制台/管理员传递指纹；保持内部 CA | 推荐 V1，改动最小 |
| 内部 CA + 命令内嵌 PEM/base64 | 复制较长命令 | 同样依赖可信命令；无额外下载端点 | 可行备选，但命令长且错误提示不直观 |
| 公有域名 + DNS-01 公共证书 | 复制不带 CA 的命令 | 系统公共根信任；需要域名、DNS API 和自动续期 | 已有域名的部署最省终端操作 |
| Tailscale HTTPS | 访问主节点 `.ts.net` 地址 | Tailscale 身份/网络及公共 CA；需加入 tailnet | 已在使用 Tailscale 时很合适 |
| 首次盲信 TOFU | 首次接受并保存证书 | 首次连接可能遭中间人；后续固定身份 | 不作为默认安装方式 |

[Caddy 官方 HTTPS 文档](https://caddyserver.com/docs/automatic-https)指出容器内自动安装根证书不保证宿主或其他客户端信任；内部 PKI 的信任分发仍属管理员责任。因此仅改 Docker 网络/卷挂载不能让另一台 Worker 自动信任证书。Caddy DNS challenge 需要 DNS provider 凭据及相应支持。

[Let's Encrypt DNS-01 文档](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)支持通过公开 DNS TXT 证明域名控制；可给不对公网开放的服务签发证书，并建议使用范围受限凭据或单独的验证主机。工程推断：内部 DNS 可将自有域名解析到内网 IP，Worker 使用该域名连接并正常验证公共证书；不能继续以不匹配的私有 IP 地址连接。

[Tailscale HTTPS 文档](https://tailscale.com/docs/how-to/set-up-https-certificates)要求启用 MagicDNS 和 HTTPS，再使用 `tailscale cert` 获取证书；设备的完整域名会进入公开 CT 日志，但设备网络访问仍受 Tailscale 限制。工程推断：可以替换当前 TLS 入口为使用该证书的反向代理，避免每个 Worker 携带内部 CA；当前 `tls internal` 配置需要适配，单纯安装 Tailscale 不改变应用证书信任。

## 推荐 V1 的实现边界

示意接口（目前不可执行）：

```sh
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- worker \
  --server 'https://plane.internal:8443' --ca-fingerprint '<64位DER-SHA256>'
```

1. 主节点/Caddy 公开只包含根证书的固定端点，禁止暴露私钥或 Caddy 管理 API；后端只读挂载/读取真实根证书单文件或专用公开证书卷，不把含 CA 私钥的整个 Caddy 数据卷挂给 Node，向已登录控制台提供同一证书的指纹，不能让前端用占位值。
2. 安装器只允许在提供合法指纹时，对该 server origin 的固定根证书端点使用单次未验证 TLS GET；无凭据、无注册请求、无跨 origin 重定向，设置超时和大小上限。脚本、Release 资产下载仍保持正常公共 TLS 验证。
3. 解析单张根证书并核对 DER SHA-256；不匹配或格式错误立即退出，不能改成提示继续。匹配后再使用 `--cacert` 完整验证 `/health`，之后才安装和申请加入。
4. 证书保存到已有应用私有目录，沿用用户级/系统级复制逻辑；不默认污染全系统信任。现有 `--ca` 保留；提供 `--ca` 与 `--ca-fingerprint` 时拒绝歧义组合。
5. 公共 CA 部署允许不带两项参数，先严格验证系统信任；失败则提示需要内部 CA 指纹，不自动盲信或降级。

这些是建议的产品约束，Smallstep 源码并不自动提供 Willcord 的端点限制、下载上限或 Shell 实现。

Worker 自动初始化不替浏览器导入内部根证书；管理员首次打开内部 CA 控制台时仍需可信地确认/导入证书。若目标连浏览器这一步也省掉，公共域名 DNS-01 或 Tailscale 公共证书更完整。公开证书不意味着必须向公网开放应用 API；DNS-01 部署可继续限制网络访问。Caddy 的 DNS provider 往往需额外模块，不能假设现有镜像已包含所有 provider。

Caddy 的信任池配置不是证书分发端点；[管理 API 的 PKI 接口](https://caddyserver.com/docs/api#pki)即使可以读取 CA，也应留在内部，不能为了 bootstrap 把管理端口公开。CA pin 也不是 TLS 公钥 SPKI pin，两者参数和计算规则需明确区分。

## 证书轮换与验证

叶证书/中间证书由同一已信任根签发时无需重新初始化 Worker；根证书变化则必须可信地重新分发指纹/信任，不能遇到 TLS 错误就覆盖 CA。V1 保持现有 Caddy 数据卷，明确禁止无意删卷造成根变更。后续可设计通过旧信任连接提前分发新根的迁移，但旧根已泄漏时不能将这种迁移视为安全恢复。

验证需覆盖：正确/错误指纹、伪造下载内容、未信任页面提供指纹的风险说明、主机名不匹配、过期证书、跨站重定向、大响应、公共 CA 无参数、macOS 空格路径、系统服务 CA 权限、旧 CA 升级不覆盖、轮换叶证书持续可用及根变更失败明确提示。

## 来源可信度与建议动作

外部结论仅来自官方文档及官方源码，访问日期均为 2026-10-10。Smallstep 源码链接为可变分支，说明已核对的当前实现，不代表 Willcord 已验证交付；未发现文档与源码在指纹 bootstrap 上冲突。

值得学习：独立可信指纹 + 自动根获取 + 后续正常 TLS。值得避免：全局 `curl -k`、首次获取证书及指纹都来自同一未认证响应、误把设备指纹当 CA 指纹、无提示替换已保存根。

建议先落地指纹 bootstrap 作为默认内部 CA 路径；公共域名/DNS-01 和 Tailscale 作为可选部署方式另行规划。调研后的实现采用 Caddy 固定公开证书端点，控制台直接通过已信任的 HTTPS 读取证书并计算指纹，不增加 Node 的 CA 文件挂载。试用方法见 [安装指南](../installation.md#ca-指纹自动接入开发中尚未发布)。

本地验收：安装器负向测试覆盖错误指纹、过大响应及后续 TLS 失败；macOS 用户级服务使用公开 v0.2.0 二进制完成申请、批准、上线、对账和只读任务，重复安装保留账本。GitHub API 限流时使用固定的 Release 元数据夹具，二进制下载及主节点 TLS/WSS 均为真实请求。隔离 Caddy 测试验证公开根证书可下载并用于严格 TLS，私钥及相邻路径不返回私钥。Linux 系统级新流程及浏览器视觉验收尚未完成；这些结果不表示公开安装入口已经发布。
