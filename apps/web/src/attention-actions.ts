/**
 * Turning a retry attention action into what the console shows (#109): the
 * readable reason, its structured details, and whether it is an old record
 * that only the jobs table can still explain.
 */
export type RetryCallInfo = { call_id: string; tool_name: string; status: string };

export type RetryReason = {
  origin: "recorded" | "backfilled" | "legacy";
  source_job_id: string | null;
  source_job_state: string | null;
  source_end_reason: string | null;
  source_cancel_reason: string | null;
  source_session_title: string | null;
  source_calls: RetryCallInfo[];
  new_job_id: string | null;
  summary: string;
  suggested: string;
};

export type AttentionAction = {
  action_id: string;
  action: string;
  job_id: string | null;
  worker_id: string;
  created_at: number;
  evidence: unknown;
  reason?: RetryReason;
};

export type AttentionActionView = {
  reason: RetryReason | null;
  /** True when this is an old row whose reason was rebuilt at read time. */
  backfilled: boolean;
  /** True when nothing can explain this record anymore. */
  legacy: boolean;
  /** The line shown under the item; null when the reason cannot be read. */
  note: string | null;
};

const originLabels: Record<RetryReason["origin"], string> = {
  recorded: "创建时记录",
  backfilled: "旧版本记录，已按任务数据补全",
  legacy: "历史遗留项",
};

/** Any non-active runtime call status an operator would care about. */
const callStatusLabels: Record<string, string> = {
  unknown: "执行情况未知",
  resolved: "已核对",
  not_executed: "未执行",
  completed: "已执行",
  committed: "已提交",
};

const callStatusText = (status: string) => callStatusLabels[status] ?? status;

/** How the console summarizes one retry attention action. */
export function attentionActionView(action: AttentionAction): AttentionActionView {
  if (action.action !== "retry") return { reason: null, backfilled: false, legacy: false, note: null };
  const reason = action.reason ?? null;
  if (reason)
    return {
      reason,
      backfilled: reason.origin === "backfilled",
      legacy: reason.origin === "legacy",
      note: reason.summary,
    };
  // An action without a readable reason at all (neither recorded nor rebuilt).
  return {
    reason: null,
    backfilled: false,
    legacy: true,
    note: "历史遗留项：这条重试记录没有原因说明，无法还原当时的情况。确认不再需要后可忽略或关闭。",
  };
}

export const attentionActionOriginLabel = (view: AttentionActionView) =>
  view.reason ? originLabels[view.reason.origin] : originLabels.legacy;

/** The source call list as readable lines, skipping ones nothing to say. */
export function attentionActionCallLines(view: AttentionActionView): string[] {
  if (!view.reason) return [];
  return view.reason.source_calls.map(
    (c) => `${c.tool_name}（${c.call_id.slice(0, 8)}）· ${callStatusText(c.status)}`,
  );
}
