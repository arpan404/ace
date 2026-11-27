// SPDX-License-Identifier: Apache-2.0
//! `provider-facts.ts`: a settled interaction's facts fold into the same batch, in order.

use ace_core::reduce::FactBatch;
use ace_core::state::ApplyContext;
use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use super::StoreIds;
use super::helpers::{events_of, kind};
use crate::repository::collaborators::AccessFacts;
use crate::snapshot::Snapshot;
use crate::{EngineError, EngineStore, State};

impl State {
    pub(super) fn settle_interactions(
        &mut self,
        store: &EngineStore,
        id: &str,
        snapshot: &Rc<RefCell<Snapshot>>,
        batch: &mut FactBatch,
        events: &mut Vec<Value>,
        now: f64,
    ) -> Result<(), EngineError> {
        for index in 0..events.len() {
            if kind(&events[index]) != "interaction.closed" {
                continue;
            }
            let settled = self.interactions_closed(id, &mut events[index])?;
            let mut ids = StoreIds(store);
            let mut context = ApplyContext {
                now: now as i64,
                ids: &mut ids,
                resolving_interactions: None,
            };
            let mut core_events = Vec::new();
            let mut borrowed = snapshot.borrow_mut();
            for fact in settled {
                batch.apply(&mut borrowed.state, &fact, &mut context, &mut core_events);
            }
            events.extend(events_of(&core_events));
        }
        Ok(())
    }
}
