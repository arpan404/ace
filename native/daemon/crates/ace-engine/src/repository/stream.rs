// SPDX-License-Identifier: Apache-2.0
//! `stream` (E5.3, `repository.ts:363`-`:412`): the live path's persistence half. E5.2 owns the
//! buffer and its flush; E5.3 owns the refusals, in the TypeScript's order, and the callbacks
//! the buffer runs by token (step 8): `live_persist`, `live_committed` and `quarantined`.

use std::cell::RefCell;
use std::rc::Rc;

use ace_json::Value;

use crate::repository::collaborators::FrameFacts;
use crate::{EngineError, EngineStore, State};

/// The most facts one live batch may carry (`repository.ts:367`).
pub const MAX_STREAM_FACTS: usize = 256;
/// The most bytes one live batch may carry (`:393`).
pub const MAX_STREAM_BYTES: f64 = 512.0 * 1024.0;

/// A live batch that passed every refusal, ready to be buffered: its events, the token its
/// snapshot is pinned under, and the snapshot itself.
pub struct Prepared {
    pub snapshot: Rc<RefCell<crate::snapshot::Snapshot>>,
    pub events: String,
    pub token: u64,
    pub bytes: f64,
}

impl State {
    /// The refusals and the fold, with no port called: the buffer is entered outside the state
    /// borrow, because buffering can flush and the flush re-enters the engine.
    pub fn prepare_stream(
        &mut self,
        store: &EngineStore,
        id: &str,
        facts_json: &str,
        now: f64,
    ) -> Result<Option<Prepared>, EngineError> {
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
            return Ok(None);
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
            return Ok(None);
        }
        {
            // The item is a section record: a committed batch keeps no transcript in the state,
            // so the check reads the item through its section, as the TypeScript's proxy does.
            let items: Vec<String> = facts
                .iter()
                .filter(|fact| fact.get("type").and_then(Value::as_str) == Some("item.delta"))
                .filter_map(|fact| fact.get("item").and_then(Value::as_str))
                .map(str::to_owned)
                .collect();
            for item in items {
                let known = {
                    let mut borrowed = snapshot.borrow_mut();
                    if !borrowed.state.items.contains_key(&item)
                        && let Some(stored) = borrowed.items.read(&item)?
                    {
                        borrowed.state.items.insert(item.clone(), stored);
                    }
                    borrowed.state.items.contains_key(&item)
                };
                if !known {
                    return Ok(None);
                }
            }
            let borrowed = snapshot.borrow();
            for fact in &facts {
                match fact.get("agent").and_then(Value::as_str) {
                    None => return Ok(None),
                    Some(agent) => {
                        if !borrowed.state.agents.contains_key(agent)
                            || ace_core::liveness::has_unresponsive_ancestor(&borrowed.state, agent)
                        {
                            return Ok(None);
                        }
                    }
                }
            }
        }
        let bytes = self.streamed_facts_bytes(facts_json)?;
        if bytes > MAX_STREAM_BYTES {
            return Ok(None);
        }
        let events = self.stream_facts(store, id, facts_json, now)?;
        let token = self.next_live_token();
        Ok(Some(Prepared {
            snapshot,
            events,
            token,
            bytes,
        }))
    }

    /// The buffer's `persist(token)` (`native-writer/live.ts:196`): the pinned snapshot's rows,
    /// inside the flush's transaction.
    pub fn live_persist(&mut self, token: u64) -> Result<(), EngineError> {
        let Some(snapshot) = self.repo.live.get(&token).cloned() else {
            return Ok(());
        };
        snapshot.borrow_mut().persist()
    }

    /// The buffer's `committed(token)` (`:196`): the snapshot's overlay clears, its stored `seq`
    /// is the commit's head seq, and it is stamped at the current generation.
    pub fn live_committed(&mut self, store: &EngineStore, token: u64) -> Result<(), EngineError> {
        let Some(snapshot) = self.repo.live.remove(&token) else {
            return Ok(());
        };
        let thread = snapshot.borrow().state.thread_id.clone();
        snapshot.borrow_mut().committed();
        let seq = store.head_seq()? as i64;
        self.repo.stamp(&snapshot, seq);
        self.repo.retire(&thread, &snapshot);
        self.repo.snapshots.insert(thread, Rc::clone(&snapshot));
        self.repo.trim(store)?;
        Ok(())
    }

    /// The store's quarantine notification (`store-stream.ts:272`): the pin is already removed,
    /// so the snapshot is evicted and released whether or not an actor exists.
    pub fn quarantined(&mut self, store: &EngineStore, thread: &str) -> Result<(), EngineError> {
        self.repo
            .live
            .retain(|_, snapshot| snapshot.borrow().state.thread_id != thread);
        self.repo.quarantined(store, thread)
    }

    /// The token the buffer's persist and committed callbacks are keyed by (E5.2 owns the
    /// buffer; the callbacks are E5.3's, run as binding entries keyed by this number).
    fn next_live_token(&mut self) -> u64 {
        let token = self.repo.live_token + 1;
        self.repo.live_token = token;
        token
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_buffered_delta_settles_the_snapshot_its_token_pinned() {
        // The live path: a delta is buffered, the flush's `persist` writes its patch, and
        // `committed` clears the pin and records the commit (E5.3 step 8).
        let conn = home("stream", &header("stream"));
        let (store, shell) = Shell::store_with_controls(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        state
            .apply(
                &store,
                "stream",
                r#"[{"type":"turn.started","agent":"root","trigger":"user"},{"type":"item.upsert","agent":"root","item":"item-1","draft":{"type":"message","role":"assistant","parts":[{"type":"text","text":""}],"complete":false}}]"#,
                1.0,
                None,
            )
            .unwrap();
        let prepared = state
            .prepare_stream(
                &store,
                "stream",
                r#"[{"type":"item.delta","agent":"root","item":"item-1","field":"text","append":" more"}]"#,
                2.0,
            )
            .unwrap()
            .expect("the delta took the live path");
        let token = prepared.token;
        assert_eq!(
            shell.buffered.borrow().len(),
            0,
            "the fold itself calls no buffer port"
        );
        state.repo.live.insert(token, Rc::clone(&prepared.snapshot));
        assert!(
            state.repo.live.contains_key(&token),
            "the token pins its snapshot"
        );
        state.live_persist(token).unwrap();
        let row = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT patch FROM engine_state_appends WHERE thread_id='stream' AND key='item-1'",
            vec![],
        )
        .unwrap()
        .expect("the append the flush persisted");
        assert!(
            matches!(row.get("patch"), Some(ace_store::Value::Text(text)) if text.contains(" more"))
        );
        state.live_committed(&store, token).unwrap();
        assert!(!state.repo.live.contains_key(&token), "the pin is settled");
        assert!(state.repo.holds("stream"));
    }
}
