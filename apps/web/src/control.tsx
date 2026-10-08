// P4 operator controls: cancel, budget use, attention handling and full logs.
import React, { useEffect, useState } from "react";
import { request } from "./api";

export type JobControl = {
  job_id: string;
  worker_id: string;
  state: string;
  cancel_requested?: number;
  cancel_reason?: string | null;
  end_reason?: string | null;
  max_tool_calls?: number | null;
  max_tokens?: number | null;
  deadline_at?: number | null;
  tool_calls_used?: number | null;
  tokens_used?: number | null;
};
type AttentionCall = {
  job_id: string;
  call_id: string;
  call_seq: number;
  tool_name: string;
  arguments: { command?: string; path?: string };
  status: "unknown" | "resolved";
  worker_id: string;
  job_state: string;
};
type Attention = {
  workers: { worker_id: string; blocked: number; unblock_pending: number; reported_ledger_id: string | null }[];
  calls: AttentionCall[];
  actions: { action_id: string; action: string; job_id: string | null; worker_id: string; created_at: number; evidence: unknown }[];
};
type Outcome = "executed" | "not_executed" | "terminated";

const endReasons: Record<string, string> = {
  completed: "正常完成",
  cancelled_by_user: "用户取消",
  abandoned: "已放弃",
  deadline_exceeded: "超出运行时限",
  budget_tool_calls: "超出工具调用次数",
  budget_tokens: "超出 token 预算",
  budget_model_turns: "超出模型轮次上限",
  worker_disk_full: "机器磁盘空间不足，未执行",
  worker_wait_expired: "等待机器上线超时",
};
const outcomes: Record<Outcome, string> = {
  executed: "已执行完毕",
  not_executed: "确认未执行",
  terminated: "执行中被终止",
};
const post = <T,>(url: string, body?: object) =>
  request<T>(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

export const endReasonLabel = (reason?: string | null) => (reason ? (endReasons[reason] ?? reason) : "");

/** Budget use and the reason a job ended, for the job inspector. */
export function BudgetRows({ job, now }: { job: JobControl; now: number }) {
  const remaining = job.deadline_at ? Math.max(0, Math.round((job.deadline_at - now) / 1000)) : null;
  return (
    <>
      {job.max_tool_calls != null && (
        <div>
          <dt>工具次数</dt>
          <dd>{job.tool_calls_used ?? 0} / {job.max_tool_calls}</dd>
        </div>
      )}
      {job.max_tokens != null && (
        <div>
          <dt>Token</dt>
          <dd>{(job.tokens_used ?? 0).toLocaleString()} / {job.max_tokens.toLocaleString()}</dd>
        </div>
      )}
      {remaining !== null && ["running", "cancel_requested"].includes(job.state) && (
        <div>
          <dt>剩余时限</dt>
          <dd>{remaining >= 3600 ? `${Math.floor(remaining / 3600)} 小时 ${Math.floor((remaining % 3600) / 60)} 分` : remaining >= 60 ? `${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒` : `${remaining} 秒`}</dd>
        </div>
      )}
      {job.end_reason && (
        <div>
          <dt>结束原因</dt>
          <dd>{endReasonLabel(job.end_reason)}</dd>
        </div>
      )}
    </>
  );
}

/** Cancel for queued or running work; the job shows "正在停止" until the worker confirms. */
export function CancelButton({ job, onDone, onError }: { job: JobControl; onDone: () => void; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  if (job.state === "cancel_requested")
    return <p className="inspector-note">正在停止：命令确认结束前，这台机器不会开始下一个任务。</p>;
  if (!["queued", "waiting_worker", "running"].includes(job.state)) return null;
  return (
    <button
      type="button"
      className="secondary-button danger-action"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("取消这个任务？正在运行的命令会被终止。")) return;
        setBusy(true);
        try { await post(`/api/jobs/${job.job_id}/cancel`); onDone(); } catch (e) { onError(e); } finally { setBusy(false); }
      }}
    >
      {busy ? "正在取消…" : "取消任务"}
    </button>
  );
}

/** Retry a finished job under a new ID; the operator checks side effects first. */
export function RetryButton({ job, onDone, onError }: { job: JobControl; onDone: (jobId: string, notice: string) => void; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  if (!["succeeded", "failed", "cancelled"].includes(job.state)) return null;
  return (
    <button
      type="button"
      className="secondary-button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("以相同内容新建一个任务？新任务不知道原任务做过什么，请先核对原任务已产生的副作用。")) return;
        setBusy(true);
        try {
          const retry = await post<{ job_id: string; notice: string }>(`/api/jobs/${job.job_id}/retry`);
          onDone(retry.job_id, retry.notice);
        } catch (e) { onError(e); } finally { setBusy(false); }
      }}
    >
      新建重试
    </button>
  );
}

/**
 * Manual handling of a job or machine whose execution cannot be proven.
 * Nothing here re-runs anything: the operator records what they verified.
 */
export function AttentionPanel({ job, workerId, workerBlocked, refreshKey, onDone, onError }: {
  job: JobControl | undefined;
  workerId: string;
  workerBlocked: boolean;
  refreshKey: number;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const [view, setView] = useState<Attention | null>(null);
  const [note, setNote] = useState(""), [evidence, setEvidence] = useState("");
  const [choices, setChoices] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<Attention>("/api/attention", { signal: controller.signal }).then(setView, (e) => { if (!controller.signal.aborted) onError(e); });
    return () => controller.abort();
  }, [refreshKey, workerId]);
  if (!view) return null;
  const calls = view.calls.filter((c) => c.worker_id === workerId);
  const unknown = calls.filter((c) => c.status === "unknown");
  const pending = view.workers.find((w) => w.worker_id === workerId);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); onDone(); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <section className="attention-panel" aria-label="人工核对">
      <p className="attention-note">
        这些调用的执行情况无法证明。机器会一直保留占用，不会自动重跑，直到你核对后解除。
      </p>
      {calls.length > 0 && (
        <ul className="attention-calls">
          {calls.map((c) => (
            <li key={c.call_id}>
              <code>{c.tool_name}</code> {c.arguments.command ?? c.arguments.path ?? ""}
              <span className="call-id">调用 {c.call_id}{c.status === "resolved" ? " · 已核对，等待机器确认" : ""}</span>
              {c.status === "unknown" && (
                <select
                  aria-label={`调用 ${c.call_id} 的核对结果`}
                  value={choices[c.call_id] ?? ""}
                  onChange={(e) => setChoices({ ...choices, [c.call_id]: e.target.value as Outcome })}
                >
                  <option value="" disabled>选择核对结果</option>
                  {(Object.keys(outcomes) as Outcome[]).map((o) => <option key={o} value={o}>{outcomes[o]}</option>)}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending?.reported_ledger_id && <p className="inspector-note">机器上报了新的账本，解除后将采用它。</p>}
      {job?.state === "needs_attention" && (
        <div className="attention-action">
          <label>放弃说明<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></label>
          <button type="button" className="secondary-button" disabled={busy || !note.trim()} onClick={() => act(() => post(`/api/jobs/${job.job_id}/abandon`, { note }))}>
            放弃任务
          </button>
          <span className="inspector-note">放弃只结束任务，不会解除机器阻塞。</span>
        </div>
      )}
      {workerBlocked && job?.state !== "needs_attention" && (
        <div className="attention-action">
          <label>核对依据（必填）<textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={3} placeholder="例如：已登录机器，进程不存在，marker 只有一行" /></label>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !evidence.trim() || unknown.some((c) => !choices[c.call_id]) || Boolean(pending?.unblock_pending)}
            onClick={() => act(() => post(`/api/workers/${workerId}/unblock`, { evidence, resolutions: unknown.map((c) => ({ call_id: c.call_id, outcome: choices[c.call_id] })) }))}
          >
            {pending?.unblock_pending ? "等待机器确认" : "解除阻塞"}
          </button>
        </div>
      )}
    </section>
  );
}

type LogPage = { chunks: number | null; bytes_total: number | null; worker_truncated: number; main_truncated: number; state: string; items: { seq: number; data: string }[] };
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The stored output of one command, fetched page by page. */
export function LogViewer({ jobId, callId }: { jobId: string; callId: string }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [text, setText] = useState(""), [next, setNext] = useState(0);
  const [page, setPage] = useState<LogPage | null>(null), [error, setError] = useState("");
  const load = async (from: number, s = stream, append = true) => {
    try {
      const data = await request<LogPage>(`/api/jobs/${jobId}/calls/${callId}/logs?stream=${s}&from_seq=${from}`);
      const bytes = data.items.map((i) => decode(i.data));
      const merged = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
      bytes.reduce((at, b) => (merged.set(b, at), at + b.length), 0);
      const chunk = new TextDecoder().decode(merged);
      setText((t) => (append ? t + chunk : chunk));
      setNext(data.items.length ? data.items.at(-1)!.seq + 1 : from);
      setPage(data); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "无法读取日志"); }
  };
  useEffect(() => { setText(""); void load(0, stream, false); }, [stream, jobId, callId]);
  const more = page && page.chunks !== null && next < page.chunks && page.items.length > 0;
  return (
    <div className="log-viewer">
      <div className="log-tabs" role="tablist">
        {(["stdout", "stderr"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={stream === s} className={stream === s ? "active" : ""} onClick={() => setStream(s)}>{s}</button>
        ))}
      </div>
      {error ? <p className="danger-text">{error}</p> : <pre>{text || "无输出"}</pre>}
      {page && (
        <p className="output-notice">
          {page.bytes_total != null ? `共 ${page.bytes_total.toLocaleString()} 字节` : "输出仍在传输"}
          {page.worker_truncated ? " · 机器只保存了前 10 MiB" : ""}
          {page.main_truncated ? " · 主节点容量已满，超出部分未保存" : ""}
          {page.state === "expired" ? " · 机器已不再保留缺失部分" : ""}
        </p>
      )}
      {more && <button type="button" className="secondary-button" onClick={() => load(next)}>加载更多</button>}
    </div>
  );
}
