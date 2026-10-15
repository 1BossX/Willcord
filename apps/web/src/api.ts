export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const errors: Record<string, string> = {
  unauthorized: "登录状态已过期，请重新登录。",
  csrf: "会话验证失败，请刷新后重试。",
  repo_mismatch: "仓库与所选工作目录不匹配。",
  worker_or_workspace_not_found: "这台机器或工作目录已不可用。",
  idempotency_conflict: "这条消息已经提交，请刷新查看原任务。",
  invalid_message: "请输入任务内容，最多 32,000 字符。",
  workers_not_reconciled: "还有机器没有完成账本核对，暂不能恢复调度。",
  disk_low: "数据目录空间不足，空间恢复后会自动继续调度。",
  note_required: "请填写说明。",
  unknown_provider: "不支持这个 provider。",
  unknown_model: "这个 provider 下没有该模型，请从候选列表选择。",
  invalid_model: "请填写 provider 和模型名称。",
  invalid_api_key: "API key 格式无效：不能为空或包含换行。",
  api_key_required: "切换 provider 后必须输入新的 API key。",
};

/** Known error codes get their sentence; rate limiting gets a retry hint; anything else the generic line. */
export function apiErrorMessage(status: number, code: unknown): string {
  if (typeof code === "string" && Object.hasOwn(errors, code)) return errors[code];
  if (status === 429) return "操作太频繁，请稍后再试。";
  return "暂时无法完成请求，请稍后重试。";
}

export async function request<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (
    !["GET", "HEAD"].includes(init.method ?? "GET") &&
    url !== "/auth/login"
  ) {
    const auth = await request<{ authenticated: boolean; csrf?: string }>(
      "/auth/session",
      { signal: init.signal },
    );
    if (!auth.authenticated || !auth.csrf)
      throw new ApiError(401, errors.unauthorized);
    headers.set("x-csrf-token", auth.csrf);
  }
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(response.status, apiErrorMessage(response.status, data?.error));
  if (data === null)
    throw new ApiError(503, "主节点暂时未返回有效数据，请稍后重试。");
  return data as T;
}
