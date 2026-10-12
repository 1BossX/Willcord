// What a command that has no result yet is doing, in words. "正在执行" alone
// cannot tell a command that is running from one whose machine went away, so
// this reads the stored timestamps and the machine's connection. Pure, so the
// rules are tested without a browser.

/** Without output for this long, a running command is called quiet. A hint: builds and `du` are quiet too. */
export const QUIET_AFTER_MS = 60_000;

export type Phase = "sending" | "running" | "quiet" | "worker_offline" | "cancelling" | "unknown";
export type Tone = "active" | "warning" | "muted" | "danger";

export type Liveness = {
  phase: Phase;
  label: string;
  /** One line under the command: how long it has run, how long since output, what is expected next. */
  detail: string | null;
  tone: Tone;
  /** Whether the dots pulse: only while the command is actually believed to be running. */
  pulsing: boolean;
  canCancel: boolean;
};

type CallIn = { status: string; dispatched_at?: number | null; cancel_sent_at?: number | null };
type LogIn = { last_output_at?: number | null } | undefined;
type WorkerIn = { online: number } | undefined;
type JobIn = { state: string };

/** "45秒", "2分13秒", "1小时05分". */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, "0")}秒`;
  return `${Math.floor(m / 60)}小时${String(m % 60).padStart(2, "0")}分`;
}

const CANCELLABLE_JOB = new Set(["running", "waiting_children"]);

export function callLiveness({ call, log, worker, job, now }: { call: CallIn; log: LogIn; worker: WorkerIn; job: JobIn; now: number }): Liveness {
  // Only a machine known to be offline is called offline; an unknown one is not.
  const offline = worker !== undefined && !worker.online;
  const canCancel = CANCELLABLE_JOB.has(job.state);
  const base = { pulsing: false, canCancel: false };

  if (call.status === "unknown")
    return { ...base, phase: "unknown", label: "执行情况未知", detail: "无法确认命令是否执行过，不会自动重跑，请在任务详情中核对。", tone: "danger" };

  if (job.state === "cancel_requested") {
    const detail = offline
      ? "机器已离线，重连后才能终止这个命令。"
      : call.cancel_sent_at
        ? `已发送终止信号 ${duration(now - call.cancel_sent_at)}，等待机器确认，通常 15 秒内。`
        : "正在发送终止信号。";
    return { ...base, phase: "cancelling", label: "正在停止", detail, tone: "warning", pulsing: !offline };
  }

  if (call.status === "committed")
    return { ...base, phase: "sending", label: "等待发送", detail: null, tone: "muted", canCancel };

  if (offline)
    return { ...base, phase: "worker_offline", label: "机器已离线", detail: "命令可能仍在机器上运行；重连后会自动对账，期间结果不会更新。", tone: "danger", canCancel };

  const started = call.dispatched_at ?? null;
  const lastOutput = log?.last_output_at ?? null;
  const since = lastOutput ?? started;
  const elapsed = started === null ? null : `已运行 ${duration(now - started)}`;
  const silent = since === null ? 0 : now - since;

  if (silent >= QUIET_AFTER_MS)
    return {
      ...base, phase: "quiet", label: "正在执行", tone: "warning", canCancel, pulsing: true,
      detail: `${elapsed ? `${elapsed}，` : ""}${lastOutput === null ? "至今没有输出" : `已 ${duration(silent)}没有新输出`}。可能仍在计算，也可能卡住。`,
    };

  return {
    ...base, phase: "running", label: "正在执行", tone: "active", canCancel, pulsing: true,
    detail: elapsed && `${elapsed}${lastOutput === null ? "，暂无输出" : `，${duration(silent)}前有输出`}`,
  };
}

/** The line under the conversation while a job is open. */
export function jobActivity(job: { state: string; worker_id?: string | null }, worker: WorkerIn): { text: string; tone: Tone } {
  if (job.state === "cancel_requested")
    return { text: worker && !worker.online ? "已请求取消，机器离线，重连后才能终止命令。" : "正在停止，等待命令确认结束。", tone: "warning" };
  if (job.state === "waiting_children") return { text: "委派的子任务仍在执行，结果会持续更新。", tone: "active" };
  if (job.worker_id && worker && !worker.online) return { text: "机器已离线，任务暂停等待；重连后会自动对账。", tone: "danger" };
  return { text: "任务正在执行，结果会持续更新。", tone: "active" };
}
