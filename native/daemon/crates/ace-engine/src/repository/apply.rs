// SPDX-License-Identifier: Apache-2.0
//! `apply` (E5.3 step 6, `repository.ts:413`): the repository transaction around a fold. On any
//! error the thread is evicted (unless a live write is pending), then the error rethrown.

use std::cell::RefCell;
use std::rc::Rc;

use ace_core::state::ThreadState;
use ace_json::Value;

use super::fold::{kind, text_field};
use crate::snapshot::{Snapshot, touched::Touched};

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
            self.fold_frame(store, id, facts_json, now, generation)?
                .save(self, store, id, now)
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

/// The fold's changes, pending the queue event writes that precede the snapshot save.
pub(crate) struct FoldedFrame {
    snapshot: Rc<RefCell<Snapshot>>,
    payloads: String,
    touched: Touched,
    recovery_facts: Vec<Value>,
}

impl FoldedFrame {
    pub(super) fn new(
        snapshot: Rc<RefCell<Snapshot>>,
        facts: Vec<Value>,
        events: Vec<Value>,
    ) -> Self {
        let touched = Touched::values(&facts, &events);
        let payloads = ace_json::to_string(&Value::Array(events.into()));
        Self {
            snapshot,
            payloads,
            touched,
            recovery_facts: facts
                .into_iter()
                .filter(crate::recovery::observe::limit_signal)
                .collect(),
        }
    }

    pub(crate) fn save(
        self,
        state: &mut State,
        store: &EngineStore,
        id: &str,
        now: f64,
    ) -> Result<(), EngineError> {
        state.save(
            store,
            id,
            &self.snapshot,
            &self.payloads,
            now,
            &self.touched,
        )?;
        if !self.recovery_facts.is_empty()
            && let Some(core) = state.engine.upgrade()
        {
            crate::recovery::observe::observe_in(&core, state, id, &self.recovery_facts, now)?;
        }
        Ok(())
    }
}

pub(super) fn ended_root_run(state: &ThreadState, root: &str, events: &[Value]) -> bool {
    let Some(root) = state.agents.get(root) else {
        return false;
    };
    events.iter().any(|event| {
        kind(event) == "run.ended"
            && text_field(event, "runId")
                .and_then(|run_id| state.runs.get(run_id))
                .is_some_and(|run| run.agent_id == root.agent.id)
    })
}
