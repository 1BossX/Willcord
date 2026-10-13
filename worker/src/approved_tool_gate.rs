//! O2-KR2 worker gate for `execution_mode = approved`.
//!
//! Wire-up: `main.rs` `tool_call` must call these checks before the ledger accepts
//! a call. That file is owned by O2-KR1 PR #82 until merge; this module holds the
//! policy so KR2 does not touch `diagnosis.rs` or the KR1 read allowlist.

use crate::generated::ToolCall;
use super::{approved_action, approved_write};
use serde_json::Value;

/// Fields that must be included in the canonical request before hashing.
pub fn extend_canonical_request(call: &ToolCall, canonical: &mut Value) {
    if let Some(mode) = call.execution_mode.as_ref() {
        canonical["execution_mode"] = Value::String(mode.clone());
    }
    if let Some(binding) = call.approved_binding_hash.as_ref() {
        canonical["approved_binding_hash"] = Value::String(binding.clone());
    }
}

/// `true` when the call must be rejected as invalid before ledger accept.
pub fn reject_before_ledger(call: &ToolCall) -> bool {
    if approved_write::is_approved(call.execution_mode.as_deref()) {
        let expected = approved_action::binding_hash(&call.worker_id, &call.tool, &call.arguments);
        if call.approved_binding_hash.as_deref() != Some(expected.as_str()) {
            return true;
        }
    }
    if call.tool == "write" && !approved_write::write_allowed(call.execution_mode.as_deref()) {
        return true;
    }
    if call.tool == "bash" {
        let command = call.arguments["command"].as_str().unwrap_or("");
        if approved_write::is_approved(call.execution_mode.as_deref())
            && approved_write::bash_allowed(command).is_err()
        {
            return true;
        }
    }
    false
}

pub enum ApprovedBash {
    NotApproved,
    Allowed(Vec<String>),
    Denied,
}

pub fn approved_bash_argv(call: &ToolCall) -> ApprovedBash {
    if !approved_write::is_approved(call.execution_mode.as_deref()) {
        return ApprovedBash::NotApproved;
    }
    let command = call.arguments["command"].as_str().unwrap_or("");
    match approved_write::bash_argv(command) {
        Ok(argv) => ApprovedBash::Allowed(argv),
        Err(_) => ApprovedBash::Denied,
    }
}
