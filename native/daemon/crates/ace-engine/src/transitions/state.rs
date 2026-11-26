// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! `transition-state.ts:87`-`:196` (`guarded`, `guardOwner`, `guard`, `releaseGuards`, `get`,
//! `set`): the metadata rows every create and send writes and the guard an in-flight
//! transition holds. `delivered` and `selection` stay E5.9's, and the selection a thread
//! remembers with the handoff grant is in `transitions::remembered`.

use ace_json::Value;
use ace_store::stmt_cache;

use crate::EngineError;
use crate::repository::residency::{cell_text, text};
use crate::{EngineStore, State};

const GUARD_OWNER: &str = "SELECT command_id FROM engine_transition_guards WHERE thread_id=?";
const GUARD: &str = "INSERT INTO engine_transition_guards VALUES (?, ?)";
const GUARDED: &str = "SELECT thread_id FROM engine_transition_guards WHERE command_id=?";
const RELEASE_GUARDS: &str = "DELETE FROM engine_transition_guards WHERE command_id=?";
const GET: &str = "SELECT value FROM engine_transitions WHERE thread_id=?";
const LATEST: &str = "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? ORDER BY rowid DESC LIMIT 1";
const OPTION: &str =
    "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?";
const SET: &str = "INSERT INTO engine_transitions VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value";

use crate::transitions::metadata::{
    TransitionMetadata, admit_metadata, metadata_json, parse_metadata,
};
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

    /// `TransitionState.releaseGuards` (`:102`): every guard the command holds, released, with
    /// the threads they held returned in row order.
    pub fn transition_release_guards(
        &mut self,
        store: &EngineStore,
        command_id: &str,
    ) -> Result<Vec<String>, EngineError> {
        store.atomic(|tx| {
            let rows = stmt_cache::all_rows(tx.conn(), GUARDED, vec![text(command_id)])?;
            let threads: Vec<String> = rows
                .iter()
                .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
                .collect();
            stmt_cache::run(tx.conn(), RELEASE_GUARDS, vec![text(command_id)])?;
            Ok(threads)
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

    /// `TransitionState.selection` (`:139`): the selection a requested change resolves to.
    pub fn transition_selection(
        &mut self,
        store: &EngineStore,
        id: &str,
        fallback: &Value,
        requested: &Value,
    ) -> Result<Value, EngineError> {
        let previous = self
            .transition_get(store, id)?
            .selection
            .unwrap_or_else(|| fallback.clone());
        let provider = |value: &Value| {
            value
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let requested_provider = provider(requested);
        let previous_provider = provider(&previous);
        // Another ACP agent is another agent: none of the previous one's model carries over.
        let other_agent = requested_provider == "acp"
            && requested.get("instanceId").is_some()
            && requested.get("instanceId") != previous.get("instanceId");
        let same = previous_provider == requested_provider && !other_agent;
        let model = match requested.get("model").cloned() {
            Some(model) => Some(model),
            None if same => previous.get("model").cloned(),
            None if other_agent => None,
            None => self
                .latest(store, id, &requested_provider)?
                .and_then(|selection| selection.get("model").cloned()),
        };
        let selected = requested.get("instanceId").cloned().or_else(|| {
            if same {
                previous.get("instanceId").cloned()
            } else {
                None
            }
        });
        let instance = if requested_provider == "cursor" {
            match selected.as_ref().and_then(Value::as_str) {
                Some("cursor-cli-default") => Some("cursor-sdk-default".to_owned()),
                other => other.map(str::to_owned),
            }
        } else {
            selected.as_ref().and_then(Value::as_str).map(str::to_owned)
        };
        let model_text = model.as_ref().and_then(Value::as_str).unwrap_or("");
        let remembered = self.options(store, id, &requested_provider, model_text)?;
        let options = requested
            .get("options")
            .cloned()
            .or(remembered)
            .or_else(|| {
                (same && model == previous.get("model").cloned()).then(|| {
                    previous
                        .get("options")
                        .cloned()
                        .unwrap_or(Value::Object(ace_json::Map::new()))
                })
            })
            .unwrap_or_else(|| Value::Object(ace_json::Map::new()));
        let mut selection = ace_json::Map::new();
        selection.insert("provider", Value::from(requested_provider.as_str()));
        if let Some(model) = model {
            selection.insert("model", model);
        }
        if let Some(instance) = instance {
            selection.insert("instanceId", Value::from(instance.as_str()));
        }
        selection.insert("options", options);
        Ok(Value::Object(selection))
    }

    /// The thread's last remembered selection for a provider.
    fn latest(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider: &str,
    ) -> Result<Option<Value>, EngineError> {
        let row = stmt_cache::get_row(store.conn(), LATEST, vec![text(id), text(provider)])?;
        Ok(row
            .and_then(|row| row.get("value").and_then(cell_text).map(str::to_owned))
            .and_then(|text| ace_json::parse(&text).ok()))
    }

    /// The remembered options for one provider and model.
    fn options(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<Value>, EngineError> {
        let row = stmt_cache::get_row(
            store.conn(),
            OPTION,
            vec![text(id), text(provider), text(model)],
        )?;
        Ok(row
            .and_then(|row| row.get("value").and_then(cell_text).map(str::to_owned))
            .and_then(|text| ace_json::parse(&text).ok())
            .and_then(|selection| selection.get("options").cloned()))
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
    fn releasing_a_commands_guards_returns_and_deletes_every_thread_it_held() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        for id in ["t2", "t3"] {
            conn.exec(&format!(
                "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES ('{id}', 'workspace', 'Thread', 'claude', '{{\"state\":\"new\"}}', 0, 0)"
            ))
            .expect("thread");
        }
        for (thread, command) in [("t", "cmd"), ("t2", "cmd"), ("t3", "other")] {
            conn.exec(&format!(
                "INSERT INTO engine_transition_guards VALUES ('{thread}', '{command}')"
            ))
            .expect("guard");
        }
        let released = state
            .transition_release_guards(&store, "cmd")
            .expect("release");
        assert_eq!(released, ["t", "t2"]);
        assert!(!state.transition_guarded(&store, "t").expect("guarded"));
        assert_eq!(
            state
                .transition_guard_owner(&store, "t3")
                .expect("owner")
                .as_deref(),
            Some("other")
        );
        assert!(
            state
                .transition_release_guards(&store, "cmd")
                .expect("empty")
                .is_empty()
        );
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
