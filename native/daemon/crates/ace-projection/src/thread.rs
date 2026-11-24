// SPDX-License-Identifier: Apache-2.0
//! `updateThread` and `isSidebarEvent` from `packages/projection/src/index.ts:164` to `:235`,
//! and nothing else from that package. Statement order matches the TypeScript line by line.

use ace_json::{JsString, Map, Number, Value};
use std::fmt;

/// One event as the fold reads it, built from what the shell sent.
pub enum FoldEvent<'a> {
    QueueUpdated { payload: &'a Map },
    ThreadClientUpdated { payload: &'a Map },
    ThreadUpdated { payload: &'a Map, seq: f64 },
    ThreadCreated,
    RootAgentCreated { agent_id: &'a JsString },
}

#[derive(Debug)]
pub enum FoldError {
    /// `kind` is not one of the five, or its payload is missing or the wrong JSON type.
    /// Display: "fold: unexpected input for <kind>".
    Input(String),
    /// `changes` (thread.client.updated) or `acp` (thread.updated) is not an object.
    /// Display: "fold: <field> is not an object".
    NotAnObject(&'static str),
}

impl fmt::Display for FoldError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FoldError::Input(kind) => write!(f, "fold: unexpected input for {kind}"),
            FoldError::NotAnObject(field) => write!(f, "fold: {field} is not an object"),
        }
    }
}

impl std::error::Error for FoldError {}

impl<'a> FoldEvent<'a> {
    /// What the binding and the vector test both call: `kind` and the parsed `payload` text
    /// (None for thread.created) as the shell sent them, and `seq`.
    pub fn from_wire(
        kind: &str,
        payload: Option<&'a Value>,
        seq: f64,
    ) -> Result<FoldEvent<'a>, FoldError> {
        match kind {
            "queue.updated" => match payload {
                Some(Value::Object(map)) => Ok(FoldEvent::QueueUpdated { payload: map }),
                _ => Err(FoldError::Input(kind.to_owned())),
            },
            "thread.client.updated" => match payload {
                Some(Value::Object(map)) => Ok(FoldEvent::ThreadClientUpdated { payload: map }),
                _ => Err(FoldError::Input(kind.to_owned())),
            },
            "thread.updated" => match payload {
                Some(Value::Object(map)) => Ok(FoldEvent::ThreadUpdated { payload: map, seq }),
                _ => Err(FoldError::Input(kind.to_owned())),
            },
            "thread.created" => match payload {
                None => Ok(FoldEvent::ThreadCreated),
                _ => Err(FoldError::Input(kind.to_owned())),
            },
            "agent.created" => match payload {
                Some(Value::String(agent_id)) => Ok(FoldEvent::RootAgentCreated { agent_id }),
                _ => Err(FoldError::Input(kind.to_owned())),
            },
            _ => Err(FoldError::Input(kind.to_owned())),
        }
    }
}

/// `isSidebarEvent`, by payload type.
pub fn is_sidebar_event(kind: &str) -> bool {
    matches!(
        kind,
        "queue.updated" | "thread.created" | "thread.updated" | "thread.client.updated"
    )
}

fn set_updated_at(thread: &mut Map, at: f64) {
    thread.insert("updatedAt", Value::Number(Number::from(at)));
}

/// `updateThread`: folds one event into the thread, in place.
pub fn update_thread(thread: &mut Map, event: FoldEvent<'_>, at: f64) -> Result<(), FoldError> {
    match event {
        FoldEvent::QueueUpdated { payload } => {
            let mut queue = Map::new();
            for (key, value) in payload.iter() {
                if key.as_str() == "type" {
                    continue;
                }
                queue.insert(key.clone(), value.clone());
            }
            thread.insert("queue", Value::Object(queue));
            set_updated_at(thread, at);
        }
        FoldEvent::ThreadClientUpdated { payload } => {
            let changes = match payload.get("changes") {
                Some(Value::Object(map)) => map,
                _ => return Err(FoldError::NotAnObject("changes")),
            };
            for (key, value) in changes.iter() {
                if value.is_null() {
                    thread.remove(key);
                } else {
                    thread.insert(key.clone(), value.clone());
                }
            }
            set_updated_at(thread, at);
        }
        FoldEvent::ThreadUpdated { payload, seq } => {
            if let Some(value) = payload.get("workspaceId") {
                thread.insert("workspaceId", value.clone());
            }
            if let Some(value) = payload.get("permission") {
                thread.insert("permission", value.clone());
            }
            if let Some(value) = payload.get("backend") {
                let is_cursor_sdk = match value {
                    Value::String(text) => text.as_str() == "cursor-sdk",
                    _ => false,
                };
                thread.insert("backend", value.clone());
                if is_cursor_sdk {
                    thread.remove("continuation");
                }
            }
            if let Some(value) = payload.get("capabilities") {
                thread.insert("capabilities", value.clone());
            }
            if let Some(value) = payload.get("provider") {
                thread.insert("provider", value.clone());
            }
            if let Some(value) = payload.get("lineage") {
                thread.insert("lineage", value.clone());
            }
            if let Some(value) = payload.get("delegatedBy") {
                thread.insert("delegatedBy", value.clone());
            }
            if let Some(value) = payload.get("delegatedFrom") {
                thread.insert("delegatedFrom", value.clone());
            }
            if let Some(value) = payload.get("startedBy") {
                thread.insert("startedBy", value.clone());
            }
            if let Some(value) = payload.get("startedByClient") {
                thread.insert("startedByClient", value.clone());
            }
            if let Some(value) = payload.get("treeRootId") {
                thread.insert("treeRootId", value.clone());
            }
            if let Some(value) = payload.get("queuedLaunch") {
                if value.is_null() {
                    thread.remove("queuedLaunch");
                } else {
                    thread.insert("queuedLaunch", value.clone());
                }
            }
            if let Some(value) = payload.get("execution") {
                thread.insert("execution", value.clone());
            }
            if let Some(value) = payload.get("switch") {
                thread.insert("switch", value.clone());
            }
            if let Some(value) = payload.get("title") {
                thread.insert("title", value.clone());
            }
            if let Some(value) = payload.get("titleSource") {
                thread.insert("titleSource", value.clone());
            }
            if let Some(value) = payload.get("effectiveCapabilities") {
                thread.insert("effectiveCapabilities", value.clone());
            }
            if let Some(value) = payload.get("acpSupport") {
                thread.insert("acpSupport", value.clone());
            }
            if let Some(acp) = payload.get("acp") {
                let acp_map = match acp {
                    Value::Object(map) => map,
                    _ => return Err(FoldError::NotAnObject("acp")),
                };
                for name in ["acpAgentId", "installationId", "instanceId"] {
                    if let Some(value) = acp_map.get(name) {
                        thread.insert(name, value.clone());
                    } else {
                        thread.remove(name);
                    }
                }
            }
            if let Some(value) = payload.get("status") {
                thread.insert("status", value.clone());
                thread.insert("activitySeq", Value::Number(Number::from(seq)));
            }
            if let Some(value) = payload.get("archivedAt") {
                if value.is_null() {
                    thread.remove("archivedAt");
                } else {
                    thread.insert("archivedAt", value.clone());
                }
            }
            if let Some(value) = payload.get("goal") {
                if value.is_null() {
                    thread.remove("goal");
                } else {
                    thread.insert("goal", value.clone());
                }
            }
            set_updated_at(thread, at);
        }
        FoldEvent::ThreadCreated => {
            set_updated_at(thread, at);
        }
        FoldEvent::RootAgentCreated { agent_id } => {
            thread.insert("rootAgentId", Value::String(agent_id.clone()));
        }
    }
    Ok(())
}
