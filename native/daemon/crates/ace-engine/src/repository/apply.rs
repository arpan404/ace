// SPDX-License-Identifier: Apache-2.0
//! `apply` (E5.3 step 6, `repository.ts:413`): the repository transaction around a fold. On any
//! error the thread is evicted (unless a live write is pending), then the error rethrown.

use ace_json::Value;

use crate::{EngineError, EngineStore, State};

impl State {
    /// Fold one provider frame's facts into the thread and persist them.
    pub fn apply(
        &mut self,
        store: &EngineStore,
        id: &str,
        facts_json: &str,
        now: f64,
        generation: Option<f64>,
    ) -> Result<(), EngineError> {
        let outcome = store.atomic(|_tx| {
            let snapshot = self.repo.require_state(store, id)?;
            self.fold_frame(store, id, &snapshot, facts_json, now, generation)
        });
        if let Err(error) = outcome {
            let _ = self.repo.evict(store, id);
            return Err(error);
        }
        Ok(())
    }

    /// `apply`'s fact list, as the frame reads it.
    pub(crate) fn facts(json: &str) -> Result<Vec<Value>, EngineError> {
        let value =
            ace_json::parse(json).map_err(|error| EngineError::Records(error.to_string()))?;
        Ok(match value {
            Value::Array(items) => items.into_vec(),
            _ => Vec::new(),
        })
    }
}
