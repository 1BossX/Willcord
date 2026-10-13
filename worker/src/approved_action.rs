use serde_json::Value;
use sha2::Digest;

/// Must match the main node's `actionBinding` (canonical JCS over worker_id, tool, arguments).
pub fn binding_hash(worker_id: &str, tool: &str, arguments: &Value) -> String {
    let payload = serde_json::json!({
        "worker_id": worker_id,
        "tool": tool,
        "arguments": arguments,
    });
    format!(
        "{:x}",
        sha2::Sha256::digest(serde_jcs::to_vec(&payload).expect("binding jcs"))
    )
}
