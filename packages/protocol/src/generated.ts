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
    }
  | {
      protocol_version: 1;
      worker_id: string;
      connection_epoch: number;
      type: "ack";
      ack_type: "resume" | "reconcile";
    };

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
