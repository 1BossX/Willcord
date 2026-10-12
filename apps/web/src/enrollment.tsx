import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { request } from "./api";
import { Icon } from "./icon";
import { getPendingCount, refreshPending, setPendingLoader, subscribePending } from "./pending-store";
import { installCommand, isLoopbackOrigin, joinCommand, loadCaFingerprint } from "./install-command";

type Device = {
  worker_id: string; name: string; os: string; arch: string; state: string; created_at: number;
  online: number | null; reconciled: number | null; blocked: number | null; active_job_id: string | null;
  workspaces: Array<{ workspace_id: string; path: string; is_default: number }>;
};
setPendingLoader(async () => (await request<{ devices: Device[] }>("/api/enrollments")).devices.filter(d => d.state === "pending").length);
export function usePendingEnrollments(): number {
  // subscribePending is module-level: a new function per render would make React resubscribe each time.
  return useSyncExternalStore(subscribePending, getPendingCount);
}
/** Enough rows for the whole command at the dialog's width, so none of it needs scrolling. */
const commandRows = (text: string) => Math.min(8, Math.ceil(text.length / 45));
const OPEN_EVENT = "willcord:open-enrollment";
export const openEnrollment = () => window.dispatchEvent(new Event(OPEN_EVENT));
const states: Record<string, string> = { pending: "等待授权", approved: "已授权", rejected: "已拒绝", revoked: "已撤销" };
export function EnrollmentPanel() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pending = usePendingEnrollments();
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
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  // Workers need the address the main node was set up with, not whatever this browser used to reach it,
  // so no command is built until that address has arrived.
  const origin = publicUrl;
  let fresh = "", installed = "", commandError = "";
  try {
    const caFile = trustMode === "file" ? ca : "", pin = trustMode === "pin" ? fingerprint : undefined;
    if (origin === null) throw new Error("正在读取主节点地址…");
    if (trustMode === "file" && !ca) throw new Error("请填写 CA 绝对路径");
    fresh = installCommand(origin, caFile, system, pin);
    installed = joinCommand(origin, caFile, system, pin);
  } catch (e) { commandError = trustError || (e instanceof Error ? e.message : String(e)); }
  async function copyCommand(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyStatus("已复制命令"); }
    catch { setCopyStatus("复制失败，请选中命令手动复制"); }
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const data = await request<{ devices: Device[]; public_url?: string }>("/api/enrollments", { signal: controller.signal });
        if (!controller.signal.aborted) { setError(""); setDevices(data.devices); setPublicUrl(data.public_url ?? window.location.origin); setLoaded(true); }
      } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
      finally { loading = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [open, revision]);
  function close() { dialog.current?.close(); setOpen(false); setEditing(null); setError(""); setLoaded(false); }
  useEffect(() => {
    const show = () => { dialog.current?.showModal(); setOpen(true); };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);
  async function mutate(url: string, method: string, body: object) {
    setBusy(true); setError("");
    try {
      await request(url, { method, body: JSON.stringify(body) });
      setRevision(r => r + 1);
      setEditing(null);
      refreshPending();
      if (url.endsWith("/approve")) sessionStorage.setItem("willcord-await-first-diagnosis", "1");
    }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <>
    <button className="nav-button sidebar-link" onClick={() => { dialog.current?.showModal(); setOpen(true); }}><Icon name="shield" />机器授权{pending > 0 && <span className="pending-badge">{pending} 台待批准</span>}</button>
    <dialog ref={dialog} className="session-dialog enrollment-dialog" aria-labelledby="enrollment-title" onCancel={close}>
      <div className="dialog-heading"><h2 id="enrollment-title">机器授权</h2><button className="secondary-button" onClick={close} aria-label="关闭机器授权">关闭</button></div>
      <button className="secondary-button" aria-expanded={adding} onClick={() => { setAdding(v => !v); setCopyStatus(""); }}>添加机器</button>
      {adding && <section className="enrollment-install" aria-label="添加机器">
        <p>主节点：<strong>{origin ?? "…"}</strong></p>
        {origin !== null && isLoopbackOrigin(origin) && <p role="alert">这个地址只在本机有效，其他机器连不上。请用主节点的局域网或域名地址打开控制台，再复制命令。</p>}
        {fresh ? <>
          <label>在执行机器上运行（还没有 willcord 命令）<textarea readOnly value={fresh} rows={commandRows(fresh)} /></label>
          <button className="primary-button" onClick={() => void copyCommand(fresh)}>复制命令</button>
          <label>已经装过 willcord 命令的机器<textarea readOnly value={installed} rows={commandRows(installed)} /></label>
          <button className="secondary-button" onClick={() => void copyCommand(installed)}>复制命令</button>
        </> : <p>{commandError || "正在读取主节点地址和 CA 指纹…"}</p>}
        <p role="status">{copyStatus}</p>
        <details>
          <summary>高级选项</summary>
          <label>安装方式<select value={system ? "system" : "user"} onChange={e => { setSystem(e.target.value === "system"); setCopyStatus(""); }}>
            <option value="user">个人电脑：用户级服务</option><option value="system">常驻服务器：系统级服务</option>
          </select></label>
          <p>{system ? "系统级安装需要 sudo，服务以执行 sudo 的账户运行；要换账户，在命令末尾加 --user 账户名。" : "macOS 登录后运行；Linux 退出登录后持续运行需要管理员配置 linger。"}</p>
          <label>证书信任<select value={trustMode} onChange={e => { setTrustMode(e.target.value); setCopyStatus(""); }}>
            <option value="pin">自动获取 CA（推荐）</option><option value="file">手动 CA 文件</option><option value="system">系统信任（公共或已信任证书）</option>
          </select></label>
          {trustMode === "pin" && <><p>主节点 CA 指纹（已写入命令，与设备指纹不同）</p><code>{fingerprint || trustError || "正在读取 CA 指纹…"}</code></>}
          {trustMode === "file" && <label>执行机器上的 CA 绝对路径<input value={ca} placeholder="/absolute/ca.pem" onChange={e => { setCa(e.target.value); setCopyStatus(""); }} /></label>}
          {trustMode === "system" && <p>仅适用于执行机器已经信任主节点证书的部署；验证失败会停止，不会自动盲信。</p>}
        </details>
        <p>命令里的 CA 指纹由执行机器核对，无需手动复制证书。安装后在终端核对节点指纹，再到下方批准。机器显示「可执行」后，工作台会引导你选择诊断场景并开始第一次诊断。</p>
      </section>}
      <p>批准前，请核对本机终端显示的节点指纹。</p>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p role="status">正在读取加入申请…</p>}
      {loaded && !devices.length && <p>尚无加入申请。在执行机器上运行“添加机器”里的安装命令后，申请会出现在这里。</p>}
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
