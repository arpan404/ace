// SPDX-License-Identifier: Apache-2.0
//! Shared command routing key (`keys.ts`).

/// Provider IDs stay opaque and are never filesystem paths.
pub fn native_agent_key(thread_id: &str, session_id: &ace_json::JsString) -> String {
    let encoded = ace_json::ser::to_string(session_id).unwrap_or_else(|_| "\"\"".to_owned());
    format!("{thread_id}:acp:agent:{encoded}")
}
