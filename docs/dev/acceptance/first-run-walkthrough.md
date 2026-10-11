# 新用户走查流程（发版后验收）

> **开发内部文档**：每次发版后，用公开的一行安装命令从零走一遍新用户路径，记录摩擦点。它补充 [一行安装验收](one-line-install.md)（实机与夹具验证）和 [安装与首次使用](../../installation.md)（面向用户的步骤）。命令名以改名后的 `willcord` 为准；v0.4.2 及更早版本使用 `worker-plane` / `WorkerPlane`。

目标不是证明功能正确（自动化测试已做），而是以第一次使用的人的视角，发现文案、顺序、空状态和报错上的摩擦，并确认“填入真实 key → 任务成功”这条主路径。

## 何时做

- 每次正式 Release 发布且 Pages 部署完成之后（发版流程见 `deploy-checklist`；Pages 由 `pages-after-release.yml` 自动触发）。
- 安装器、向导、worker 命令行或控制台首屏有改动的 PR 合并之后，可对 `main` 先做一次。

## 准备

- **公开安装脚本已更新**：`curl -fsSL https://1bossx.github.io/Willcord/install.sh | cmp - deploy/install.sh` 应无差异；`gh release view <tag>` 显示非草稿、附件 16 个。
- **临时凭据**：管理员密码自己生成，仅用于这次部署，不写入仓库。模型 key 需要一个**临时、可作废**的 key；没有真实 key 时，只能验证到“任务因 key 无效而失败”并检查失败提示，不能证明主路径。走查结束后让持有人在 provider 作废该 key。
- **本机环境**：Docker Desktop（macOS）或 Docker + Compose v2（Linux）；端口 8443 空闲（先清理上一次走查的部署）。
- **隔离目录**：部署目录放在会话临时目录，不放进工作区，以免把含密钥的 `main.env` 带进提交。

## 流程

按新用户会走的顺序，每一步记录“看到了什么、卡在哪、文案是否看得懂”。

### 1. 部署主节点

```bash
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- main --server https://localhost:8443 --dir <临时目录>
```

向导读 `/dev/tty`，自动化时需要伪终端（见“辅助工具”）。检查点：

- 向导只问两项：服务地址和管理员密码，**不再问模型**。查看 `main.env`：只有 `PUBLIC_BASE_URL`，不含 `MODEL_*`，成功后也不再有 `INITIAL_ADMIN_PASSWORD`。
- 服务地址提示先列出本机探测到的地址（私有网段在前，没有 `127.0.0.1`、Docker 网卡），回车取第 1 项，输入序号选择，输入完整 `https://` 地址按原样使用；序号越界时报错且不写任何文件。
- 登录后控制台顶部应出现“尚未绑定模型”提示；在“模型连接”保存 key 后提示消失（见第 5 步）。
- 结尾打印信任根证书的命令（macOS / Debian-Ubuntu），并指向“机器授权 → 添加机器”。
- `https://localhost:8443/health` 用 `--cacert <目录>/ca.pem` 访问，返回 `scheduling_ready: true`。

### 2. 打开控制台

浏览器信任自签 CA 前会报证书错误，这本身是需要记录的体验点。应用内浏览器不能信任它，用“辅助工具”里的 HTTP→HTTPS 代理访问。

- 用步骤 1 的管理员密码登录。
- 首页只应有**一个**空状态；侧栏“机器授权”“模型连接”与其他导航项风格一致。
- 尚无机器时提示怎么添加；有待批准机器时，侧栏徽标和首页都提示数量并给出“去批准”。

### 3. 安装 worker

在“机器授权 → 添加机器”复制命令；只有 https 来源才能生成。代理访问时无法使用该弹窗，改为手工拼命令：

```bash
fp=$(openssl x509 -in <目录>/ca.pem -outform DER | shasum -a 256 | cut -d' ' -f1)
curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- worker --server https://localhost:8443 --ca-fingerprint "$fp"
```

检查点：输出里“申请已提交”与终端指纹；设备名是本机主机名而不是 `worker`；没有残留的占位地址（如 `https://your-server`）。

### 4. 批准

控制台“机器授权”核对节点指纹与终端一致，点“核对指纹后批准”。几秒后状态应变为“可执行”。

- **重装已批准机器**：再运行一次步骤 3 的命令，应提示“无需再次批准”，不再要求批准。
- **命令行**：`willcord --help` 打印用法；打错子命令得到“unknown command”和用法，退出码 2。

### 5. 模型连接

刚装好、还没绑定时，控制台顶部有“尚未绑定模型”提示；点“绑定模型”（或侧栏“模型连接”）：

- 用真实 key“测试连接”：显示“连接正常”；保存后顶部提示消失。
- 失败时（可用错误 key 再试一次）：显示一句人话，原始返回收在“查看 provider 原始返回”里；弹窗里的表单与上方文字对齐。

### 6. 第一个任务

点机器卡片 → 新建独立会话 → 选默认工作目录 → 点第一条建议（文档里的只读任务“列出当前工作目录的文件，并报告工作目录路径”）→ 发送。

- 任务应变为“已完成”，回复里报告了工作目录路径与（空）文件列表。
- 失败路径（可选）：把 key 改错再发一次，对话里应出现失败原因和“打开模型连接”按钮。

### 7. 多宽度检查

依次看 1280、768、375 px（应用内浏览器的 `resize_window`）：无横向溢出，头部状态不被挤出。结束后恢复桌面尺寸。

### 8. 清理

```bash
willcord worker uninstall --delete-data     # 卸载 worker 服务并删除数据
docker compose down -v                      # 在部署目录执行：删除主节点容器与数据卷
rm -rf <部署目录>                            # 含写有临时 key 的 main.env
```

确认 `docker ps` 没有残留的 `willcord-*` 容器，LaunchAgent / systemd 里没有残留服务。关掉代理进程。

## 记录什么

每次走查留下一份简短记录（版本、平台、日期；通过项；摩擦点按严重程度排序，附复现步骤；未能验证的项和原因）。摩擦点分两类：

- **直接修**：错别字、残留占位符、重复提示、样式不一致、报错不可读。
- **需决策**：流程改动、新增引导、跨组件改动。列出来，由负责人选。

## 已知局限

- 没有 `sudo` 密码时无法执行信任证书命令，也就验证不了它在目标系统上真的生效。
- 代理是 HTTP，“添加机器”弹窗无法在其中验证；该命令的来源是 `apps/web/src/install-command.ts`。
- 不覆盖 Linux 系统级服务和多机器场景；那些由 [一行安装验收](one-line-install.md) 的实机步骤负责。
- 真实 key 的主路径只在有临时 key 时才能证明。

## 辅助工具

脚本很短，用时现写，放在会话临时目录，不入库。

**伪终端驱动向导**（密钥从环境变量读取，不回显、不写文件）：

```python
import os, pty, select, sys, time
answers = [("管理员密码".encode(), os.environ["WP_ADMIN"].encode() + b"\n")]   # 带 --server 时不会问地址
cmd = f"curl -fsSL https://1bossx.github.io/Willcord/install.sh | bash -s -- main --server '{sys.argv[2]}' --dir '{sys.argv[1]}'"
pid, fd = pty.fork()
if pid == 0: os.execvp("bash", ["bash", "-c", cmd])
out = b""; sent = cur = 0; end = time.monotonic() + 420
while time.monotonic() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r: continue
    try: data = os.read(fd, 65536)
    except OSError: break
    if not data: break
    out += data; sys.stdout.write(data.decode(errors="replace"))
    if sent < len(answers):                      # 每个标记从上一个匹配之后开始找
        marker, reply = answers[sent]; i = out.find(marker, cur)
        if i >= 0: os.write(fd, reply); sent += 1; cur = i + len(marker)
print("EXIT", os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
```

**HTTP→HTTPS 代理**（仅用于应用内浏览器访问自签证书的本机主节点）：

```js
import http from "node:http"; import https from "node:https";
http.createServer((req, res) => {
  const up = https.request({ host: "127.0.0.1", port: 8443, servername: "localhost", method: req.method, path: req.url,
    headers: { ...req.headers, host: "localhost:8443", origin: "https://localhost:8443" }, rejectUnauthorized: false }, (r) => {
    const h = { ...r.headers };
    if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].map((c) => c.replace(/;\s*Secure/i, ""));
    delete h["strict-transport-security"];
    res.writeHead(r.statusCode, h); r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(5199, "127.0.0.1");
```

浏览器访问 `http://localhost:5199`。

**不用 Docker 看 UI 改动**：在 `apps/web` 用 `npx vite --config <临时配置>` 起开发服务（本机 `vite build` 会卡住，开发服务不受影响），`server.proxy` 指向本地用 `tsx src/main.ts` 起的主节点（`PORT=3100`，临时管理员密码，占位模型 key）。这只验证工作区代码，不替代对已发布产物的走查。
