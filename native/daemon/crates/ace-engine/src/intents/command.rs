// SPDX-License-Identifier: Apache-2.0
//! `Command.parse(JSON.parse(payload))` (`intents.ts:224`, `:245`, `:385`; `queue-store.ts:211`,
//! `:332`) for the commands the queue reads and claims. Zod's defaults and refusals are kept for
//! the fields those reads observe; unknown keys are dropped, as the schema strips them.

use ace_json::{Map, Value};

use super::header::TRIGGERS;
use crate::EngineError;

fn invalid() -> EngineError {
    EngineError::Records("Invalid queue entry".into())
}

fn object(value: &Value) -> Result<&Map, EngineError> {
    value.as_object().ok_or_else(invalid)
}

fn required_text(map: &Map, key: &str) -> Result<String, EngineError> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(invalid)
}

/// `MessageContext.parse`: `mentions` and `attachments` default to `[]`.
fn context(value: &Value) -> Result<Value, EngineError> {
    let map = object(value)?;
    let mut out = Map::new();
    if let Some(draft) = map.get("draftId") {
        out.insert("draftId", draft.clone());
    }
    if let Some(items) = map.get("items") {
        out.insert("items", items.clone());
    }
    match map.get("mentions") {
        None => out.insert("mentions", Value::Array(Vec::new().into())),
        Some(mentions @ Value::Array(_)) => out.insert("mentions", mentions.clone()),
        Some(_) => return Err(invalid()),
    };
    match map.get("attachments") {
        None => out.insert("attachments", Value::Array(Vec::new().into())),
        Some(attachments @ Value::Array(_)) => out.insert("attachments", attachments.clone()),
        Some(_) => return Err(invalid()),
    };
    Ok(Value::Object(out))
}

/// A `ContentPart` list: at least one part, each an object with a `type`.
fn input(value: Option<&Value>) -> Result<Value, EngineError> {
    let Some(Value::Array(parts)) = value else {
        return Err(invalid());
    };
    if parts.is_empty() || parts.len() > 64 {
        return Err(invalid());
    }
    for part in parts.iter() {
        let map = object(part)?;
        required_text(map, "type")?;
    }
    Ok(Value::Array(parts.clone()))
}

/// One stored command, parsed and normalized. A send or create must carry a non-empty `input`
/// and a non-empty `threadId`, as `Command.parse` requires.
pub fn parse(text: &str) -> Result<Value, EngineError> {
    let value = ace_json::parse(text).map_err(|_| invalid())?;
    let command = object(&value)?;
    let id = required_text(command, "id")?;
    let device_id = required_text(command, "deviceId")?;
    let payload = object(command.get("payload").ok_or_else(invalid)?)?;
    let kind = required_text(payload, "type")?;
    let mut out = Map::new();
    match kind.as_str() {
        "thread.send" | "thread.create" => {
            let thread_id = required_text(payload, "threadId")?;
            let mut body = Map::new();
            body.insert("type", Value::from(kind.as_str()));
            for key in ["model", "options", "trigger", "origin"] {
                if let Some(value) = payload.get(key) {
                    body.insert(key, value.clone());
                }
            }
            if let Some(trigger) = payload.get("trigger").and_then(Value::as_str)
                && !TRIGGERS.contains(&trigger)
            {
                return Err(invalid());
            }
            if kind == "thread.create" {
                for key in ["workspaceId", "provider"] {
                    required_text(payload, key)?;
                }
                for key in [
                    "workspaceId",
                    "provider",
                    "access",
                    "title",
                    "options",
                    "model",
                ] {
                    if let Some(value) = payload.get(key) {
                        body.insert(key, value.clone());
                    }
                }
            }
            body.insert("threadId", Value::from(thread_id));
            body.insert("input", input(payload.get("input"))?);
            if let Some(raw) = payload.get("context") {
                body.insert("context", context(raw)?);
            }
            if kind == "thread.send" {
                match payload.get("delivery").and_then(Value::as_str) {
                    None => {}
                    Some(delivery @ ("queue" | "steer")) => {
                        body.insert("delivery", Value::from(delivery));
                    }
                    Some(_) => return Err(invalid()),
                }
                if let Some(run_id) = payload.get("runId") {
                    match run_id {
                        Value::Null | Value::String(_) => {
                            body.insert("runId", run_id.clone());
                        }
                        _ => return Err(invalid()),
                    }
                }
            }
            out.insert("payload", Value::Object(body));
        }
        "thread.resume" | "queue.resume" | "thread.limit" => {
            required_text(payload, "threadId")?;
            match payload.get("expectedRevision").and_then(Value::as_i64) {
                Some(revision) if revision >= 0 => {}
                _ => return Err(invalid()),
            }
            out.insert("payload", Value::Object(payload.clone()));
        }
        _ => {
            // A kind this reader never shows or claims still keeps its shape, so a caller that
            // later owns it can refuse it with its own words.
            out.insert("payload", Value::Object(payload.clone()));
        }
    }
    let mut command = Map::new();
    command.insert("id", Value::from(id));
    command.insert("deviceId", Value::from(device_id));
    for (key, value) in out {
        command.insert(key, value);
    }
    Ok(Value::Object(command))
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
