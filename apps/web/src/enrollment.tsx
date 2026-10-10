import { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { installCommand, loadCaFingerprint } from "./install-command";

type Device = {
  worker_id: string; name: string; os: string; arch: string; state: string; created_at: number;
  online: number | null; reconciled: number | null; blocked: number | null; active_job_id: string | null;
  workspaces: Array<{ workspace_id: string; path: string; is_default: number }>;
};
const states: Record<string, string> = { pending: "等待授权", approved: "已授权", rejected: "已拒绝", revoked: "已撤销" };
export function EnrollmentPanel() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [system, setSystem] = useState(false);
  const [ca, setCa] = useState("");
  const [trustMode, setTrustMode] = useState("pin");
  const [fingerprint, setFingerprint] = useState("");
  const [trustError, setTrustError] = useState("");
  useEffect(() => {
    if (!open || !adding || trustMode !== "pin") return;
    const controller = new AbortController();
    setFingerprint(""); setTrustError("");
    void loadCaFingerprint(controller.signal).then(value => {
      if (!controller.signal.aborted) setFingerprint(value);
    }).catch(e => { if (!controller.signal.aborted) setTrustError(String(e)); });
    return () => controller.abort();
  }, [open, adding, trustMode]);
  const [account, setAccount] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  let command = "", commandError = "";
  try { command = installCommand(window.location.origin, trustMode === "file" ? ca : "", system, account, trustMode === "pin" ? fingerprint : undefined); }
  catch (e) { commandError = e instanceof Error ? e.message : String(e); }
  if (trustMode === "file" && !ca) { command = ""; commandError = "请填写 CA 绝对路径"; }
  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setCopyStatus("已复制安装命令"); }
    catch { setCopyStatus("复制失败，请选中下方命令手动复制"); }
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const data = await request<{ devices: Device[] }>("/api/enrollments", { signal: controller.signal });
        if (!controller.signal.aborted) { setError(""); setDevices(data.devices); }
      } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
      finally { loading = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [open, revision]);
  function close() { dialog.current?.close(); setOpen(false); setEditing(null); setError(""); }
  async function mutate(url: string, method: string, body: object) {
    setBusy(true); setError("");
    try { await request(url, { method, body: JSON.stringify(body) }); setRevision(r => r + 1); setEditing(null); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <>
    <button className="enrollment-open" onClick={() => { dialog.current?.showModal(); setOpen(true); }}>机器授权</button>
    <dialog ref={dialog} className="session-dialog enrollment-dialog" aria-labelledby="enrollment-title" onCancel={close}>
      <div className="dialog-heading"><h2 id="enrollment-title">机器授权</h2><button className="secondary-button" onClick={close} aria-label="关闭机器授权">关闭</button></div>
      <button className="secondary-button" aria-expanded={adding} onClick={() => { setAdding(v => !v); setCopyStatus(""); }}>添加机器</button>
      {adding && <section className="enrollment-install" aria-label="添加机器">
        <p>主节点：<strong>{window.location.origin}</strong></p>
        <p>从可信控制台复制命令，安装器自动获取并核对 CA，无需提前复制证书文件。安装后仍需批准设备。</p>
        <label>安装方式<select value={system ? "system" : "user"} onChange={e => { setSystem(e.target.value === "system"); setCopyStatus(""); }}>
          <option value="user">个人电脑：用户级服务</option><option value="system">常驻服务器：系统级服务</option>
        </select></label>
        <p>{system ? "系统级安装需要 sudo，以指定账户执行；账户必须已存在。" : "macOS 登录后运行；Linux 退出登录后持续运行需要管理员配置 linger。"}</p>
        <label>证书信任<select value={trustMode} onChange={e => { setTrustMode(e.target.value); setCopyStatus(""); }}>
          <option value="pin">自动获取 CA（推荐）</option><option value="file">手动 CA 文件</option><option value="system">系统信任（公共或已信任证书）</option>
        </select></label>
        {trustMode === "pin" && <><p>主节点 CA 指纹（与设备指纹不同）</p><code>{fingerprint || trustError || "正在读取 CA 指纹…"}</code></>}
        {trustMode === "file" && <label>执行机器上的 CA 绝对路径<input value={ca} placeholder="/absolute/ca.pem" onChange={e => { setCa(e.target.value); setCopyStatus(""); }} /></label>}
        {trustMode === "system" && <p>仅适用于执行机器已经信任主节点证书的部署；验证失败会停止，不会自动盲信。</p>}
        {system && <label>已有非 root 执行账户<input value={account} placeholder="ops" onChange={e => { setAccount(e.target.value); setCopyStatus(""); }} /></label>}
        {command ? <><textarea aria-label="一行安装命令" readOnly value={command} rows={4} /><button className="primary-button" onClick={() => void copyCommand()}>复制安装命令</button></> : <p>{commandError}</p>}
        <p role="status">{copyStatus}</p>
        <p>安装后核对终端与下方的指纹并批准。等待“可执行”，创建独立会话，输入“列出当前工作目录的文件，并报告工作目录路径”。</p>
      </section>}
      <p>批准前，请核对本机终端显示的节点指纹。</p>
      {error && <p role="alert">{error}</p>}
      {!devices.length && <p>尚无加入申请。安装 worker 后运行 join 即可申请。</p>}
      {devices.map(d => <article className="enrollment-device" key={d.worker_id}>
        <strong>{d.name}</strong><p>{d.os} / {d.arch} · {states[d.state]}</p>
        <p>节点 ID / 公钥 SHA-256 指纹</p><code>{d.worker_id}</code><p>{new Date(d.created_at).toLocaleString()}</p>
        {d.state === "approved" && <p>{d.blocked ? "需要核对" : !d.online ? "离线" : !d.reconciled ? "对账中" : d.active_job_id ? "正在执行" : "可执行"}</p>}
        {d.workspaces.map(w => <p key={w.workspace_id}>{w.workspace_id}{w.is_default ? "（默认）" : ""} · {w.path}</p>)}
        {d.state !== "approved" && <button className="primary-button" disabled={busy} onClick={() => void mutate(`/api/enrollments/${d.worker_id}/approve`, "POST", {})}>核对指纹后批准</button>}
        {d.state === "pending" && <button className="secondary-button" disabled={busy} onClick={() => void mutate(`/api/enrollments/${d.worker_id}/reject`, "POST", {})}>拒绝</button>}
        {d.state === "approved" && <button className="secondary-button" disabled={busy} onClick={() => void mutate(`/api/enrollments/${d.worker_id}/revoke`, "POST", {})}>撤销授权</button>}
        <button className="secondary-button" disabled={busy} onClick={() => { setEditing(d.worker_id); setName(d.name); }}>修改名称</button>
        {editing === d.worker_id && <form onSubmit={e => { e.preventDefault(); void mutate(`/api/enrollments/${d.worker_id}`, "PATCH", { name }); }}>
          <label>机器名称<input value={name} maxLength={128} onChange={e => setName(e.target.value)} /></label>
          <button className="primary-button" disabled={busy || !name.trim()} type="submit">保存</button>
        </form>}
      </article>)}
    </dialog>
  </>;
}
