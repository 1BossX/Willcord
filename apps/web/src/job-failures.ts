import { endReasonLabel } from "./end-reasons.ts";

const toolErrorRules: Array<[RegExp, string]> = [
  [/rate limit|too many requests/i, "被限流，请稍后重试"],
  [/permission denied|not permitted|operation not permitted/i, "权限不足"],
  [/command not found/i, "命令未找到"],
  [/no such file|not found/i, "路径不存在"],
  [/timed? ?out|timeout/i, "执行超时"],
  [/disk full|no space left/i, "磁盘空间不足"],
];

export function localizeToolError(raw: string): string {
  const detail = raw.trim();
  if (!detail) return "工具执行失败";
  const hit = toolErrorRules.find(([pattern]) => pattern.test(detail));
  return hit ? hit[1] : detail;
}

type BudgetJob = {
  end_reason?: string | null;
  max_tool_calls?: number | null;
  tool_calls_used?: number | null;
  model_turns?: number | null;
  max_model_turns?: number | null;
};

/** One sentence that matches the inspector's budget rows when a job failed on a limit. */
export function jobFailureSummary(job: BudgetJob): string | null {
  if (!job.end_reason) return null;
  const reason = endReasonLabel(job.end_reason);
  if (job.end_reason === "budget_model_turns") {
    const used = job.model_turns ?? 0;
    const max = job.max_model_turns ?? 20;
    const tools = job.tool_calls_used ?? 0;
    const toolMax = job.max_tool_calls;
    const toolNote =
      toolMax != null
        ? `本任务已用 ${tools}/${toolMax} 次工具调用，与模型轮次是不同上限。`
        : "";
    return `任务因达到模型轮次上限而结束（${used}/${max} 轮）。${toolNote}`.trim();
  }
  if (job.end_reason === "budget_tool_calls" && job.max_tool_calls != null) {
    return `任务因工具调用次数达到上限而结束（${job.tool_calls_used ?? 0}/${job.max_tool_calls}）。`;
  }
  if (job.end_reason === "budget_tokens") {
    return `任务因 token 预算达到上限而结束。`;
  }
  if (job.end_reason.startsWith("budget_") || job.end_reason === "deadline_exceeded") {
    return `任务结束：${reason}。`;
  }
  return `任务结束：${reason}。`;
}
