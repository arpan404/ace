// SPDX-License-Identifier: Apache-2.0
//! How an accepted input becomes a transcript item (E5.4c): the synthetic input ace writes
//! itself, and the item upsert every acceptance and revision shares, on the root agent.

use ace_json::{JsString, Value};

use crate::inputs::journal;
use crate::inputs::origin::input_origin;
use crate::{EngineError, EngineStore, State};

/// The thread row as `store.getThread` gives it, for the fields an accepted input reads.
pub(crate) struct ThreadRow {
    pub title: Option<JsString>,
    pub title_source: Option<String>,
    pub has_sent_message: bool,
}

pub(crate) fn thread_row(store: &EngineStore, id: &str) -> Result<ThreadRow, EngineError> {
    let Some(text) = store.get_thread(id)? else {
        return Ok(ThreadRow {
            title: None,
            title_source: None,
            has_sent_message: false,
        });
    };
    let row = ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))?;
    Ok(ThreadRow {
        title: row.get("title").and_then(Value::as_js_str).cloned(),
        title_source: row
            .get("titleSource")
            .and_then(Value::as_str)
            .map(str::to_owned),
        has_sent_message: row
            .get("hasSentMessage")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// The parts of a command payload that carries a person's input, and the command id.
pub(crate) fn input_payload(command: &Value) -> Option<(&str, &Value, &str)> {
    let id = command.get("id").and_then(Value::as_str)?;
    let payload = command.get("payload")?;
    let kind = payload.get("type").and_then(Value::as_str)?;
    if kind != "thread.create" && kind != "thread.send" {
        return None;
    }
    let parts = payload.get("input")?;
    Some((id, parts, kind))
}

impl State {
    /// `repo.apply(thread, facts, at)` over a fact list this module built. E5.3's `apply` takes
    /// the frame's JSON, so the list is serialized once here.
    pub(crate) fn apply_facts(
        &mut self,
        store: &EngineStore,
        thread: &str,
        facts: &[Value],
        at: f64,
    ) -> Result<(), EngineError> {
        let json = ace_json::to_string(&Value::Array(facts.to_vec().into()));
        self.apply(store, thread, &json, at, None)
    }

    /// The root agent's key, or `"root"` before one exists (`repo.requireState(id).rootKey`).
    pub(crate) fn input_agent(
        &mut self,
        store: &EngineStore,
        thread: &str,
    ) -> Result<String, EngineError> {
        let snapshot = self.repo.require_state(store, thread)?;
        let root = snapshot.borrow().state.root_key.clone();
        Ok(root.unwrap_or_else(|| "root".to_owned()))
    }

    /// The origin a command's input has: the journal's if the input was accepted, else the one
    /// the command itself implies.
    pub(crate) fn accepted_origin(
        &self,
        store: &EngineStore,
        thread: &str,
        key: &str,
        command: &Value,
    ) -> Result<Value, EngineError> {
        Ok(journal::origin(store.conn(), thread, key)?.unwrap_or_else(|| input_origin(command)))
    }

    /// `syntheticInput` (`transcript-inputs.ts:14`): ace's own input, already delivered.
    pub fn synthetic_input(
        &mut self,
        store: &EngineStore,
        thread: &str,
        key: &str,
        text: &str,
        origin: &Value,
        at: f64,
    ) -> Result<(), EngineError> {
        let mut part = ace_json::Map::new();
        part.insert("type", Value::from("text"));
        part.insert("text", Value::from(text));
        let parts = vec![Value::Object(part)];
        journal::register(store.conn(), thread, key, &parts, origin)?;
        let agent = self.input_agent(store, thread)?;
        let mut draft = ace_json::Map::new();
        draft.insert("type", Value::from("message"));
        draft.insert("role", Value::from("user"));
        draft.insert("parts", Value::Array(parts.into()));
        draft.insert("origin", origin.clone());
        draft.insert("synthetic", Value::Bool(true));
        draft.insert("complete", Value::Bool(true));
        draft.insert("raw", Value::Array(Vec::new().into()));
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from(agent.as_str()));
        fact.insert("item", Value::from(key));
        fact.insert("draft", Value::Object(draft));
        self.apply_facts(store, thread, &[Value::Object(fact)], at)
    }
}
