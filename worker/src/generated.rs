// Generated from schema.json. Do not edit.
pub const MAX_FRAME_BYTES: usize = 65536;
use serde::{Deserialize, Serialize};
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
