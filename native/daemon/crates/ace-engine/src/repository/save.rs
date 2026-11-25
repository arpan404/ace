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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::residency::cell_text;
    use crate::repository::testsupport::{Shell, header, home, message};
    use crate::snapshot::touched::Touched;

    fn setup(thread: &str) -> (std::sync::Arc<ace_store::Connection>, EngineStore, State) {
        let conn = home(thread, &header(thread));
        let store = Shell::store(&conn);
        let mut state = State::default();
        // The pass-through scaffold: this thread has no inputs, interactions or transitions, so
        // the unported collaborators' answers are the TypeScript's ("nothing to do") here.
        state.repo.probe_passthrough = true;
        (conn, store, state)
    }

    fn stored_text(conn: &std::sync::Arc<ace_store::Connection>, sql: &'static str) -> String {
        let row = stmt_cache::get_row(conn, sql, vec![])
            .unwrap()
            .unwrap_or_default();
        row.get("state")
            .and_then(cell_text)
            .unwrap_or_default()
            .to_owned()
    }

    fn record(
        conn: &std::sync::Arc<ace_store::Connection>,
        thread: &str,
        key: &str,
    ) -> Option<String> {
        let row = stmt_cache::get_row(
            conn,
            "SELECT value FROM engine_state_records WHERE thread_id=? AND section='items' AND key=?",
            vec![text(thread), text(key)],
        )
        .unwrap()?;
        row.get("value").and_then(cell_text).map(str::to_owned)
    }

    #[test]
    fn a_rejected_save_restores_the_header_and_the_message() {
        // `snapshot-rollback.process:72`: the save inside the refused transaction leaves no row.
        let (conn, store, mut state) = setup("rollback");
        let snapshot = state.repo.require_state(&store, "rollback").unwrap();
        {
            let mut borrowed = snapshot.borrow_mut();
            borrowed
                .items
                .write("item-1", message("item-1", "rollback", "kept"));
        }
        state
            .save(
                &store,
                "rollback",
                &snapshot,
                "[]",
                1.0,
                &Touched::default(),
            )
            .unwrap();
        let header_before = stored_text(
            &conn,
            "SELECT state FROM thread_state WHERE thread_id='rollback'",
        );
        let refused = store.atomic(|_tx| {
            let snapshot = state.repo.require_state(&store, "rollback")?;
            {
                let mut borrowed = snapshot.borrow_mut();
                borrowed
                    .items
                    .write("item-2", message("item-2", "rollback", "refused"));
            }
            state.save(
                &store,
                "rollback",
                &snapshot,
                "[]",
                2.0,
                &Touched::default(),
            )?;
            Err::<(), EngineError>(EngineError::Records("rejected".to_owned()))
        });
        assert!(refused.is_err());
        let header_after = stored_text(
            &conn,
            "SELECT state FROM thread_state WHERE thread_id='rollback'",
        );
        assert_eq!(header_after, header_before, "the header is unchanged");
        assert!(record(&conn, "rollback", "item-1").is_some());
        assert_eq!(
            record(&conn, "rollback", "item-2"),
            None,
            "the refused message was never stored"
        );
    }

    #[test]
    fn an_outer_rollback_discards_a_nested_save_with_an_unchanged_seq() {
        // `snapshot-rollback.process:98`: the nested save committed, its event sequence did not
        // change, and the outer rollback still discards it.
        let (conn, store, mut state) = setup("nested");
        store
            .atomic(|_tx| {
                let snapshot = state.repo.require_state(&store, "nested")?;
                {
                    let mut borrowed = snapshot.borrow_mut();
                    borrowed
                        .items
                        .write("item-1", message("item-1", "nested", "nested"));
                }
                state.save(&store, "nested", &snapshot, "[]", 1.0, &Touched::default())?;
                Err::<(), EngineError>(EngineError::Records("outer".to_owned()))
            })
            .unwrap_err();
        assert_eq!(record(&conn, "nested", "item-1"), None);
        assert_eq!(
            store.head_seq().unwrap(),
            0.0,
            "the sequence did not change"
        );
        // The next read sees the stored state, not the discarded snapshot.
        let snapshot = state.repo.require_state(&store, "nested").unwrap();
        assert!(snapshot.borrow().state.items.is_empty());
        assert!(store.rollback_generation().unwrap() > 0.0);
    }

    #[test]
    fn a_caught_savepoint_rollback_reloads_before_the_next_save() {
        // `snapshot-rollback.process:123`: a savepoint rollback caught inside a still-open outer
        // transaction bumps the generation, so the next save reloads first.
        let (conn, store, mut state) = setup("savepoint");
        store
            .atomic(|_tx| {
                let discarded = store.atomic(|_inner| {
                    Err::<(), EngineError>(EngineError::Records("savepoint".to_owned()))
                });
                assert!(discarded.is_err());
                let snapshot = state.repo.require_state(&store, "savepoint")?;
                {
                    let mut borrowed = snapshot.borrow_mut();
                    borrowed
                        .items
                        .write("item-1", message("item-1", "savepoint", "kept"));
                }
                state.save(
                    &store,
                    "savepoint",
                    &snapshot,
                    "[]",
                    2.0,
                    &Touched::default(),
                )
            })
            .unwrap();
        assert!(record(&conn, "savepoint", "item-1").is_some());
        assert!(store.rollback_generation().unwrap() > 0.0);
    }
}
