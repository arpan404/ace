// SPDX-License-Identifier: Apache-2.0
//! The fold's pre-loop load (`provider-facts.ts:32`): the lazy record sections and the stored
//! runs this batch names, so core folds onto the stored records.

use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use super::helpers::text_field;
use crate::snapshot::Snapshot;
use crate::{EngineError, State};

impl State {
    /// Load what this batch names: the touched sections, and a native turn id's stored run.
    pub(super) fn hydrate_facts(
        &mut self,
        snapshot: &Rc<RefCell<Snapshot>>,
        facts: &[Value],
    ) -> Result<(), EngineError> {
        {
            // The lazy sections are the one record cache: load what this batch names so the
            // core folds onto the stored records, then hand the changes back in `save`.
            let named = crate::snapshot::touched::Touched::values(facts, &[]);
            snapshot.borrow_mut().hydrate(&named)?;
            // A native turn id names a stored run: a replay of `turn.started` must find it.
            let turns: Vec<(String, String)> = facts
                .iter()
                .filter_map(|fact| {
                    Some((
                        text_field(fact, "agent")?.to_owned(),
                        text_field(fact, "nativeTurnId")?.to_owned(),
                    ))
                })
                .collect();
            for (agent, native) in turns {
                snapshot.borrow_mut().hydrate_native_run(&agent, &native)?;
            }
        }
        Ok(())
    }
}
