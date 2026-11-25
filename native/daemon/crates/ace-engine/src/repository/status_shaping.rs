// SPDX-License-Identifier: Apache-2.0
//! The failed statuses' shaped errors (`provider-facts.ts:211`-`:229`), split from the fold's
//! frame: the shaped status reaches the stored record, its settled status, and the failed run's
//! own `run.ended`.

use ace_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use super::collaborators::SessionFacts;
use super::fold::{kind, set, text_field};
use crate::snapshot::Snapshot;
use crate::{EngineError, State};

impl State {
    /// The failed statuses' shaped errors (`provider-facts.ts:211`-`:229`). The shaped status
    /// reaches the stored record, its settled status, and the failed run's own `run.ended`.
    pub(super) fn shape_failed_statuses(
        &mut self,
        snapshot: &Rc<RefCell<Snapshot>>,
        events: &mut [Value],
    ) -> Result<(), EngineError> {
        let failed: Vec<usize> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                kind(event) == "agent.status"
                    && event
                        .get("status")
                        .and_then(|status| status.get("state"))
                        .and_then(Value::as_str)
                        == Some("failed")
            })
            .map(|(index, _)| index)
            .collect();
        for index in failed {
            let Some(error) = events[index]
                .get("status")
                .and_then(|status| status.get("error"))
                .cloned()
            else {
                continue;
            };
            let provider = snapshot.borrow().state.config.provider.clone();
            let shaped = self.structured_error(error, &provider)?;
            if let Some(status) = events[index]
                .get_mut("status")
                .and_then(Value::as_object_mut)
            {
                status.insert("error", shaped.clone());
            }
            let shaped_status = events[index].get("status").cloned();
            let agent_id = text_field(&events[index], "agentId")
                .unwrap_or_default()
                .to_owned();
            let mut borrowed = snapshot.borrow_mut();
            let key = borrowed
                .state
                .indexes
                .agent_keys_by_id
                .get(&agent_id)
                .cloned();
            let Some(record) = key.and_then(|key| borrowed.state.agents.get_mut(&key)) else {
                continue;
            };
            let shaped_agent_status = shaped_status
                .as_ref()
                .and_then(|status| ace_json::from_value(status).ok());
            if let Some(status) = shaped_agent_status.clone() {
                record.agent.status = status;
            }
            if record.last_error.is_some()
                && let Ok(error) = ace_json::from_value(&shaped)
            {
                record.last_error = Some(error);
            }
            if record
                .process_settled_status
                .as_ref()
                .is_some_and(|status| status.state() == "failed")
                && let Some(status) = shaped_agent_status
            {
                record.process_settled_status = Some(status);
            }
            let Some(run) = record
                .last_run
                .clone()
                .and_then(|id| borrowed.state.runs.get_mut(&id))
            else {
                continue;
            };
            if run.state != "failed" {
                continue;
            }
            if let Ok(error) = ace_json::from_value(&shaped) {
                run.error = Some(error);
            }
            let run_id = run.id.clone();
            for event in events.iter_mut() {
                if kind(event) == "run.ended" && text_field(event, "runId") == Some(run_id.as_str())
                {
                    set(event, "error", shaped.clone());
                }
            }
        }
        Ok(())
    }
}
