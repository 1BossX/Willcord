/** Worker-protocol request fields for approved-action tool calls (shared with execution dispatch). */
export function workerToolRequestFields(row: {
  worker_id: string;
  job_id: string;
  call_id: string;
  call_seq: number;
  workspace_id: string;
  workspace_version: number;
  tool: string;
  arguments: Record<string, unknown>;
  execution_mode: "diagnosis" | "approved" | null;
  approved_binding_hash?: string | null;
}) {
  const request: Record<string, unknown> = {
    worker_id: row.worker_id,
    job_id: row.job_id,
    call_id: row.call_id,
    call_seq: row.call_seq,
    workspace_id: row.workspace_id,
    config_version: row.workspace_version,
    tool: row.tool,
    arguments: row.arguments,
  };
  if (row.execution_mode) request.execution_mode = row.execution_mode;
  if (row.approved_binding_hash) request.approved_binding_hash = row.approved_binding_hash;
  return request;
}
