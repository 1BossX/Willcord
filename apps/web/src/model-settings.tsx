import { useEffect, useRef, useState } from "react";
import { request } from "./api";

type View = {
  provider: string; name: string; has_key: boolean; key_hint: string | null;
  source: "console" | "environment"; key_unreadable: boolean; providers: string[];
};
const sources = { console: "控制台设置", environment: "主节点环境变量" } as const;

/** Where the main node's model connection is chosen; applies to jobs started after saving. */
export function ModelSettingsPanel() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  function show(next: View) { setView(next); setProvider(next.provider); setName(next.name); setApiKey(""); }
  async function load() {
    try { show(await request<View>("/api/settings/model")); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { if (open) void load(); }, [open]);
  useEffect(() => {
    if (!open || !provider) return;
    const controller = new AbortController();
    request<{ models: string[] }>(`/api/settings/model/models?provider=${encodeURIComponent(provider)}`, { signal: controller.signal })
      .then(r => { if (!controller.signal.aborted) setModels(r.models); })
      .catch(() => { if (!controller.signal.aborted) setModels([]); });
    return () => controller.abort();
  }, [open, provider]);

  const body = () => ({ provider, name, ...(apiKey ? { api_key: apiKey } : {}) });
  // Another provider cannot reuse the key in effect, so the field is required then.
  const needsKey = view !== null && provider !== view.provider && !apiKey;
  const dirty = view !== null && (provider !== view.provider || name !== view.name || apiKey !== "");
  function close() { dialog.current?.close(); setOpen(false); setError(""); setResult(null); setApiKey(""); }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setResult(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const test = () => run(async () => {
    const r = await request<{ ok: boolean; message: string }>("/api/settings/model/test", { method: "POST", body: JSON.stringify(body()) });
    setResult({ ok: r.ok, text: r.ok ? "连接正常：模型返回了响应。" : `连接失败：${r.message}` });
  });
  const save = () => run(async () => {
    show(await request<View>("/api/settings/model", { method: "PUT", body: JSON.stringify(body()) }));
    setResult({ ok: true, text: "已保存。之后开始的任务使用新配置，正在运行的任务不受影响。" });
  });
  const reset = () => run(async () => {
    if (!window.confirm("删除控制台里的模型设置，改用主节点环境变量？")) return;
    show(await request<View>("/api/settings/model", { method: "DELETE" }));
    setResult({ ok: true, text: "已恢复为主节点环境变量中的配置。" });
  });

  return <>
    <button className="enrollment-open" onClick={() => { dialog.current?.showModal(); setOpen(true); }}>模型连接</button>
    <dialog ref={dialog} className="session-dialog enrollment-dialog" aria-labelledby="model-title" onCancel={close}>
      <div className="dialog-heading"><h2 id="model-title">模型连接</h2><button className="secondary-button" onClick={close} aria-label="关闭模型连接">关闭</button></div>
      <p>模型调用只发生在主节点，API key 不会发送到执行机器，也不会在这里显示。</p>
      {view && <p>当前：<strong>{view.provider} / {view.name}</strong> · API key {view.has_key ? `已设置${view.key_hint ? `（${view.key_hint}）` : ""}` : "未设置"} · 来源：{sources[view.source]}</p>}
      {view?.key_unreadable && <p role="alert">已保存的 API key 无法解密（数据库可能从备份恢复，缺少本机密钥文件）。请重新输入 API key。</p>}
      {view && !view.has_key && !view.key_unreadable && <p role="alert">尚未设置 API key，任务会因模型调用失败而结束。</p>}
      {view && <form className="enrollment-install" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>Provider<select value={provider} onChange={e => { setProvider(e.target.value); setName(e.target.value === view.provider ? view.name : ""); setResult(null); }}>
          {[...new Set([view.provider, ...view.providers])].map(p => <option key={p} value={p}>{p}</option>)}
        </select></label>
        <label>模型名称<input value={name} list="model-names" autoComplete="off" spellCheck={false} onChange={e => { setName(e.target.value); setResult(null); }} />
          <datalist id="model-names">{models.map(m => <option key={m} value={m} />)}</datalist></label>
        <label>API key<input type="password" value={apiKey} autoComplete="new-password" placeholder={needsKey ? "切换 provider 后必须输入新的 key" : "留空则保持当前 key"} onChange={e => { setApiKey(e.target.value); setResult(null); }} /></label>
        <p>保存前可先“测试连接”：向模型发送一个很短的请求，会消耗极少量 token。</p>
        <button className="secondary-button" type="button" disabled={busy || !name.trim() || needsKey} onClick={() => void test()}>测试连接</button>{" "}
        <button className="primary-button" type="submit" disabled={busy || !name.trim() || needsKey || !dirty}>保存</button>{" "}
        {view.source === "console" && <button className="secondary-button" type="button" disabled={busy} onClick={() => void reset()}>恢复为环境变量</button>}
      </form>}
      {result && <p role="status" className={result.ok ? "" : "form-error"}>{result.text}</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>
  </>;
}
