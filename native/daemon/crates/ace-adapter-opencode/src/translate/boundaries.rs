// SPDX-License-Identifier: Apache-2.0
//! The translator's native envelope checks
//! (`packages/adapter-opencode/src/boundaries.ts`). A known message
//! deserializes into these views; an unknown one stays raw. Bounds match the
//! TypeScript schemas, so oversized or misshapen events fail the same way.

use crate::translate::data::{fields, get};
use ace_json::{Map, Value};
use thiserror::Error;

/// What a native envelope check can fail with. The translator maps every
/// failure to its disconnected fact, as the TypeScript `catch` does.
#[derive(Debug, Error)]
pub enum BoundaryError {
    /// The event is not the shape its type promises.
    #[error("event failed its envelope check: {0}")]
    Event(&'static str),
}

/// A validated OpenCode SSE envelope.
pub struct NativeEvent<'a> {
    pub id: &'a str,
    pub typ: &'a str,
    pub data: &'a Map,
    pub location: Option<&'a Map>,
    pub durable: Option<Durable<'a>>,
    /// The envelope's own creation time, when the provider sent one.
    pub created: Option<f64>,
}

/// A validated durable cursor for exactly-once delivery.
pub struct Durable<'a> {
    pub aggregate_id: &'a str,
    pub seq: f64,
}

fn bounded(text: &ace_json::JsString, max: usize) -> bool {
    text.len_code_points() <= max
}

/// Validate an SSE envelope the way `NativeEvent.parse` does: known fields
/// checked, unknown fields kept by the caller.
pub fn parse_native_event(value: &Value) -> Result<NativeEvent<'_>, BoundaryError> {
    let envelope = fields(value);
    if !matches!(value, Value::Object(_)) {
        return Err(BoundaryError::Event("envelope"));
    }
    let id = match envelope.get("id") {
        Some(Value::String(id)) if bounded(id, 512) => id.as_str(),
        _ => return Err(BoundaryError::Event("id")),
    };
    let typ = match envelope.get("type") {
        Some(Value::String(typ)) if bounded(typ, 256) => typ.as_str(),
        _ => return Err(BoundaryError::Event("type")),
    };
    let data = match envelope.get("data") {
        Some(Value::Object(data)) => data,
        _ => return Err(BoundaryError::Event("data")),
    };
    let location = match envelope.get("location") {
        None => None,
        Some(Value::Object(location)) => match location.get("directory") {
            Some(Value::String(directory)) if bounded(directory, 4096) => Some(location),
            _ => return Err(BoundaryError::Event("location")),
        },
        _ => return Err(BoundaryError::Event("location")),
    };
    let durable = match envelope.get("durable") {
        None => None,
        Some(Value::Object(cursor)) => Some(parse_durable(cursor)?),
        _ => return Err(BoundaryError::Event("durable")),
    };
    Ok(NativeEvent {
        id,
        typ,
        data,
        location,
        durable,
        created: match envelope.get("created") {
            Some(Value::Number(created)) => created.as_f64(),
            _ => None,
        },
    })
}

fn parse_durable(cursor: &Map) -> Result<Durable<'_>, BoundaryError> {
    let aggregate_id = match cursor.get("aggregateID") {
        Some(Value::String(id)) if bounded(id, 512) => id.as_str(),
        _ => return Err(BoundaryError::Event("durable.aggregateID")),
    };
    let seq = cursor
        .get("seq")
        .and_then(Value::as_f64)
        .filter(|seq| (0.0..=9_007_199_254_740_991.0).contains(seq) && seq.fract() == 0.0)
        .ok_or(BoundaryError::Event("durable.seq"))?;
    if let Some(version) = cursor.get("version")
        && !version.as_f64().is_some_and(f64::is_finite)
    {
        return Err(BoundaryError::Event("durable.version"));
    }
    Ok(Durable { aggregate_id, seq })
}

/// The session an envelope reports, read through its fallbacks: the event's
/// own id, its form's, or its info metadata's.
///
/// Borrowed from the event: this runs once per event on the hot path, so it
/// copies nothing (the TypeScript built up to three strings here). As `string`
/// does, a field that *is* a string wins even when empty.
pub fn event_session(value: &Value) -> &str {
    let envelope = fields(value);
    let data = fields(get(envelope, "data"));
    if let Some(session) = string_field(data, "sessionID") {
        return session;
    }
    if let Some(session) = string_field(fields(get(data, "form")), "sessionID") {
        return session;
    }
    string_field(
        fields(get(fields(get(data, "info")), "metadata")),
        "sessionID",
    )
    .unwrap_or("")
}

/// One field that is a string, borrowed; anything else is absent.
fn string_field<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    }
}

/// A validated session snapshot (`SessionInfo` in TypeScript).
pub struct SessionInfo<'a> {
    pub id: &'a str,
    pub values: &'a Map,
}

/// Validate a session snapshot the way `SessionInfo.parse` does: `id` is
/// 1..=512 code points, `projectID` 0..=512, `location.directory` 1..=4096,
/// and `parentID` is optional but at most 512.
pub fn parse_session_info(value: &Value) -> Result<SessionInfo<'_>, BoundaryError> {
    let info = fields(value);
    let id = match info.get("id") {
        Some(Value::String(id)) if !id.is_empty() && bounded(id, 512) => id.as_str(),
        _ => return Err(BoundaryError::Event("session.id")),
    };
    if !matches!(
        info.get("projectID"),
        Some(Value::String(project)) if bounded(project, 512)
    ) {
        return Err(BoundaryError::Event("session.projectID"));
    }
    let directory_ok = match info.get("location") {
        Some(Value::Object(location)) => matches!(
            location.get("directory"),
            Some(Value::String(directory))
                if !directory.is_empty() && bounded(directory, 4096)
        ),
        _ => false,
    };
    if !directory_ok {
        return Err(BoundaryError::Event("session.location"));
    }
    match info.get("parentID") {
        None => {}
        Some(Value::String(parent)) if bounded(parent, 512) => {}
        _ => return Err(BoundaryError::Event("session.parentID")),
    }
    Ok(SessionInfo { id, values: info })
}

/// Validate a page of native history (`Page` in TypeScript).
pub fn parse_page(value: &Value) -> Result<&[Value], BoundaryError> {
    let page = fields(value);
    match page.get("data") {
        Some(Value::Array(data)) if data.len() <= 200 => Ok(data),
        _ => Err(BoundaryError::Event("page")),
    }
}

/// Validate a pending-interaction listing (`PendingList` in TypeScript).
pub fn parse_pending_list(value: &Value) -> Result<&[Value], BoundaryError> {
    match value {
        Value::Array(items) if items.len() <= 1024 => Ok(items),
        _ => Err(BoundaryError::Event("pending")),
    }
}

/// Reorder an envelope the way `NativeEvent.parse` emits it: known keys in
/// schema order (`id`, `type`, `data`, `location`, `durable`), then unknown
/// keys in arrival order. Nested `location` and `durable` keep their schema
/// order the same way. Raw payloads embed this order byte for byte.
pub fn order_envelope(value: &Value) -> Value {
    let map = fields(value);
    if !matches!(value, Value::Object(_)) {
        return Value::Null;
    }
    let mut out = Map::new();
    for key in ["id", "type", "data", "location", "durable"] {
        if let Some(nested) = map.get(key) {
            out.insert(key.to_owned(), order_nested(key, nested));
        }
    }
    for (key, nested) in map.iter() {
        if !out.contains_key(key) {
            out.insert(key.clone(), nested.clone());
        }
    }
    Value::Object(out)
}

/// Reorder a nested envelope view the way its schema emits it.
fn order_nested(key: &str, value: &Value) -> Value {
    let map = fields(value);
    if !matches!(value, Value::Object(_)) {
        return value.clone();
    }
    let order: &[&str] = match key {
        "location" => &["directory"],
        "durable" => &["aggregateID", "seq", "version"],
        _ => return value.clone(),
    };
    let mut out = Map::new();
    for nested in order {
        if let Some(field) = map.get(*nested) {
            out.insert((*nested).to_owned(), field.clone());
        }
    }
    for (field, nested) in map.iter() {
        if !out.contains_key(field) {
            out.insert(field.clone(), nested.clone());
        }
    }
    Value::Object(out)
}

/// Validate a projected history message (`ProjectedMessage` in TypeScript).
pub fn parse_projected_message(value: &Value) -> Result<&Map, BoundaryError> {
    let message = fields(value);
    if !matches!(value, Value::Object(_)) {
        return Err(BoundaryError::Event("message"));
    }
    match (message.get("id"), message.get("type")) {
        (Some(Value::String(id)), Some(Value::String(typ)))
            if !id.is_empty() && bounded(id, 512) && bounded(typ, 256) =>
        {
            if let Some(Value::Array(content)) = message.get("content")
                && content.len() > 2048
            {
                return Err(BoundaryError::Event("message.content"));
            }
            Ok(message)
        }
        _ => Err(BoundaryError::Event("message")),
    }
}

/// Check an OpenCode server URL the way `loopback` does: a credential-free
/// loopback HTTP URL serving at its root.
pub fn check_loopback(value: &str) -> Result<&str, BoundaryError> {
    let rest = value
        .strip_prefix("http://")
        .ok_or(BoundaryError::Event("loopback"))?;
    if rest.contains(['?', '#']) || rest.contains('@') {
        return Err(BoundaryError::Event("loopback"));
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => return Err(BoundaryError::Event("loopback")),
    };
    if path != "/" {
        return Err(BoundaryError::Event("loopback"));
    }
    let (host, port) = match authority.rfind(':') {
        Some(at) => authority.split_at(at),
        None => return Err(BoundaryError::Event("loopback")),
    };
    if port.len() < 2 || !port[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Err(BoundaryError::Event("loopback"));
    }
    if host != "127.0.0.1" && host != "[::1]" {
        return Err(BoundaryError::Event("loopback"));
    }
    Ok(value)
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn sse_id_type_and_directory_accept_emoji_at_the_schema_limit() {
        for (field, limit) in [("id", 512), ("type", 256), ("directory", 4096)] {
            for length in [limit, limit + 1] {
                let mut value = ace_json::parse(
                    r#"{"id":"n","type":"event","data":{},"location":{"directory":"/tmp"}}"#,
                )
                .expect("event");
                let map = value.as_object_mut().expect("object");
                let target = if field == "directory" {
                    map.get_mut("location")
                        .and_then(Value::as_object_mut)
                        .expect("location")
                } else {
                    map
                };
                target.insert(field, Value::from("😀".repeat(length)));
                assert_eq!(
                    parse_native_event(&value).is_ok(),
                    length == limit,
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn session_info_checks_project_directory_and_parent_in_code_points() {
        for (field, limit) in [("projectID", 512), ("directory", 4096), ("parentID", 512)] {
            for length in [limit, limit + 1] {
                let text = "😀".repeat(length);
                let mut value = ace_json::json!({
                    "id":"session", "projectID":"p", "location":{"directory":"/tmp"}
                });
                let map = value.as_object_mut().expect("object");
                match field {
                    "directory" => {
                        map.get_mut("location")
                            .and_then(Value::as_object_mut)
                            .expect("location")
                            .insert("directory", Value::from(text));
                    }
                    _ => {
                        map.insert(field, Value::from(text));
                    }
                }
                assert_eq!(
                    parse_session_info(&value).is_ok(),
                    length == limit,
                    "{field}"
                );
            }
        }
        // Required: `projectID` and `location.directory` must be present, and
        // the directory is `.min(1)`.
        for missing in [
            r#"{"id":"session","location":{"directory":"/tmp"}}"#,
            r#"{"id":"session","projectID":"p"}"#,
            r#"{"id":"session","projectID":"p","location":{"directory":""}}"#,
            r#"{"id":"session","projectID":"p","location":{}}"#,
        ] {
            let value = ace_json::parse(missing).expect("fixture");
            assert!(parse_session_info(&value).is_err(), "{missing}");
        }
        // `projectID` and `parentID` have no `.min(1)`: empty is a value.
        for accepted in [
            r#"{"id":"session","projectID":"","location":{"directory":"/tmp"}}"#,
            r#"{"id":"session","projectID":"p","location":{"directory":"/tmp"},"parentID":""}"#,
        ] {
            let value = ace_json::parse(accepted).expect("fixture");
            assert!(parse_session_info(&value).is_ok(), "{accepted}");
        }
    }

    #[test]
    fn durable_session_and_projected_message_strings_count_code_points() {
        for (field, limit) in [
            ("aggregateID", 512),
            ("session.id", 512),
            ("message.id", 512),
            ("message.type", 256),
        ] {
            for length in [limit, limit + 1] {
                let text = "😀".repeat(length);
                let accepted = match field {
                    "aggregateID" => parse_native_event(&ace_json::json!({
                        "id":"event", "type":"session.updated", "data":{},
                        "durable": {"aggregateID": text, "seq":0}
                    }))
                    .is_ok(),
                    "session.id" => parse_session_info(&ace_json::json!({
                        "id":text, "projectID":"p", "location":{"directory":"/tmp"}
                    }))
                    .is_ok(),
                    "message.id" => {
                        parse_projected_message(&ace_json::json!({"id":text, "type":"user"}))
                            .is_ok()
                    }
                    _ => parse_projected_message(&ace_json::json!({"id":"message", "type":text}))
                        .is_ok(),
                };
                assert_eq!(accepted, length == limit, "{field}");
            }
        }
    }

    #[test]
    fn optional_event_objects_must_be_omitted_or_objects() {
        let event = r#"{"id":"event","type":"session.updated","data":{}}"#;
        let mut event = ace_json::parse(event).expect("event");
        assert!(parse_native_event(&event).is_ok());
        for key in ["location", "durable"] {
            let mut invalid = event.clone();
            invalid
                .as_object_mut()
                .expect("object")
                .insert(key, Value::Null);
            assert!(parse_native_event(&invalid).is_err(), "{key}");
        }
        event
            .as_object_mut()
            .expect("object")
            .insert("location", ace_json::json!({"directory":"/tmp"}));
        assert!(parse_native_event(&event).is_ok());
    }

    #[test]
    fn durable_events_take_safe_sequences_and_finite_versions() {
        for (cursor, accepted) in [
            (r#"{"aggregateID":"s","seq":0}"#, true),
            (
                r#"{"aggregateID":"s","seq":9007199254740991,"version":1.5}"#,
                true,
            ),
            (r#"{"aggregateID":"s","seq":9007199254740992}"#, false),
            (r#"{"aggregateID":"s","seq":-1}"#, false),
            (r#"{"aggregateID":"s","seq":0.5}"#, false),
            (r#"{"aggregateID":"s","seq":1,"version":null}"#, false),
            (r#"{"aggregateID":"s","seq":1,"version":"2"}"#, false),
            (r#"{"aggregateID":"s","seq":1,"version":1e400}"#, false),
        ] {
            let event = ace_json::parse(&format!(
                r#"{{"id":"event","type":"native","data":{{}},"durable":{cursor}}}"#
            ));
            let actual = event
                .as_ref()
                .is_ok_and(|event| parse_native_event(event).is_ok());
            assert_eq!(actual, accepted, "{cursor}");
        }
    }
}
