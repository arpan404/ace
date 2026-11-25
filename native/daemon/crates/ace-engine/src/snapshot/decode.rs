// SPDX-License-Identifier: Apache-2.0
//! Validate a stored header and each record (E5.3, `snapshot.ts:72`-`:142`). Validation never
//! strips: a record keeps every field it carried, which is what the decoders below do (unknown
//! fields of a newer build are the raw data the brief keeps).

use ace_core::ThreadState;
use ace_json::Value;
use serde::de::DeserializeOwned;

use super::version::require_snapshot_version;
use crate::EngineError;

/// `decodeSnapshot` (`snapshot.ts:146`): parse, check `engineSnapshot === 9`, then validate the
/// header shape without stripping.
pub fn decode_header(json: &str) -> Result<(ThreadState, Value), EngineError> {
    let value = ace_json::parse(json).map_err(|_| EngineError::InvalidState)?;
    require_snapshot_version(&value)?;
    validate_header(&value)?;
    let state: ThreadState = ace_json::from_value(&value).map_err(|_| EngineError::InvalidState)?;
    Ok((state, value))
}

/// One record, validated with the section's decoder (`parseRecord`, `records.ts:15`).
pub fn decode_record<T: DeserializeOwned>(value: &Value) -> Result<T, EngineError> {
    ace_json::from_value(value).map_err(|_| EngineError::InvalidRecord)
}

fn object<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| value.is_object())
}

fn array<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| value.is_array())
}

/// The `snapshot` object's required shape (`snapshot.ts:87`-`:137`). A header missing one is
/// `Invalid saved core state`.
fn validate_header(value: &Value) -> Result<(), EngineError> {
    let invalid = || EngineError::InvalidState;
    if !value.is_object() {
        return Err(invalid());
    }
    if value.get("threadId").and_then(Value::as_str).is_none() {
        return Err(invalid());
    }
    let config = object(value, "config").ok_or_else(invalid)?;
    if config.get("provider").and_then(Value::as_str).is_none()
        || config.get("silenceMs").and_then(Value::as_f64).is_none()
    {
        return Err(invalid());
    }
    for key in [
        "agents",
        "items",
        "runs",
        "interactions",
        "tasks",
        "interactionHistory",
        "taskHistory",
        "itemLinks",
    ] {
        object(value, key).ok_or_else(invalid)?;
    }
    let indexes = object(value, "indexes").ok_or_else(invalid)?;
    for key in [
        "liveTools",
        "pendingInteractions",
        "runningTasks",
        "agentKeysById",
        "childrenByParent",
        "pendingSpawnLinks",
        "pendingItemLinks",
    ] {
        object(indexes, key).ok_or_else(invalid)?;
    }
    if value.get("outcomeOrder").and_then(Value::as_f64).is_none() {
        return Err(invalid());
    }
    array(value, "pendingNotices").ok_or_else(invalid)?;
    if value.get("queueCount").and_then(Value::as_f64).is_none() {
        return Err(invalid());
    }
    let sources = object(value, "queueSources").ok_or_else(invalid)?;
    for key in ["engine", "provider"] {
        if sources.get(key).and_then(Value::as_f64).is_none() {
            return Err(invalid());
        }
    }
    if value.get("hasRun").and_then(Value::as_bool).is_none() || object(value, "status").is_none() {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = r#"{"engineSnapshot":9,"threadId":"t","config":{"provider":"claude","silenceMs":1000},"agents":{},"runs":{},"items":{},"interactions":{},"tasks":{},"interactionHistory":{},"taskHistory":{},"indexes":{"liveTools":{},"pendingInteractions":{},"runningTasks":{},"agentKeysById":{},"childrenByParent":{},"pendingSpawnLinks":{},"pendingItemLinks":{}},"outcomeOrder":0,"pendingNotices":[],"itemLinks":{},"queueCount":0,"queueSources":{"engine":0,"provider":0},"hasRun":false,"status":{"state":"new"}}"#;

    #[test]
    fn a_header_saved_before_open_text_loads_with_that_index_empty() {
        // `open-text-restart.process`: openText is absent from an older header.
        let (state, value) = decode_header(HEADER).unwrap();
        assert_eq!(state.indexes.open_text.len(), 0);
        assert!(value.get("indexes").is_some());
    }

    #[test]
    fn a_header_missing_a_section_is_refused() {
        let broken = HEADER.replace(r#""items":{},"#, "");
        assert!(matches!(
            decode_header(&broken),
            Err(EngineError::InvalidState)
        ));
    }

    #[test]
    fn a_record_is_validated_without_stripping_its_future_fields() {
        let value = ace_json::parse(
            r#"{"id":"i","threadId":"t","agentId":"a","createdAt":1,"complete":true,"type":"notice","level":"info","text":"hi","futureField":true}"#,
        )
        .unwrap();
        let item: ace_core::items::Item = decode_record(&value).unwrap();
        assert_eq!(
            value.get("futureField"),
            Some(&Value::from(true)),
            "the stored value keeps the field"
        );
        assert!(
            !ace_json::ser::to_string(&item)
                .unwrap()
                .contains("futureField")
        );
    }
}
