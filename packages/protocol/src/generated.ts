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
  | WorkerReady;

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
  reason: "conflict" | "unknown" | "retired" | "busy";
}
export interface WorkerReady {
  protocol_version: 1;
  type: "worker_ready";
  worker_id: string;
  connection_epoch: number;
  ready: boolean;
}
