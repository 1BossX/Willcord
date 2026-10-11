export const installerUrl = "https://bossoptional.github.io/Willcord/install.sh";
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export function installCommand(origin: string, ca: string, system: boolean, account: string, fingerprint?: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("主节点地址必须是 HTTPS origin");
  if (ca && fingerprint) throw new Error("不能同时提供 CA 文件和指纹");
  if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("等待主节点 CA 指纹");
  if (ca && (!ca.startsWith("/") || /[\r\n\0]/.test(ca))) throw new Error("请填写执行机器上 CA 文件的绝对路径");
  if (system && (!/^[A-Za-z0-9._-]{1,64}$/.test(account) || account.startsWith("-") || account === "root")) {
    throw new Error("请填写已有的非 root 执行账户");
  }
  const args = ["worker", "--server", origin];
  if (ca) args.push("--ca", ca);
  if (fingerprint) args.push("--ca-fingerprint", fingerprint);
  if (system) args.push("--system", "--user", account);
  return `curl -fsSL ${shellQuote(installerUrl)} | bash -s -- ${args.map(shellQuote).join(" ")}`;
}

/** Root fetched over the administrator's already-trusted HTTPS connection. */
export async function certificateFingerprint(pem: string): Promise<string> {
  if (pem.length > 65536) throw new Error("根证书过大");
  const match = pem.match(/^\s*-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END CERTIFICATE-----\s*$/);
  if (!match) throw new Error("主节点未提供单张 PEM 根证书");
  const der = Uint8Array.from(atob(match[1].replace(/\s/g, "")), c => c.charCodeAt(0));
  const hash = await crypto.subtle.digest("SHA-256", der);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
export async function loadCaFingerprint(signal: AbortSignal): Promise<string> {
  const response = await fetch("/.well-known/willcord/ca.pem", { signal, credentials: "omit", redirect: "error", cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("主节点未启用 CA 自动获取，可选择手动 CA 或系统信任");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new Error("根证书响应过大");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return certificateFingerprint(new TextDecoder().decode(bytes));
}
