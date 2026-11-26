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
use crate::inputs::item_write::{input_payload, thread_row};
use crate::inputs::journal;
use crate::inputs::origin::person_input;
use crate::inputs::provisional_title::{UNTITLED_THREAD, provisional_title};
use crate::inputs::runs::bind_item_run;
use crate::snapshot::touched::Touched;
use crate::{EngineError, EngineStore, State};
use std::rc::Rc;

impl State {
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
        // `(titleSource === "provisional" || !titleSource)`: an empty source is falsy too.
        let provisional = matches!(
            row.title_source.as_deref(),
            None | Some("") | Some("provisional")
        );
        if person
            && provisional
            && row
                .title
                .as_ref()
                .is_some_and(|title| title == UNTITLED_THREAD)
        {
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
            // A commit forgets the transcript, and an upsert commits: read the item and the root
            // back before the binding asks for them.
            let root = borrowed.state.root_key.clone();
            let mut touched = Touched::default();
            touched.items.insert(key.clone());
            if let Some(root) = root {
                touched.agents.insert(root);
            }
            borrowed.hydrate(&touched)?;
            bind_item_run(&mut borrowed.state, &key, run)
        };
        if let Some(update) = update {
            let payloads = Value::Array(vec![update].into());
            // The binding changed the item in the state: the save writes its record.
            let mut touched = Touched::default();
            touched.items.insert(key.clone());
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
            let root = borrowed.state.root_key.clone();
            let mut touched = Touched::default();
            touched.items.insert(key.to_owned());
            // The run binding checks the item's agent against the root, which is a record too.
            if let Some(root) = root {
                touched.agents.insert(root);
            }
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
            || row
                .title
                .as_ref()
                .is_some_and(|title| title == UNTITLED_THREAD)
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
        if row.title.as_ref() != Some(&title) {
            return Ok(());
        }
        let Some(core) = self.engine.upgrade() else {
            return Ok(());
        };
        let json = ace_json::to_string(parts);
        let thread = thread.to_owned();
        let ask = Rc::clone(&core);
        // After publication, not before it: the receipt's thread is readable when it runs.
        core.defer(Deferred::AfterPublish(Box::new(move || {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home, message};

    /// The fixture header with a root key, so the snapshot knows which agent is its root.
    fn rooted_header() -> String {
        header("t").replace(
            "\"initialRoot\":{\"agent\":\"root\"",
            "\"rootKey\":\"root\",\"initialRoot\":{\"agent\":\"root\"",
        )
    }

    #[test]
    fn a_retried_delivery_binds_the_item_an_earlier_attempt_left_on_a_cold_snapshot() {
        let conn = home("t", &rooted_header());
        // The root and its input are stored rows, not part of the header.
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'root', {})",
            r#"'{"agent":{"id":"root","threadId":"t","origin":"root","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":1},"activity":"idle","lastSignalAt":2}'"#
        ))
        .expect("agent");
        let item = ace_json::ser::to_string(&message("item-1", "t", "hi")).expect("item");
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'items', 'input:cmd', '{}')",
            item.replace('\'', "''")
        ))
        .expect("item row");
        conn.exec(
            "INSERT INTO engine_inputs(thread_id,item_key,signature,origin) VALUES ('t','input:cmd','s','{\"kind\":\"person\"}')",
        )
        .expect("journal");

        let store = Shell::store(&conn);
        let mut state = State::default();
        // The save's own collaborator stubs are E5.7's and E5.9's, not this read.
        state.repo.probe_passthrough = true;
        let snapshot = state.repo.require_state(&store, "t").expect("snapshot");
        assert!(
            snapshot.borrow().state.items.is_empty(),
            "a cold snapshot holds no transcript until a read loads one"
        );
        let command = ace_json::parse(
            r#"{"id":"cmd","payload":{"type":"thread.send","threadId":"t","input":[{"type":"text","text":"hi"}]}}"#,
        )
        .expect("command");
        state
            .admit_input(&store, &command, "t", Some("run-1"), 10.0)
            .expect("admit");
        let item = snapshot
            .borrow_mut()
            .items
            .read("input:cmd")
            .expect("read")
            .expect("the earlier item is still the key's item");
        let ace_core::items::Item::Message { base, .. } = item else {
            panic!("the earlier item is a message");
        };
        assert_eq!(base.run_id.as_deref(), Some("run-1"), "the run is bound");
    }
}
