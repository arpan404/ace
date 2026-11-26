// SPDX-License-Identifier: Apache-2.0
//! `transcript-inputs.ts`'s removals (E5.4c): an input's item leaves the transcript and its
//! journal entry leaves delivery, in the caller's transaction.

use ace_json::Value;

use crate::inputs::journal;
use crate::snapshot::touched::Touched;
use crate::{EngineError, EngineStore, State};

impl State {
    /// `removeInput` (`:232`): takes an input's item out of the transcript.
    pub fn remove_input(
        &mut self,
        store: &EngineStore,
        thread: &str,
        command_id: &str,
        at: f64,
    ) -> Result<(), EngineError> {
        self.remove_input_item(store, thread, &format!("input:{command_id}"), at)
    }

    /// `removeInputItem` (`:242`): the item leaves the transcript, and its journal entry leaves
    /// delivery.
    pub fn remove_input_item(
        &mut self,
        store: &EngineStore,
        thread: &str,
        key: &str,
        at: f64,
    ) -> Result<(), EngineError> {
        journal::invalidate(store.conn(), thread, key)?;
        let snapshot = self.repo.require_state(store, thread)?;
        let mut borrowed = snapshot
            .try_borrow_mut()
            .map_err(|_| EngineError::Reentrant)?;
        let mut touched = Touched::default();
        touched.items.insert(key.to_owned());
        borrowed.hydrate(&touched)?;
        let Some(item_id) = borrowed
            .state
            .items
            .get(key)
            .map(|item| item.id().to_owned())
        else {
            return Ok(());
        };
        borrowed.state.items.shift_remove(key);
        borrowed.items.delete(key);
        drop(borrowed);
        let mut event = ace_json::Map::new();
        event.insert("type", Value::from("item.deleted"));
        event.insert("itemId", Value::from(item_id.as_str()));
        let payloads = Value::Array(vec![Value::Object(event)].into());
        let touched = Touched::default();
        self.save(
            store,
            thread,
            &snapshot,
            &ace_json::to_string(&payloads),
            at,
            &touched,
        )
    }
}
