export const installerUrl = "https://1bossx.github.io/Willcord/install.sh";
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export function installCommand(origin: string, ca: string, system: boolean, account: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("主节点地址必须是 HTTPS origin");
  if (!ca.startsWith("/") || /[\r\n\0]/.test(ca)) throw new Error("请填写执行机器上 CA 文件的绝对路径");
  if (system && (!/^[A-Za-z0-9._-]{1,64}$/.test(account) || account.startsWith("-") || account === "root")) {
    throw new Error("请填写已有的非 root 执行账户");
  }
  const args = ["worker", "--server", origin, "--ca", ca];
  if (system) args.push("--system", "--user", account);
  return `curl -fsSL ${shellQuote(installerUrl)} | bash -s -- ${args.map(shellQuote).join(" ")}`;
}
