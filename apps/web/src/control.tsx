// P4 operator controls: cancel, budget use, attention handling and full logs.
import React, { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { endReasonLabel } from "./end-reasons";
import type { Alert } from "./feed-state";
export { endReasonLabel };

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
  model_turns?: number | null;
  max_model_turns?: number | null;
  /** Set on a job a Main Agent delegated; it shares its parent's budget and is retried through the parent. */
  parent_job_id?: string | null;
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

const outcomes: Record<Outcome, string> = {
  executed: "已执行完毕",
  not_executed: "确认未执行",
  terminated: "执行中被终止",
};
const post = <T,>(url: string, body?: object) =>
  request<T>(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

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
      {job.max_model_turns != null && (
        <div>
          <dt>模型轮次</dt>
          <dd>{job.model_turns ?? 0} / {job.max_model_turns}</dd>
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

/** How long the "confirm" step waits before it goes back to a plain cancel button. */
const CONFIRM_MS = 4000;

/**
 * Cancel in two clicks, in place: the first asks, the second confirms, and an
 * ignored question goes away by itself. No dialog, so it can sit on a command's card.
 */
export function InlineCancel({ job, onDone, onError, label = "取消", question = "停止命令？", className = "secondary-button danger-action" }: {
  job: JobControl; onDone: () => void; onError: (e: unknown) => void; label?: string; question?: string; className?: string;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  useEffect(() => {
    if (step !== "confirm") return;
    const timer = setTimeout(() => setStep("idle"), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [step]);
  if (step === "idle")
    return <button type="button" className={className} onClick={() => setStep("confirm")}>{label}</button>;
  return (
    <span className="inline-confirm" role="group" aria-label={question}>
      <span>{question}</span>
      <button
        type="button"
        className={className}
        disabled={step === "busy"}
        autoFocus
        onClick={async () => {
          setStep("busy");
          try { await post(`/api/jobs/${job.job_id}/cancel`); onDone(); } catch (e) { onError(e); } finally { setStep("idle"); }
        }}
      >
        {step === "busy" ? "正在取消…" : "确认停止"}
      </button>
      <button type="button" className="secondary-button" disabled={step === "busy"} onClick={() => setStep("idle")}>返回</button>
    </span>
  );
}

/** Cancel for queued or running work; the job shows "正在停止" until the worker confirms. */
export function CancelButton({ job, onDone, onError }: { job: JobControl; onDone: () => void; onError: (e: unknown) => void }) {
  if (job.state === "cancel_requested")
    return <p className="inspector-note">正在停止：命令确认结束前，这台机器不会开始下一个任务。</p>;
  if (!["queued", "waiting_worker", "running", "waiting_children"].includes(job.state)) return null;
  return <InlineCancel job={job} onDone={onDone} onError={onError} label="取消任务" question="取消这个任务？正在运行的命令会被终止。" />;
}

/** Retry a finished job under a new ID; the operator checks side effects first. */
export function RetryButton({ job, onDone, onError }: { job: JobControl; onDone: (jobId: string, notice: string) => void; onError: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  if (!["succeeded", "failed", "cancelled"].includes(job.state)) return null;
  if (job.parent_job_id) return <span className="subtle-text">委派任务由 Main Agent 决定是否重新委派</span>;
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

const pauseReasons: Record<string, string> = {
  restored: "主节点从备份恢复，已暂停调度。请等每台机器重新连接并完成账本核对，确认没有备份之后才执行的调用后再恢复。",
  disk_low: "主节点数据目录剩余空间不足，已暂停调度。空间恢复后会自动继续。",
  operator: "调度已由管理员暂停。",
};

/** One line for the current dispatch state: the reason while paused, an idle notice otherwise. */
export function dispatchNotice(dispatch: { paused: number; reason: string | null; note: string | null } | null): string | null {
  if (!dispatch) return null;
  if (!dispatch.paused) return null;
  const reason = dispatch.reason ?? "operator";
  return pauseReasons[reason] ?? `调度已暂停：${reason}`;
}

/** Shown while the main node starts nothing; resuming needs a note, and after a restore every worker reconciled. */
export function DispatchBanner({ dispatch, unreconciled, onError }: {
  dispatch: { paused: number; reason: string | null; note: string | null } | null;
  /** Known workers that have not reconciled their ledger since this start. */
  unreconciled: string[];
  onError: (e: unknown) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  if (!dispatch) return null;
  const paused = Boolean(dispatch.paused);
  const reason = dispatch.reason ?? "operator";
  const waiting = paused && reason === "restored" && unreconciled.length > 0;
  const notice = dispatchNotice(dispatch);
  if (!paused && !pausing) return (
    <details className="dispatch-banner dispatch-pause-control" role="group" aria-label="调度控制">
      <summary>调度进行中</summary>
      <p>调度正常：任务按队列在机器上执行。升级、备份或排查时可以暂停调度，暂停后不会开始或恢复任何任务，已在执行的任务会跑完。</p>
      <div className="attention-action">
        <label>暂停说明（必填）<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="例如：升级到新版本" /></label>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !note.trim()}
          onClick={async () => {
            setBusy(true);
            try { await post("/api/ops/pause", { note }); setNote(""); setPausing(false); } catch (e) { onError(e); } finally { setBusy(false); }
          }}
        >
          暂停调度
        </button>
      </div>
    </details>
  );
  return (
    <section className="dispatch-banner" role="status" aria-label="调度已暂停">
      <p>{notice}</p>
      {dispatch.note && <p className="inspector-note">{dispatch.note}</p>}
      {waiting && <p className="inspector-note">尚未核对账本的机器：{unreconciled.join("、")}</p>}
      {reason !== "disk_low" && (
        <div className="attention-action">
          <label>恢复说明（必填）<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="例如：两台机器已重连，账本无矛盾" /></label>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !note.trim() || waiting}
            onClick={async () => {
              setBusy(true);
              try { await post("/api/ops/resume", { note }); setNote(""); } catch (e) { onError(e); } finally { setBusy(false); }
            }}
          >
            恢复调度
          </button>
        </div>
      )}
    </section>
  );
}

/** Newest device alerts first (#86). Collapsed by default so a healthy fleet shows one quiet line. */
export function AlertList({ alerts }: { alerts: Alert[] }) {
  const [open, setOpen] = useState(false);
  if (!alerts.length) return null;
  const shown = open ? alerts : alerts.slice(0, 3);
  return (
    <section className="alert-list" role="log" aria-label="设备告警">
      <h2>设备告警</h2>
      <ul>
        {shown.map((a) => (
          <li key={a.alert_id} className={`alert-item alert-${a.severity}`}>
            <span className="alert-time">{new Date(a.created_at).toLocaleString()}</span>
            <span>{a.message}</span>
          </li>
        ))}
      </ul>
      {alerts.length > 3 && (
        <button type="button" className="secondary-button" onClick={() => setOpen(!open)}>
          {open ? "收起" : `还有 ${alerts.length - 3} 条…`}
        </button>
      )}
    </section>
  );
}

type LogGap = { from_seq: number; to_seq: number | null; from_offset: number; missing_bytes: number | null };
type LogPage = { chunks: number | null; bytes_total: number | null; worker_truncated: number; main_truncated: number; state: string; gaps: LogGap[]; items: { seq: number; offset: number; data: string }[] };
const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * The stored output of one command, fetched page by page. `version` changes
 * as more output is stored, so a running command's log follows along.
 */
export function LogViewer({ jobId, callId, version }: { jobId: string; callId: string; version?: number }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [text, setText] = useState(""), [next, setNext] = useState(0);
  const [page, setPage] = useState<LogPage | null>(null), [error, setError] = useState("");
  /** Only the latest view's responses apply; a slow older page never overwrites newer text. */
  const generation = useRef(0), nextRef = useRef(0), busy = useRef(false), again = useRef(false);
  const load = async (from: number, s = stream, append = true, gen = generation.current) => {
    try {
      const data = await request<LogPage>(`/api/jobs/${jobId}/calls/${callId}/logs?stream=${s}&from_seq=${from}`);
      if (gen !== generation.current) return;
      const bytes = data.items.map((i) => decode(i.data));
      const merged = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
      bytes.reduce((at, b) => (merged.set(b, at), at + b.length), 0);
      const chunk = new TextDecoder().decode(merged);
      setText((t) => (append ? t + chunk : chunk));
      nextRef.current = data.items.length ? data.items.at(-1)!.seq + 1 : from;
      setNext(nextRef.current);
      setPage(data); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "无法读取日志"); }
  };
  useEffect(() => { const gen = ++generation.current; nextRef.current = 0; setText(""); void load(0, stream, false, gen); }, [stream, jobId, callId]);
  // New output while streaming: append from where this view stopped, one request at a time.
  const follow = async () => {
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    try { do { again.current = false; await load(nextRef.current); } while (again.current); } finally { busy.current = false; }
  };
  useEffect(() => { if (version !== undefined && page) void follow(); }, [version]);
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
          {page.state === "streaming" ? " · 仍在接收" : ""}
        </p>
      )}
      {page && page.gaps?.length > 0 && (
        <ul className="log-gaps" aria-label="日志缺口">
          {page.gaps.map((g) => (
            <li key={g.from_seq}>
              缺口：第 {g.from_seq}{g.to_seq !== null && g.to_seq !== g.from_seq ? `–${g.to_seq}` : ""} 块，从第 {g.from_offset.toLocaleString()} 字节起
              {g.missing_bytes !== null ? `，缺 ${g.missing_bytes.toLocaleString()} 字节` : ""}。这部分输出主节点没有收到，下方内容在此处不连续。
            </li>
          ))}
        </ul>
      )}
      {more && <button type="button" className="secondary-button" onClick={() => void follow()}>加载更多</button>}
    </div>
  );
}
