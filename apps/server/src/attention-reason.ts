/**
 * Why a retry attention action exists (#109): the job it retried, the calls it
 * ran, how it ended, and what the operator should do about it. Recorded when
 * the action is created; older rows are backfilled from the same job data at
 * read time, and rows nothing explains are marked as legacy.
 */
import type Database from "better-sqlite3";

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
  /** One human-readable paragraph: what happened, why this item exists. */
  summary: string;
  /** What the operator is expected to do next. */
  suggested: string;
};

const JOB_FIELDS = "job_id,state,end_reason,cancel_reason,session_id,worker_id,input_text,created_at";

const endReasons: Record<string, string> = {
  completed: "正常完成",
  cancelled_by_user: "用户取消",
  abandoned: "已放弃",
  deadline_exceeded: "超出运行时限",
  budget_tool_calls: "超出工具调用次数",
  budget_tokens: "超出 token 预算",
  budget_model_turns: "超出模型轮次上限",
  worker_disk_full: "机器磁盘空间不足",
  worker_wait_expired: "等待机器上线超时",
  model_auth_failed: "模型服务拒绝了 API key",
  model_error: "模型服务调用失败",
  model_not_configured: "模型尚未配置完整",
  verification_failed: "核对未通过",
  dependency_failed: "依赖的任务未成功",
};

/** 状态与结束原因的简短中文说明；未知值原样展示。 */
export function endReasonText(reason?: string | null) {
  return reason ? (endReasons[reason] ?? reason) : "";
}

const shortId = (id: string | null | undefined) => id ? id.slice(0, 8) : "未知";

const stateText: Record<string, string> = {
  succeeded: "成功结束",
  failed: "失败结束",
  cancelled: "已取消",
};

const sourceCalls = (db: Database.Database, jobId: string): RetryCallInfo[] =>
  db.prepare("SELECT call_id,tool_name,status FROM runtime_calls WHERE job_id=? ORDER BY call_seq LIMIT 10").all(jobId) as RetryCallInfo[];

const suggested = "先核对原任务已产生的副作用（工作目录的文件、外部系统），再决定让新任务继续；不打算重试时，把这条记录标记已处理或忽略。";

/** The reason of a retry created with this fix: structured fields plus text. */
export function buildRetryReason(db: Database.Database, sourceJob: Record<string, any>, newJobId: string): RetryReason {
  const title = (db.prepare("SELECT title FROM sessions WHERE session_id=?").get(sourceJob.session_id) as { title: string | null } | undefined)?.title ?? null;
  const calls = sourceCalls(db, sourceJob.job_id);
  const ended = stateText[sourceJob.state] ?? sourceJob.state;
  const reason = endReasonText(sourceJob.end_reason ?? sourceJob.cancel_reason);
  const callPart = calls.length ? `，涉及调用 ${calls.map((c) => `${c.tool_name}(${shortId(c.call_id)})`).join("、")}` : "";
  return {
    origin: "recorded",
    source_job_id: sourceJob.job_id,
    source_job_state: sourceJob.state,
    source_end_reason: sourceJob.end_reason,
    source_cancel_reason: sourceJob.cancel_reason,
    source_session_title: title,
    source_calls: calls,
    new_job_id: newJobId,
    summary: `任务「${title ?? "（无标题）"}」（job ${shortId(sourceJob.job_id)}）已${ended}${reason ? `（原因：${reason}）` : ""}${callPart}。操作员发起了“新建重试”，生成了新任务 ${shortId(newJobId)}。`,
    suggested,
  };
}

/**
 * Read a retry action's reason. Rows created before #109 carried only
 * `new_job_id`: their explanation is rebuilt from the jobs they still point
 * at, or — when neither the source nor the new job can be found — the item is
 * presented as an unexplainable legacy record the operator can dismiss.
 */
export function retryReasonForAction(db: Database.Database, action: { job_id: string | null; evidence: any }): RetryReason {
  const recorded = action.evidence?.reason;
  if (recorded && typeof recorded === "object" && typeof recorded.summary === "string")
    return { ...recorded, origin: "recorded" } as RetryReason;
  const sourceJob = action.job_id
    ? db.prepare(`SELECT ${JOB_FIELDS} FROM jobs WHERE job_id=?`).get(action.job_id) as Record<string, any> | undefined
    : undefined;
  if (sourceJob) {
    const reason = buildRetryReason(db, sourceJob, action.evidence?.new_job_id ?? null);
    reason.origin = "backfilled";
    reason.summary = `（旧版本记录，由任务数据补全）${reason.summary}`;
    return reason;
  }
  const newJob = action.evidence?.new_job_id
    ? db.prepare("SELECT job_id,created_at FROM jobs WHERE job_id=?").get(action.evidence.new_job_id) as { job_id: string } | undefined
    : undefined;
  return {
    origin: "legacy",
    source_job_id: action.job_id,
    source_job_state: null,
    source_end_reason: null,
    source_cancel_reason: null,
    source_session_title: null,
    source_calls: [],
    new_job_id: action.evidence?.new_job_id ?? null,
    summary: newJob
      ? `历史遗留项：这条重试记录生成于旧版本，缺少原因说明，原任务（job ${shortId(action.job_id)}）已从记录中清除，只剩它创建的新任务 ${shortId(newJob.job_id)}。请核对新任务的副作用后处理这条记录。`
      : `历史遗留项：这条重试记录生成于旧版本，缺少原因说明，它关联的原任务与新任务都已不在记录中，无法还原当时的情况。确认不再需要后可忽略或关闭。`,
    suggested: newJob ? suggested : "确认不再需要后，忽略或关闭这条记录。",
  };
}
