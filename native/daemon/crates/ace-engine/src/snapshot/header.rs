// SPDX-License-Identifier: Apache-2.0
//! The `thread_state.state` JSON (E5.3, `persistence.ts:240`-`:262`, `header.ts`).
//!
//! The header is the state's own JSON with each record section emptied and
//! `engineSnapshot: 9`. Key order is that of `{...state, agents: {}, ..., engineSnapshot}`: a
//! spread then an override keeps the key where the state had it, and `engineSnapshot` goes
//! last only if the state had none. A decoded header has one, so it keeps its place. Unknown
//! header fields a newer build wrote are kept in place, because the core keeps unknown header
//! fields as raw data.

use ace_core::ThreadState;
use ace_json::{Map, Value};

use crate::EngineError;

/// The record sections, in the order the TypeScript override literal names them
/// (`persistence.ts:245`-`:252`).
pub const RECORD_SECTIONS: [&str; 8] = [
    "agents",
    "items",
    "runs",
    "interactions",
    "tasks",
    "interactionHistory",
    "taskHistory",
    "itemLinks",
];

/// The eight index maps, in the order the TypeScript override names them (`:253`-`:262`).
pub const INDEX_SECTIONS: [&str; 8] = [
    "liveTools",
    "openText",
    "pendingInteractions",
    "runningTasks",
    "agentKeysById",
    "childrenByParent",
    "pendingSpawnLinks",
    "pendingItemLinks",
];

/// Build `thread_state.state` for `state`. `original` is the header the state was decoded from
/// (absent for a state the engine made itself), whose key order and unknown fields win.
pub fn header_json(state: &ThreadState, original: Option<&Value>) -> Result<String, EngineError> {
    let current =
        ace_json::ser::to_string(state).map_err(|error| EngineError::Records(error.to_string()))?;
    let current =
        ace_json::parse(&current).map_err(|error| EngineError::Records(error.to_string()))?;
    let Value::Object(current) = current else {
        return Err(EngineError::InvalidState);
    };
    let mut header = Map::new();
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(Value::Object(original)) = original {
        for (key, _) in original {
            let name = key.as_str();
            if name == "engineSnapshot" {
                header.insert(name, Value::from(9u64));
            } else if let Some(value) = override_value(name) {
                header.insert(name, value);
            } else if let Some(value) = current.get(name) {
                header.insert(name, Value::from(value));
            } else {
                // An unknown header field a newer build wrote: kept as raw data where it was.
                if let Some(value) = original.get(name) {
                    header.insert(name, Value::from(value));
                }
                continue;
            }
            written.insert(name.to_owned());
        }
    }
    // Every key of the state's own JSON that the header has not written yet, in its order.
    for (key, value) in &current {
        let name = key.as_str();
        if written.contains(name) {
            continue;
        }
        match override_value(name) {
            Some(value) => header.insert(name, value),
            None => header.insert(name, Value::from(value)),
        };
        written.insert(name.to_owned());
    }
    if !written.contains("engineSnapshot") {
        header.insert("engineSnapshot", Value::from(9u64));
    }
    Ok(ace_json::to_string(&Value::Object(header)))
}

/// The emptied value of a section key, or `None` for a key that is not overridden.
fn override_value(key: &str) -> Option<Value> {
    if RECORD_SECTIONS.contains(&key) {
        return Some(Value::from(Map::new()));
    }
    if key == "indexes" {
        let mut indexes = Map::new();
        for name in INDEX_SECTIONS {
            indexes.insert(name, Value::from(Map::new()));
        }
        return Some(Value::from(indexes));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ThreadState {
        let json = r#"{"threadId":"t","config":{"provider":"claude","silenceMs":1000},"rootKey":"root","agents":{},"runs":{},"items":{},"interactions":{},"tasks":{},"interactionHistory":{},"taskHistory":{},"indexes":{"liveTools":{},"openText":{},"pendingInteractions":{},"runningTasks":{},"agentKeysById":{},"childrenByParent":{},"pendingSpawnLinks":{},"pendingItemLinks":{}},"outcomeOrder":0,"pendingNotices":[],"itemLinks":{},"queueCount":0,"queueSources":{"engine":0,"provider":0},"hasRun":false,"status":{"state":"new"}}"#;
        ace_json::from_value(&ace_json::parse(json).unwrap()).unwrap()
    }

    #[test]
    fn a_fresh_header_empties_every_section_and_puts_the_version_last() {
        let header = header_json(&state(), None).unwrap();
        assert!(header.contains(r#""agents":{}"#));
        assert!(header.contains(r#""openText":{}"#));
        assert!(header.ends_with(r#""engineSnapshot":9}"#), "{header}");
    }

    #[test]
    fn a_decoded_header_keeps_the_versions_place_and_unknown_fields() {
        let original = ace_json::parse(
            r#"{"engineSnapshot":9,"threadId":"t","config":{"provider":"claude","silenceMs":1000},"futureField":{"a":1},"agents":{"a":{}},"indexes":{"liveTools":{}},"outcomeOrder":0,"pendingNotices":[],"itemLinks":{},"queueCount":0,"queueSources":{"engine":0,"provider":0},"hasRun":false,"status":{"state":"new"}}"#,
        )
        .unwrap();
        let header = header_json(&state(), Some(&original)).unwrap();
        let parsed = ace_json::parse(&header).unwrap();
        let Value::Object(object) = &parsed else {
            panic!("header is an object")
        };
        let keys: Vec<&str> = object.keys().map(|key| key.as_str()).collect();
        assert_eq!(keys[0], "engineSnapshot");
        assert!(keys.contains(&"futureField"));
        assert_eq!(ace_json::to_string(object.get("agents").unwrap()), "{}");
        assert!(!header.contains(r#""futureField":null"#));
    }
}
