// SPDX-License-Identifier: Apache-2.0
//! The rest of `transcript-inputs.ts` (E5.4c): an accepted send, its transcript item and its
//! journal entry, an item's removal, and the naming prompt the person's first message asks for.
//! The run binding itself is 4b's (`inputs::runs`).
//!
//! Every function here writes inside the caller's transaction: the receipt's, or the delivery's.
//! The naming prompt is not an effect of the transaction but of its commit, so it goes on the
//! after-commit queue and a rolled-back receipt never names its thread.

use ace_json::Value;

use crate::executor::Deferred;
use crate::inputs::journal;
use crate::inputs::origin::{input_origin, person_input};
use crate::inputs::provisional_title::{UNTITLED_THREAD, provisional_title};
use crate::inputs::runs::bind_item_run;
use crate::snapshot::touched::Touched;
use crate::{EngineError, EngineStore, State};
use std::rc::Rc;

/// The thread row as `store.getThread` gives it, for the fields an accepted input reads.
struct ThreadRow {
    title: Option<String>,
    title_source: Option<String>,
    has_sent_message: bool,
}

fn thread_row(store: &EngineStore, id: &str) -> Result<ThreadRow, EngineError> {
    let Some(text) = store.get_thread(id)? else {
        return Ok(ThreadRow {
            title: None,
            title_source: None,
            has_sent_message: false,
        });
    };
    let row = ace_json::parse(&text).map_err(|error| EngineError::Records(error.to_string()))?;
    Ok(ThreadRow {
        title: row.get("title").and_then(Value::as_str).map(str::to_owned),
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
fn input_payload(command: &Value) -> Option<(&str, &Value, &str)> {
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
    fn input_agent(&mut self, store: &EngineStore, thread: &str) -> Result<String, EngineError> {
        let snapshot = self.repo.require_state(store, thread)?;
        let root = snapshot.borrow().state.root_key.clone();
        Ok(root.unwrap_or_else(|| "root".to_owned()))
    }

    /// The origin a command's input has: the journal's if the input was accepted, else the one
    /// the command itself implies.
    fn accepted_origin(
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

    /// `acceptInput` (`:52`): a send the daemon accepts may name the thread, and the journal
    /// learns its origin. Its transcript item waits for delivery (ADR 0065).
    pub fn accept_input(
        &mut self,
        store: &EngineStore,
        command: &Value,
        thread: &str,
        at: f64,
    ) -> Result<(), EngineError> {
        let Some((id, parts, _kind)) = input_payload(command) else {
            return Ok(());
        };
        let key = format!("input:{id}");
        let origin = self.accepted_origin(store, thread, &key, command)?;
        let row = thread_row(store, thread)?;
        let person = person_input(&origin);
        let provisional = matches!(row.title_source.as_deref(), None | Some("provisional"));
        if person && provisional && row.title.as_deref() == Some("New thread") {
            let title = provisional_title(
                parts
                    .as_array()
                    .map(|array| array.as_slice())
                    .unwrap_or(&[]),
                UNTITLED_THREAD,
            );
            let mut updated = ace_json::Map::new();
            updated.insert("type", Value::from("thread.updated"));
            updated.insert("title", Value::from(title));
            updated.insert("titleSource", Value::from("provisional"));
            let events = Value::Array(vec![Value::Object(updated)].into());
            store.write_events(thread, &ace_json::to_string(&events), at)?;
        }
        // The person's send makes the thread a task now, even while it waits in a held queue.
        if person && !row.has_sent_message {
            let mut changes = ace_json::Map::new();
            changes.insert("hasSentMessage", Value::Bool(true));
            let mut updated = ace_json::Map::new();
            updated.insert("type", Value::from("thread.client.updated"));
            updated.insert("changes", Value::Object(changes));
            let events = Value::Array(vec![Value::Object(updated)].into());
            store.write_events(thread, &ace_json::to_string(&events), at)?;
        }
        let parts = parts
            .as_array()
            .map(|array| array.as_slice())
            .unwrap_or(&[]);
        journal::register(store.conn(), thread, &key, parts, &origin)
    }

    /// `admitInput` (`:90`): the engine takes an accepted send out of the queue to deliver it.
    pub fn admit_input(
        &mut self,
        store: &EngineStore,
        command: &Value,
        thread: &str,
        run: Option<&str>,
        at: f64,
    ) -> Result<(), EngineError> {
        let Some((id, _parts, _kind)) = input_payload(command) else {
            return Ok(());
        };
        let key = format!("input:{id}");
        let accepted = self.accepted_origin(store, thread, &key, command)?;
        let steered =
            run.is_some() && accepted.get("kind").and_then(Value::as_str) == Some("person");
        let origin = if steered {
            let mut origin = accepted.clone();
            if let Some(object) = origin.as_object_mut() {
                object.insert("kind", Value::from("steer"));
            }
            journal::restamp(store.conn(), thread, &key, &origin)?;
            origin
        } else {
            accepted
        };
        journal::attach_run(store.conn(), thread, &key, run)?;
        if origin.get("kind").and_then(Value::as_str) == Some("subagent_result")
            && crate::inputs::ace::get(store.conn(), thread, id)?.is_some()
        {
            return Ok(());
        }
        let existing = self.input_item(store, thread, &key)?;
        let replace = match &existing {
            None => true,
            Some(item) => steered && is_unsteered_message(item),
        };
        if replace {
            self.upsert_input(store, command, thread, at)?;
        }
        let snapshot = self.repo.require_state(store, thread)?;
        let update = {
            let mut borrowed = snapshot
                .try_borrow_mut()
                .map_err(|_| EngineError::Reentrant)?;
            bind_item_run(&mut borrowed.state, &key, run)
        };
        if let Some(update) = update {
            let payloads = Value::Array(vec![update].into());
            let touched = Touched::default();
            self.save(
                store,
                thread,
                &snapshot,
                &ace_json::to_string(&payloads),
                at,
                &touched,
            )?;
        }
        Ok(())
    }

    /// A queued message the person edits (`:116`): a bubble left by an earlier attempt shows
    /// the new text.
    pub fn revise_input(
        &mut self,
        store: &EngineStore,
        command: &Value,
        thread: &str,
        at: f64,
    ) -> Result<(), EngineError> {
        let Some(id) = command.get("id").and_then(Value::as_str) else {
            return Ok(());
        };
        if self
            .input_item(store, thread, &format!("input:{id}"))?
            .is_some()
        {
            self.upsert_input(store, command, thread, at)?;
        }
        Ok(())
    }

    /// `upsertInput` (`:125`): the input's item, in the person's own words.
    fn upsert_input(
        &mut self,
        store: &EngineStore,
        command: &Value,
        thread: &str,
        at: f64,
    ) -> Result<(), EngineError> {
        let Some((id, parts, _kind)) = input_payload(command) else {
            return Ok(());
        };
        let key = format!("input:{id}");
        let origin = self.accepted_origin(store, thread, &key, command)?;
        let agent = self.input_agent(store, thread)?;
        let mut draft = ace_json::Map::new();
        draft.insert("type", Value::from("message"));
        draft.insert("role", Value::from("user"));
        draft.insert("parts", parts.clone());
        draft.insert("origin", origin.clone());
        draft.insert("synthetic", Value::Bool(!person_input(&origin)));
        draft.insert("complete", Value::Bool(true));
        draft.insert("raw", Value::Array(Vec::new().into()));
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from(agent.as_str()));
        fact.insert("item", Value::from(key.as_str()));
        fact.insert("draft", Value::Object(draft));
        self.apply_facts(store, thread, &[Value::Object(fact)], at)
    }

    /// The item under `key`, loaded on demand, as JSON.
    fn input_item(
        &mut self,
        store: &EngineStore,
        thread: &str,
        key: &str,
    ) -> Result<Option<Value>, EngineError> {
        let snapshot = self.repo.require_state(store, thread)?;
        let item = {
            let mut borrowed = snapshot
                .try_borrow_mut()
                .map_err(|_| EngineError::Reentrant)?;
            let mut touched = Touched::default();
            touched.items.insert(key.to_owned());
            borrowed.hydrate(&touched)?;
            borrowed.state.items.get(key).cloned()
        };
        let Some(item) = item else {
            return Ok(None);
        };
        Ok(ace_json::ser::to_string(&item)
            .ok()
            .and_then(|text| ace_json::parse(&text).ok()))
    }

    /// `notifyNamingPrompt` (`:221`): the person's first message hands its text to title
    /// generation, once, and only after the receipt committed.
    pub fn notify_naming_prompt(
        &mut self,
        store: &EngineStore,
        command: &Value,
        thread: &str,
    ) -> Result<(), EngineError> {
        let Some((id, parts, _kind)) = input_payload(command) else {
            return Ok(());
        };
        let key = format!("input:{id}");
        let origin = self.accepted_origin(store, thread, &key, command)?;
        if !person_input(&origin) {
            return Ok(());
        }
        let row = thread_row(store, thread)?;
        if row.title_source.as_deref() != Some("provisional")
            || row.title.as_deref() == Some(UNTITLED_THREAD)
        {
            return Ok(());
        }
        let title = provisional_title(
            parts
                .as_array()
                .map(|array| array.as_slice())
                .unwrap_or(&[]),
            UNTITLED_THREAD,
        );
        if row.title.as_deref() != Some(title.as_str()) {
            return Ok(());
        }
        let Some(core) = self.engine.upgrade() else {
            return Ok(());
        };
        let json = ace_json::to_string(parts);
        let thread = thread.to_owned();
        let ask = Rc::clone(&core);
        core.defer(Deferred::Run(Box::new(move || {
            ask.ports.on_naming_prompt(&thread, &json)
        })));
        Ok(())
    }
}

/// A message without a steer's origin: a steer re-creates it as a steer's bubble
/// (`transcript-inputs.ts:107`).
fn is_unsteered_message(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("message")
        && item
            .get("origin")
            .and_then(|origin| origin.get("kind"))
            .and_then(Value::as_str)
            != Some("steer")
}
