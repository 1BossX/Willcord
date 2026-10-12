/** One-line install blockers: reason + next step without docker compose logs. */
export type InstallBlocker = {
  id: "docker" | "ca" | "worker" | "model";
  title: string;
  reason: string;
  next: string;
};

export const installBlockers = {
  dockerMissing: {
    id: "docker",
    title: "需要先安装 Docker",
    reason: "本机未找到 docker，或 Docker Compose v2 不可用，或当前账户访问不了 Docker 守护进程。",
    next:
      "请按 Docker 官方文档安装 Docker Engine 与 Compose v2，启动服务并确认当前账户有权执行 docker（例如已加入 docker 组）；然后重新运行 willcord main init。向导不会替你安装 Docker，也不会修改系统权限。",
  },
  caUntrusted: {
    id: "ca",
    title: "浏览器尚未信任主节点证书",
    reason: "工作台使用主节点自签根证书，浏览器在信任之前会拒绝 HTTPS 连接。",
    next:
      "在运行 willcord main init 的那台机器上执行向导打印的 willcord trust-ca 命令（或按登录页「信任证书」导入 ca.pem），确认能安全打开控制台后再登录。",
  },
  workerOffline: {
    id: "worker",
    title: "worker 尚未连上主节点",
    reason: "机器可能已批准，但 worker 服务未运行、地址不对，或执行机器访问不了主节点的 HTTPS/WSS。",
    next:
      "在执行机器上运行控制台「添加机器」里的命令；核对终端节点指纹后在控制台批准。若已批准仍离线，执行 willcord worker status --json，确认服务在运行且加入链接里的地址与主节点 PUBLIC_BASE_URL 一致（不要用其他机器无法解析的 localhost）。",
  },
  modelUnbound: {
    id: "model",
    title: "尚未绑定模型 API key",
    reason: "主节点还没有可用的模型连接，诊断任务无法调用模型。",
    next: "点击顶部「绑定模型」或侧栏「模型连接」，填入你自己的 provider API key 并保存；可先点「测试连接」确认可用。",
  },
} satisfies Record<string, InstallBlocker>;

export function blockerMessage(blocker: InstallBlocker): string {
  return `${blocker.reason} ${blocker.next}`;
}
