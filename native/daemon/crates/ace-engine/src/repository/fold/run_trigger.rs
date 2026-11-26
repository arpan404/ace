// SPDX-License-Identifier: Apache-2.0
//! `provider-facts.ts:131`-`:137`: the root's key, and why a root turn's run ended.

use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use crate::State;
use crate::snapshot::Snapshot;

impl State {
    pub(super) fn root_key(&self, snapshot: &Rc<RefCell<Snapshot>>) -> String {
        snapshot
            .borrow()
            .state
            .root_key
            .clone()
            .unwrap_or_else(|| "root".to_owned())
    }

    /// `provider-facts.ts:131`-`:137`: a root turn's run trigger says why it ended.
    pub(super) fn root_turn_trigger(
        &mut self,
        snapshot: &Rc<RefCell<Snapshot>>,
        fact: &Value,
    ) -> Option<String> {
        let borrowed = snapshot.borrow();
        let record = borrowed.state.agents.get(&self.root_key(snapshot))?;
        let run_id = match fact.get("nativeTurnId").and_then(Value::as_str) {
            Some(native) => record
                .native_runs
                .as_ref()
                .and_then(|runs| runs.get(native))
                .cloned(),
            None => record.active_run.clone(),
        }?;
        let run = borrowed.state.runs.get(&run_id)?;
        ["spawn", "parent_agent", "subagent_result", "schedule"]
            .contains(&run.trigger.as_str())
            .then(|| run.trigger.clone())
    }
}
