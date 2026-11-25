// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! `transition-state.ts:87`-`:196` (`guarded`, `guardOwner`, `guard`, `get`, `set`, `remember`)
//! and `handoff-access.ts`'s `grant`: the metadata rows every create and send writes, the guard
//! an in-flight transition holds, and the conversation a handoff cites. `releaseGuards` is
//! E5.4d's, and `delivered` and `selection` stay E5.9's.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::EngineError;
use crate::repository::residency::{cell_text, text};
use crate::{EngineStore, State};

const GUARD_OWNER: &str = "SELECT command_id FROM engine_transition_guards WHERE thread_id=?";
const GUARD: &str = "INSERT INTO engine_transition_guards VALUES (?, ?)";
const GET: &str = "SELECT value FROM engine_transitions WHERE thread_id=?";
const SET: &str = "INSERT INTO engine_transitions VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value";
const OPTION: &str =
    "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?";
const OPTION_COUNT: &str = "SELECT COUNT(*) AS n FROM engine_model_options WHERE thread_id=?";
const FORGET_OPTION: &str =
    "DELETE FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?";
const REMEMBER: &str = "INSERT INTO engine_model_options VALUES (?, ?, ?, ?)";
const GRANT_FOUND: &str = "SELECT source FROM engine_handoff_grants WHERE recipient=? AND source=?";
const GRANT_COUNT: &str = "SELECT COUNT(*) AS n FROM engine_handoff_grants WHERE recipient=?";
const GRANT: &str = "INSERT INTO engine_handoff_grants VALUES (?, ?, ?)
      ON CONFLICT(recipient,source) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)";

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

fn invalid(what: &str) -> EngineError {
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
        Some(value) => {
            parse_fork(value)?;
            Some(value.clone())
        }
    };
    let handoff = object.get("handoff").cloned();
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
    let fallback = object.get("fallback").cloned();
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

/// `NativeFork.parse`: the native session, its point and whether it is an inherited fork.
fn parse_fork(value: &Value) -> Result<(), EngineError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("fork is not an object"));
    };
    if object
        .get("nativeSessionId")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err(invalid("fork has no native session"));
    }
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
    if let Some(inherited) = object.get("inherited")
        && inherited.as_bool() != Some(true)
    {
        return Err(invalid("inherited is not true"));
    }
    Ok(())
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

    /// `TransitionState.remember` (`:190`): the selection, at most 32 per thread.
    pub fn transition_remember(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: &Value,
    ) -> Result<(), EngineError> {
        let provider = selection
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("selection has no provider"))?;
        let model = selection.get("model").and_then(Value::as_str).unwrap_or("");
        let json = ace_json::to_string(selection);
        store.atomic(|tx| {
            let count = stmt_cache::get_row(tx.conn(), OPTION_COUNT, vec![text(id)])?
                .and_then(|row| {
                    row.get("n")
                        .and_then(crate::repository::residency::cell_int)
                })
                .unwrap_or(0);
            let remembered = stmt_cache::get_row(
                tx.conn(),
                OPTION,
                vec![text(id), text(provider), text(model)],
            )?;
            if count >= 32 && remembered.is_none() {
                return Err(EngineError::Records(
                    "Remembered model capacity exceeded".to_owned(),
                ));
            }
            // rowid tracks the last selection without time or randomness dependencies.
            stmt_cache::run(
                tx.conn(),
                FORGET_OPTION,
                vec![text(id), text(provider), text(model)],
            )?;
            stmt_cache::run(
                tx.conn(),
                REMEMBER,
                vec![text(id), text(provider), text(model), text(&json)],
            )?;
            Ok(())
        })
    }

    /// `HandoffAccess.grant` (`handoff-access.ts:41`): the source's conversation through `seq`,
    /// granted to at most 8 recipients.
    pub fn handoff_grant(
        &mut self,
        store: &EngineStore,
        recipient: &str,
        source: &str,
        through_seq: i64,
    ) -> Result<(), EngineError> {
        store.atomic(|tx| {
            let found =
                stmt_cache::get_row(tx.conn(), GRANT_FOUND, vec![text(recipient), text(source)])?;
            if found.is_none() {
                let count = stmt_cache::get_row(tx.conn(), GRANT_COUNT, vec![text(recipient)])?
                    .and_then(|row| {
                        row.get("n")
                            .and_then(crate::repository::residency::cell_int)
                    })
                    .unwrap_or(0);
                if count >= 8 {
                    return Err(EngineError::Records(
                        "Handoff history grant capacity exceeded".to_owned(),
                    ));
                }
            }
            stmt_cache::run(
                tx.conn(),
                GRANT,
                vec![text(recipient), text(source), Cell::Integer(through_seq)],
            )?;
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

    #[test]
    fn guards_are_owned_by_one_command_and_remembered_selections_cap_at_thirty_two() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        assert!(!state.transition_guarded(&store, "t").expect("guarded"));
        state.transition_guard(&store, "t", "cmd").expect("guard");
        assert_eq!(
            state
                .transition_guard_owner(&store, "t")
                .expect("owner")
                .as_deref(),
            Some("cmd")
        );
        for index in 0..32 {
            let selection = value(&format!(
                r#"{{"provider":"codex","model":"m{index}","options":{{}}}}"#
            ));
            state
                .transition_remember(&store, "t", &selection)
                .expect("remember");
        }
        // A selection already remembered is replaced, not counted again.
        let same = value(r#"{"provider":"codex","model":"m31","options":{"x":true}}"#);
        state
            .transition_remember(&store, "t", &same)
            .expect("an existing selection is replaced");
        let extra = value(r#"{"provider":"codex","model":"m32","options":{}}"#);
        assert_eq!(
            state
                .transition_remember(&store, "t", &extra)
                .unwrap_err()
                .to_string(),
            "Remembered model capacity exceeded"
        );
    }
}
