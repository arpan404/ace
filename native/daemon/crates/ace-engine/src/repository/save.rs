// SPDX-License-Identifier: Apache-2.0
//! `save` (E5.3 step 6, `repository.ts:294`-`:333`): provenance, readiness, `retainChanges`,
//! the store's `writeEvents` (Decision 1), the header upsert, the snapshot's flush, and the
//! residency bookkeeping. One `EngineStore::atomic`, no state or snapshot borrow held across a
//! port: every borrow below is dropped before the next port call.

use ace_json::Value;
use ace_store::{stmt_cache, stmt_cache::Row};
use std::cell::RefCell;
use std::rc::Rc;

use crate::repository::collaborators::{MoveFacts, Selection, SessionFacts};
use crate::repository::provenance;
use crate::repository::residency::{cell_int, integer, text};
use crate::snapshot::Snapshot;
use crate::{EngineError, EngineStore, State};

pub const UPSERT_STATE: &str = "INSERT INTO thread_state VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state, seq=excluded.seq";

impl State {
    /// Save `snapshot`'s state and its `payloads` (`:294`). Inside the store's transaction.
    pub fn save(
        &mut self,
        store: &EngineStore,
        id: &str,
        snapshot: &Rc<RefCell<Snapshot>>,
        payloads_json: &str,
        at: f64,
        touched: &crate::snapshot::touched::Touched,
    ) -> Result<(), EngineError> {
        store.atomic(|tx| {
            self.repo.sync(store)?;
            let mut payloads = parse_payloads(payloads_json)?;
            let needs_source = payloads.iter().any(|payload| {
                matches!(
                    payload.get("type").and_then(Value::as_str),
                    Some("run.started") | Some("item.created") | Some("item.updated")
                )
            });
            if needs_source {
                self.capture_sources(id, snapshot, &mut payloads)?;
            }
            {
                let borrowed = snapshot.borrow();
                self.readiness_capture(&borrowed.state, &payloads)?;
            }
            snapshot.borrow_mut().adopt(touched)?;
            snapshot.borrow_mut().retain_changes(&payloads);
            let events_json = ace_json::to_string(&Value::Array(payloads.into()));
            // The store's writer owns every event row (Decision 1).
            store.write_events(id, &events_json, at)?;
            let header = snapshot.borrow().header()?;
            let seq = store.head_seq()? as i64;
            stmt_cache::run(
                tx.conn(),
                UPSERT_STATE,
                vec![text(id), text(&header), integer(seq)],
            )?;
            snapshot.borrow_mut().flush()?;
            self.repo.stamp(snapshot, seq);
            self.repo.retire(id, snapshot);
            self.repo
                .snapshots
                .insert(id.to_owned(), Rc::clone(snapshot));
            self.repo.trim(store)?;
            Ok(())
        })
    }

    /// `setSilenceMs` (`repository.ts:236`): a save inside the transaction.
    pub fn set_silence_ms(
        &mut self,
        store: &EngineStore,
        id: &str,
        silence_ms: f64,
        at: f64,
    ) -> Result<bool, EngineError> {
        let Some(snapshot) = self.repo.state(store, id)? else {
            return Ok(false);
        };
        if !snapshot.borrow_mut().set_silence_ms(silence_ms) {
            return Ok(false);
        }
        self.save(
            store,
            id,
            &snapshot,
            "[]",
            at,
            &crate::snapshot::touched::Touched::default(),
        )?;
        Ok(true)
    }

    /// `captureExecutionSources` (`repository.ts:304`-`:319`).
    fn capture_sources(
        &mut self,
        id: &str,
        snapshot: &Rc<RefCell<Snapshot>>,
        payloads: &mut [Value],
    ) -> Result<(), EngineError> {
        let session = self.session(id)?;
        let selection = match self.transitions_get(id)? {
            Some(selection) => selection,
            None => Selection {
                provider: Some(snapshot.borrow().state.config.provider.clone()),
                model: session.model.clone(),
                instance_id: None,
            },
        };
        provenance::capture(
            &mut snapshot.borrow_mut().state,
            payloads,
            &selection,
            session.native_session_id.as_deref(),
        );
        Ok(())
    }
}

/// The payloads a save writes: an array of protocol events.
fn parse_payloads(json: &str) -> Result<Vec<Value>, EngineError> {
    let value = ace_json::parse(json).map_err(|error| EngineError::Records(error.to_string()))?;
    match value {
        Value::Array(items) => Ok(items.into_vec()),
        _ => Ok(Vec::new()),
    }
}

/// The row's `seq`, for a test that reopens a home.
pub fn stored_seq(row: &Row) -> i64 {
    row.get("seq").and_then(cell_int).unwrap_or(0)
}
