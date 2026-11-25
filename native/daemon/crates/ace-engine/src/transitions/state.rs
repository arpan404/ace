// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! `transition-state.ts:87`-`:196` (`guarded`, `guardOwner`, `guard`, `get`, `set`, `remember`)
//! and `handoff-access.ts`'s `grant`: the metadata rows every create and send writes, the guard
//! an in-flight transition holds, and the conversation a handoff cites. `releaseGuards` is
//! E5.4d's, and `delivered` and `selection` stay E5.9's.

use ace_json::Value;
use ace_store::stmt_cache;

use crate::EngineError;
use crate::repository::residency::{cell_text, text};
use crate::{EngineStore, State};

const GUARD_OWNER: &str = "SELECT command_id FROM engine_transition_guards WHERE thread_id=?";
const GUARD: &str = "INSERT INTO engine_transition_guards VALUES (?, ?)";
const GET: &str = "SELECT value FROM engine_transitions WHERE thread_id=?";
const SET: &str = "INSERT INTO engine_transitions VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value";

/// `maxMessageBytes`, which sizes the merge context (`model/message-limits.ts:8`).
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// The most merge summaries one context carries (`transition-state.ts:34`).
const MAX_CONTEXT: usize = 8;
/// The metadata's whole JSON, in bytes (`transition-state.ts:40`).
const MAX_METADATA_BYTES: usize = 4 * MAX_MESSAGE_BYTES;

/// `TransitionMetadata` with the schema's keys in its order (`transition-state.ts:20`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TransitionMetadata {
    pub selection: Option<Value>,
    pub fork: Option<Value>,
    pub handoff: Option<Value>,
    pub marker: Option<String>,
    pub fallback: Option<Value>,
    pub context: Vec<String>,
}

pub(super) fn invalid(what: &str) -> EngineError {
    EngineError::Records(format!("Invalid transition metadata: {what}"))
}

/// `Metadata.parse`: the known fields in schema order, unknown keys dropped, `context` defaulted.
fn parse_metadata(input: &Value) -> Result<TransitionMetadata, EngineError> {
    let Some(object) = input.as_object() else {
        return Err(invalid("expected an object"));
    };
    let selection = match object.get("selection") {
        None => None,
        Some(value) => Some(parse_selection(value)?),
    };
    let fork = match object.get("fork") {
        None => None,
        Some(value) => Some(parse_fork(value)?),
    };
    let handoff = match object.get("handoff") {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| invalid("handoff is not an object"))?
                .clone()
                .into(),
        ),
    };
    let marker = match object.get("marker") {
        None => None,
        Some(value) => {
            let text = value
                .as_str()
                .ok_or_else(|| invalid("marker is not a string"))?;
            let units = text.encode_utf16().count();
            if units == 0 || units > 512 {
                return Err(invalid("marker is out of bounds"));
            }
            Some(text.to_owned())
        }
    };
    let fallback = match object.get("fallback") {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| invalid("fallback is not an object"))?
                .clone()
                .into(),
        ),
    };
    let context = match object.get("context") {
        None => Vec::new(),
        Some(value) => {
            let items = value
                .as_array()
                .ok_or_else(|| invalid("context is not an array"))?;
            if items.len() > MAX_CONTEXT {
                return Err(invalid("context holds too many entries"));
            }
            let mut texts = Vec::with_capacity(items.len());
            for item in items {
                let entry = item
                    .as_str()
                    .ok_or_else(|| invalid("context entry is not a string"))?;
                if entry.encode_utf16().count() > 2 * MAX_MESSAGE_BYTES {
                    return Err(invalid("context entry is too long"));
                }
                texts.push(entry.to_owned());
            }
            texts
        }
    };
    Ok(TransitionMetadata {
        selection,
        fork,
        handoff,
        marker,
        fallback,
        context,
    })
}

/// `ExecutionSelection.parse`: the schema's keys, its provider and its default options.
fn parse_selection(value: &Value) -> Result<Value, EngineError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("selection is not an object"));
    };
    let provider = object
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("selection has no provider"))?;
    if !providers().contains(&provider) {
        return Err(invalid("selection names an unknown provider"));
    }
    let mut selection = ace_json::Map::new();
    for key in ["provider", "model", "instanceId"] {
        if let Some(field) = object.get(key) {
            if field.as_str().is_none() {
                return Err(invalid("selection field is not a string"));
            }
            selection.insert(key.to_owned(), field.clone());
        }
    }
    let options = match object.get("options") {
        None => Value::Object(ace_json::Map::new()),
        Some(value) => {
            if value.as_object().is_none() {
                return Err(invalid("options is not an object"));
            }
            value.clone()
        }
    };
    selection.insert("options", options);
    Ok(Value::Object(selection))
}

/// `NativeFork.parse`: the native session, its point and whether it is an inherited fork, in
/// the schema's key order with unknown keys dropped.
fn parse_fork(value: &Value) -> Result<Value, EngineError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("fork is not an object"));
    };
    let native_session = object
        .get("nativeSessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("fork has no native session"))?;
    let point = object
        .get("point")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("fork has no point"))?;
    let kind = point
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(kind, "turn" | "item" | "end") {
        return Err(invalid("fork point is unknown"));
    }
    let native_id = point
        .get("nativeId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("fork point has no native id"))?;
    let units = native_id.encode_utf16().count();
    if units == 0 || units > 256 {
        return Err(invalid("fork point id is out of bounds"));
    }
    let mut fork = ace_json::Map::new();
    fork.insert("nativeSessionId", Value::from(native_session));
    let mut point_out = ace_json::Map::new();
    point_out.insert("type", Value::from(kind));
    point_out.insert("nativeId", Value::from(native_id));
    fork.insert("point", Value::Object(point_out));
    if let Some(inherited) = object.get("inherited") {
        if inherited.as_bool() != Some(true) {
            return Err(invalid("inherited is not true"));
        }
        fork.insert("inherited", Value::Bool(true));
    }
    Ok(Value::Object(fork))
}

/// `admitTransitionMetadata`: the metadata, refused when its JSON passes the budget.
pub fn admit_metadata(input: &Value) -> Result<TransitionMetadata, EngineError> {
    let metadata = parse_metadata(input)?;
    let bytes = ace_json::to_string(&Value::Object(metadata_json(&metadata))).len();
    if bytes > MAX_METADATA_BYTES {
        return Err(EngineError::Records(
            "Transition context capacity exceeded".to_owned(),
        ));
    }
    Ok(metadata)
}

fn metadata_json(metadata: &TransitionMetadata) -> ace_json::Map {
    let mut value = ace_json::Map::new();
    if let Some(selection) = &metadata.selection {
        value.insert("selection", selection.clone());
    }
    if let Some(fork) = &metadata.fork {
        value.insert("fork", fork.clone());
    }
    if let Some(handoff) = &metadata.handoff {
        value.insert("handoff", handoff.clone());
    }
    if let Some(marker) = &metadata.marker {
        value.insert("marker", Value::from(marker.as_str()));
    }
    if let Some(fallback) = &metadata.fallback {
        value.insert("fallback", fallback.clone());
    }
    value.insert(
        "context",
        Value::Array(
            metadata
                .context
                .iter()
                .map(|entry| Value::from(entry.as_str()))
                .collect(),
        ),
    );
    value
}

/// The providers an `ExecutionSelection` names (`ProviderKind`).
fn providers() -> [&'static str; 7] {
    [
        "claude",
        "codex",
        "opencode",
        "cursor",
        "pi",
        "acp",
        "antigravity",
    ]
}

impl State {
    /// `TransitionState.guarded` (`:87`).
    pub fn transition_guarded(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<bool, EngineError> {
        Ok(self.transition_guard_owner(store, id)?.is_some())
    }

    /// `TransitionState.guardOwner` (`:90`): one SELECT, no write transaction.
    pub fn transition_guard_owner(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        let row = stmt_cache::get_row(store.conn(), GUARD_OWNER, vec![text(id)])?;
        Ok(row.and_then(|row| row.get("command_id").and_then(cell_text).map(str::to_owned)))
    }

    /// `TransitionState.guard` (`:96`): the command that owns the thread's transition.
    pub fn transition_guard(
        &mut self,
        store: &EngineStore,
        id: &str,
        command_id: &str,
    ) -> Result<(), EngineError> {
        store.atomic(|tx| {
            stmt_cache::run(tx.conn(), GUARD, vec![text(id), text(command_id)])?;
            Ok(())
        })
    }

    /// `TransitionState.get` (`:109`): the thread's metadata, `{}` when it has none.
    pub fn transition_get(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<TransitionMetadata, EngineError> {
        let row = stmt_cache::get_row(store.conn(), GET, vec![text(id)])?;
        let stored = row.and_then(|row| row.get("value").and_then(cell_text).map(str::to_owned));
        match stored {
            None => Ok(TransitionMetadata::default()),
            Some(text) => {
                let parsed = ace_json::parse(&text)
                    .map_err(|error| EngineError::Records(error.to_string()))?;
                parse_metadata(&parsed)
            }
        }
    }

    /// `TransitionState.set` (`:130`): the metadata, in the schema's shape and bounded.
    pub fn transition_set(
        &mut self,
        store: &EngineStore,
        id: &str,
        input: &Value,
    ) -> Result<(), EngineError> {
        let metadata = admit_metadata(input)?;
        let json = ace_json::to_string(&Value::Object(metadata_json(&metadata)));
        store.atomic(|tx| {
            stmt_cache::run(tx.conn(), SET, vec![text(id), text(&json)])?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn metadata_is_stored_in_schema_order_with_its_context_defaulted() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state
            .transition_set(
                &store,
                "t",
                &value(r#"{"unknown":1,"marker":"m","context":["a"]}"#),
            )
            .expect("set");
        let stored = stmt_cache::get_row(
            &conn,
            "SELECT value FROM engine_transitions WHERE thread_id='t'",
            Vec::new(),
        )
        .expect("row")
        .and_then(|row| row.get("value").and_then(cell_text).map(str::to_owned))
        .unwrap_or_default();
        assert_eq!(stored, r#"{"marker":"m","context":["a"]}"#);
        let read = state.transition_get(&store, "t").expect("get");
        assert_eq!(read.marker.as_deref(), Some("m"));
        assert_eq!(read.context, ["a"]);
        assert_eq!(
            state.transition_get(&store, "none").expect("get").context,
            Vec::<String>::new()
        );
    }
}
