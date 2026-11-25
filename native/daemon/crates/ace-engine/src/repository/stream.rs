// SPDX-License-Identifier: Apache-2.0
//! `stream` (E5.3, `repository.ts:363`-`:412`): the live path's persistence half. E5.2 owns the
//! buffer and its flush; E5.3 owns the refusals, in the TypeScript's order, and the callbacks
//! the buffer runs (E5.3's token entries). Until E5.2 binds its port, the buffer call fails at
//! the call, naming E5.2.

use ace_json::Value;

use crate::repository::collaborators::FrameFacts;
use crate::{EngineError, EngineStore, State};

/// The most facts one live batch may carry (`repository.ts:367`).
pub const MAX_STREAM_FACTS: usize = 256;
/// The most bytes one live batch may carry (`:393`).
pub const MAX_STREAM_BYTES: f64 = 512.0 * 1024.0;

impl State {
    /// Whether the batch is a live one and was buffered.
    pub fn stream(
        &mut self,
        store: &EngineStore,
        id: &str,
        facts_json: &str,
        now: f64,
    ) -> Result<bool, EngineError> {
        let facts = Self::facts(facts_json)?;
        if facts.is_empty()
            || facts.len() > MAX_STREAM_FACTS
            || facts.iter().any(|fact| {
                !matches!(
                    fact.get("type").and_then(Value::as_str),
                    Some("item.delta") | Some("signal")
                )
            })
        {
            return Ok(false);
        }
        let snapshot = self.repo.require_state(store, id)?;
        let deadline = snapshot.borrow_mut().deadline(None);
        let (exit, observed, transport) = {
            let borrowed = snapshot.borrow();
            (
                borrowed.state.process_exit.is_some(),
                borrowed.state.status_observed_at,
                borrowed.state.last_transport_signal_at,
            )
        };
        if exit
            || observed.is_some_and(|at| now < at as f64)
            || transport.is_some_and(|at| now < at as f64)
            || deadline.is_some_and(|deadline| now >= deadline as f64)
        {
            return Ok(false);
        }
        {
            let borrowed = snapshot.borrow();
            for fact in &facts {
                let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
                if kind == "item.delta" {
                    let item = fact.get("item").and_then(Value::as_str).unwrap_or_default();
                    if borrowed.state.items.get(item).is_none()
                        && borrowed.state.items.get(item).is_none()
                    {
                        return Ok(false);
                    }
                }
                let agent = fact.get("agent").and_then(Value::as_str);
                match agent {
                    None => return Ok(false),
                    Some(agent) => {
                        if !borrowed.state.agents.contains_key(agent)
                            || ace_core::liveness::has_unresponsive_ancestor(&borrowed.state, agent)
                        {
                            return Ok(false);
                        }
                    }
                }
            }
        }
        let bytes = self.streamed_facts_bytes(facts_json)?;
        if bytes > MAX_STREAM_BYTES {
            return Ok(false);
        }
        store.prepare_live_write(bytes)?;
        let events = self.stream_facts(id, facts_json, now)?;
        let token = self.next_live_token();
        store.buffer_live_write(id, &events, now, token)?;
        Ok(true)
    }

    /// The token the buffer's persist and committed callbacks are keyed by (E5.2 owns the
    /// buffer; the callbacks are E5.3's, run as binding entries keyed by this number).
    fn next_live_token(&mut self) -> u64 {
        let token = self.repo.live_token + 1;
        self.repo.live_token = token;
        token
    }
}
