// Generated from schema.json. Do not edit.
pub const MAX_FRAME_BYTES: usize = 65536;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub workspace_id: String,
    pub config_version: u64,
    pub path: String,
    pub repo_id: String,
    pub is_default: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallReport {
    pub job_id: String,
    pub call_id: String,
    pub call_seq: u64,
    pub request_hash: String,
    pub status: String,
    pub boot_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub boot_id: String,
    pub ledger_id: String,
    pub workspaces: Vec<Workspace>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterAck {
    pub protocol_version: u64,
    pub worker_id: String,
    pub connection_epoch: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub reconciliation_required: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    pub protocol_version: u64,
    pub worker_id: String,
    pub connection_epoch: u64,
    #[serde(rename = "type")]
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resume {
    pub protocol_version: u64,
    pub worker_id: String,
    pub connection_epoch: u64,
    #[serde(rename = "type")]
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reconcile {
    pub protocol_version: u64,
    pub worker_id: String,
    pub connection_epoch: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub ledger_id: String,
    pub ready: bool,
    pub calls: Vec<CallReport>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ack {
    pub protocol_version: u64,
    pub worker_id: String,
    pub connection_epoch: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub ack_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub call_seq: u64,
    pub workspace_id: String,
    pub config_version: u64,
    pub request_hash: String,
    pub tool: String,
    pub arguments: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResult {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub ok: bool,
    pub result: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolData {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub chunk_index: u64,
    pub data: String,
    #[serde(rename = "final")]
    pub is_final: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolAck {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub ack_through: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolAccepted {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub boot_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolRejected {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerReady {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub ready: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelCall {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub call_seq: u64,
    pub request_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelAck {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub state: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolLog {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub stream: String,
    pub seq: u64,
    pub offset: u64,
    pub data: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogFetch {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub stream: String,
    pub from_seq: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogStatus {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub stream: String,
    pub chunks: u64,
    pub state: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogAck {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub stream: String,
    pub chunks: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveCall {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub call_seq: u64,
    pub request_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveAck {
    pub protocol_version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub worker_id: String,
    pub connection_epoch: u64,
    pub job_id: String,
    pub call_id: String,
    pub request_hash: String,
    pub state: String,
}
