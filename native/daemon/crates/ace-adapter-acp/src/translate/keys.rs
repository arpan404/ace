// SPDX-License-Identifier: Apache-2.0
//! Shared command routing key (`keys.ts`).

/// Provider IDs stay opaque and are never filesystem paths.
pub fn native_agent_key(thread_id: &str, session_id: &str) -> String {
    let encoded = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".to_owned());
    format!("{thread_id}:acp:agent:{encoded}")
}

#[cfg(test)]
mod tests {
    use super::native_agent_key;

    #[test]
    fn routing_key_namespaces_by_thread_and_session() {
        assert_eq!(native_agent_key("t", "s"), "t:acp:agent:\"s\"".to_owned());
    }
}
