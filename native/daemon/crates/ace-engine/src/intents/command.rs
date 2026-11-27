// SPDX-License-Identifier: Apache-2.0
//! `Command.parse(JSON.parse(payload))` for queue reads and intent claims.

mod checks;
mod refinements;
mod schema;

use std::sync::LazyLock;

use ace_json::Value;

use crate::EngineError;
use schema::Schema;

static COMMAND: LazyLock<Result<Schema, serde_json::Error>> =
    LazyLock::new(|| serde_json::from_str(include_str!("command/schema.json.inc")));

/// Parse and normalize a stored command with the protocol schema.
pub fn parse(text: &str) -> Result<Value, EngineError> {
    ace_json::parse(text)
        .ok()
        .and_then(|value| normalize(&value).ok())
        .ok_or_else(|| EngineError::Records("Invalid queue entry".into()))
}

/// `Command.parse(command)` on a value already in memory: defaults filled, unknown keys
/// stripped and the keys in schema order (`docs/engine/e5-4-brief.md`, "Commands as stored").
pub fn normalize(command: &Value) -> Result<Value, EngineError> {
    let schema = COMMAND
        .as_ref()
        .map_err(|error| EngineError::Records(format!("Invalid stored command schema: {error}")))?;
    schema
        .parse(command)
        .ok_or_else(|| EngineError::Records("Invalid queue entry".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(extra: &str) -> String {
        format!(
            r#"{{"id":"c","deviceId":"d","payload":{{"type":"thread.send","threadId":"t","input":[{{"type":"text","text":"hi"}}]{extra}}}}}"#
        )
    }

    #[test]
    fn an_empty_context_gets_the_schemas_defaults() {
        let parsed = parse(&send(r#","context":{}"#)).unwrap();
        let context = parsed
            .get("payload")
            .and_then(|payload| payload.get("context"))
            .unwrap();
        assert_eq!(
            context.get("mentions"),
            Some(&Value::Array(Vec::new().into()))
        );
        assert_eq!(
            context.get("attachments"),
            Some(&Value::Array(Vec::new().into()))
        );
    }

    #[test]
    fn a_normalized_send_strips_unknown_keys_and_puts_context_before_delivery() {
        // Zod's parse keeps schema order; `delivery` arrives before `context` here.
        let parsed = parse(&send(r#","delivery":"queue","context":{},"unknown":1"#)).unwrap();
        assert_eq!(
            ace_json::to_string(&parsed),
            r#"{"id":"c","deviceId":"d","payload":{"type":"thread.send","threadId":"t","input":[{"type":"text","text":"hi"}],"context":{"mentions":[],"attachments":[]},"delivery":"queue"}}"#
        );
        // A value already in memory normalizes the same way.
        let in_memory = ace_json::parse(&send(r#","unknown":1"#)).unwrap();
        assert_eq!(
            ace_json::to_string(&normalize(&in_memory).unwrap()),
            r#"{"id":"c","deviceId":"d","payload":{"type":"thread.send","threadId":"t","input":[{"type":"text","text":"hi"}]}}"#
        );
    }

    #[test]
    fn a_send_without_an_input_is_refused() {
        let missing =
            r#"{"id":"c","deviceId":"d","payload":{"type":"thread.send","threadId":"t"}}"#;
        assert!(parse(missing).is_err());
        let empty = r#"{"id":"c","deviceId":"d","payload":{"type":"thread.send","threadId":"t","input":[]}}"#;
        assert!(parse(empty).is_err());
        // A device id is required too.
        let no_device = r#"{"id":"c","payload":{"type":"thread.send","threadId":"t","input":[{"type":"text","text":"hi"}]}}"#;
        assert!(parse(no_device).is_err());
    }
}
