/* Generated from schema.json. Do not edit. */

export type WorkerFrame =
  | WorkerFrame1
  | {
      protocol_version: 1;
      worker_id: string;
      connection_epoch: number;
      type: "register_ack";
      reconciliation_required: true;
    }
  | {
      protocol_version: 1;
      worker_id: string;
      connection_epoch: number;
      type: "heartbeat";
    }
  | {
      protocol_version: 1;
      worker_id: string;
      connection_epoch: number;
      type: "resume";
    }
  | {
      protocol_version: 1;
      worker_id: string;
      connection_epoch: number;
      type: "reconcile";
      ledger_id: string;
      ready: boolean;
      /**
       * Every ledger entry the main node has not acknowledged. call_seq 0 marks a legacy entry whose sequence cannot be proven.
       *
       * @maxItems 128
       */
      calls: CallReport[];
    }
  | {
      protocol_version: 1;
      worker_id: string;
      connection_epoch: number;
      type: "ack";
      ack_type: "resume" | "reconcile";
    }
  | ToolCall
  | ToolResult
  | ToolData
  | ToolAck
  | ToolAccepted
  | ToolRejected
  | WorkerReady
  | CancelCall
  | CancelAck
  | ToolLog
  | LogFetch
  | LogStatus
  | LogAck
  | ResolveCall
  | ResolveAck;

export interface WorkerFrame1 {
  protocol_version: 1;
  type: "register";
  worker_id: string;
  boot_id: string;
  ledger_id: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  workspaces: [
    {
      workspace_id: string;
      config_version: number;
      path: string;
      repo_id: string;
      is_default: boolean;
    },
    ...{
      workspace_id: string;
      config_version: number;
      path: string;
      repo_id: string;
      is_default: boolean;
    }[]
  ];
}
export interface CallReport {
  job_id: string;
  call_id: string;
  call_seq: number;
  request_hash: string;
  status: "accepted" | "running" | "completed" | "unknown";
  boot_id: string;
}
export interface ToolCall {
  protocol_version: 1;
  type: "tool_call";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  call_seq: number;
  workspace_id: string;
  config_version: number;
  request_hash: string;
  tool: "read" | "write" | "bash";
  arguments: {
    [k: string]: unknown;
  };
  /**
   * When diagnosis, the worker refuses writes and bash outside the diagnosis allowlist.
   */
  execution_mode?: "diagnosis";
}
export interface ToolResult {
  protocol_version: 1;
  type: "tool_result";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  ok: boolean;
  result: {
    [k: string]: unknown;
  };
}
export interface ToolData {
  protocol_version: 1;
  type: "tool_data";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  chunk_index: number;
  data: string;
  final: boolean;
}
export interface ToolAck {
  protocol_version: 1;
  type: "tool_ack";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  /**
   * Highest call_seq of this job whose result the main node has committed; the worker refuses older unseen calls.
   */
  ack_through: number;
}
export interface ToolAccepted {
  protocol_version: 1;
  type: "tool_accepted";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  boot_id: string;
}
export interface ToolRejected {
  protocol_version: 1;
  type: "tool_rejected";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  reason: "conflict" | "unknown" | "retired" | "busy" | "disk_full" | "invalid" | "cancelled";
}
export interface WorkerReady {
  protocol_version: 1;
  type: "worker_ready";
  worker_id: string;
  connection_epoch: number;
  ready: boolean;
}
/**
 * Idempotent stop request. A call the ledger never accepted is fenced so it can never start.
 */
export interface CancelCall {
  protocol_version: 1;
  type: "cancel_call";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  call_seq: number;
  request_hash: string;
}
/**
 * Receipt only: termination is proven by the later tool_result. fenced proves the ledger never accepted the call.
 */
export interface CancelAck {
  protocol_version: 1;
  type: "cancel_ack";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  state: "running" | "completed" | "fenced" | "unknown" | "conflict";
}
/**
 * One stored output chunk, base64 of at most 16 KiB. Chunks are numbered from 0 per stream.
 */
export interface ToolLog {
  protocol_version: 1;
  type: "tool_log";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  stream: "stdout" | "stderr";
  seq: number;
  offset: number;
  data: string;
}
export interface LogFetch {
  protocol_version: 1;
  type: "log_fetch";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  stream: "stdout" | "stderr";
  from_seq: number;
}
/**
 * Ends a log_fetch reply; chunks is the number of chunks stored for the stream.
 */
export interface LogStatus {
  protocol_version: 1;
  type: "log_status";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  stream: "stdout" | "stderr";
  chunks: number;
  state: "complete" | "more" | "running" | "expired";
}
/**
 * The main node holds every chunk it keeps of the stream. Independent of tool_ack.
 */
export interface LogAck {
  protocol_version: 1;
  type: "log_ack";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  stream: "stdout" | "stderr";
  chunks: number;
}
/**
 * An operator settled an unknown call; the worker keeps a tombstone so it never runs.
 */
export interface ResolveCall {
  protocol_version: 1;
  type: "resolve_call";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  call_seq: number;
  request_hash: string;
}
export interface ResolveAck {
  protocol_version: 1;
  type: "resolve_ack";
  worker_id: string;
  connection_epoch: number;
  job_id: string;
  call_id: string;
  request_hash: string;
  state: "resolved" | "not_unknown";
}
