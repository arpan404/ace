// SPDX-License-Identifier: Apache-2.0
//! The resident-snapshot cache and the rollback sync (E5.3 steps 6 and 8,
//! `repository.ts:200`-`:254`).

use ace_store::{Value, stmt_cache};
use std::cell::RefCell;
use std::rc::Rc;

use super::Repo;
use crate::snapshot::{Snapshot, decode};
use crate::{EngineError, EngineStore};

const SELECT_STATE: &str = "SELECT state,seq FROM thread_state WHERE thread_id = ?";

impl Repo {
    /// The stored state and `seq` of one thread, outside a transaction (`repository.ts:210`):
    /// reading `thread_state` must not flush the live buffer.
    pub(crate) fn stored_state(
        &self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<(String, i64)>, EngineError> {
        let row = stmt_cache::get_row(store.conn(), SELECT_STATE, vec![text(id)])?;
        let Some(row) = row else {
            return Ok(None);
        };
        let state = row
            .get("state")
            .and_then(cell_text)
            .unwrap_or_default()
            .to_owned();
        let seq = row.get("seq").and_then(cell_int).unwrap_or(0);
        Ok(Some((state, seq)))
    }

    /// `syncSnapshots` (`:200`), with the generation kept **per snapshot**: every resident
    /// snapshot without a live pin whose stamp is older than the current generation is dropped
    /// and released; the survivors it checked are stamped. A pinned snapshot is skipped and
    /// keeps its old stamp, so a later sync checks it again.
    pub fn sync(&mut self, store: &EngineStore) -> Result<(), EngineError> {
        let generation = store.rollback_generation()?;
        // Every resident snapshot is checked, even when the generation did not move since the
        // last sync: a snapshot spared once because a live write pinned it must be checked again
        // once that pin is gone, or a rolled-back state can stay resident forever.
        for id in self.snapshots.keys().cloned().collect::<Vec<_>>() {
            if store.has_live_write(&id)? {
                continue;
            }
            let Some(snapshot) = self.snapshots.get(&id) else {
                continue;
            };
            let key = Repo::key(snapshot);
            if self.stamps.get(&key).copied().unwrap_or(0.0) < generation {
                self.drop(id);
            } else {
                self.stamps.insert(key, generation);
            }
        }
        self.generation = generation;
        Ok(())
    }

    /// `state` (`:206`): the resident snapshot, rebuilt when the stored `seq` differs, moved to
    /// newest, and trimmed.
    pub fn state(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Option<Rc<RefCell<Snapshot>>>, EngineError> {
        if store.has_live_write(id)? {
            return Ok(self.snapshots.get(id).cloned());
        }
        self.sync(store)?;
        let Some((json, seq)) = self.stored_state(store, id)? else {
            self.drop(id.to_owned());
            return Ok(None);
        };
        let rebuild = match self.snapshots.get(id) {
            Some(snapshot) => self.seqs.get(&Repo::key(snapshot)).copied() != Some(seq),
            None => true,
        };
        if rebuild {
            let (state, original) = decode::decode_header(&json)?;
            let snapshot = Rc::new(RefCell::new(Snapshot::new(
                std::sync::Arc::clone(store.conn()),
                &self.budget,
                state,
                Some(original),
            )?));
            let key = Repo::key(&snapshot);
            self.seqs.insert(key, seq);
            self.stamps.insert(key, self.generation);
            self.retire(id, &snapshot);
            self.snapshots.insert(id.to_owned(), snapshot);
        } else if let Some(snapshot) = self.snapshots.shift_remove(id) {
            self.snapshots.insert(id.to_owned(), snapshot);
        }
        self.trim(store)?;
        Ok(self.snapshots.get(id).cloned())
    }

    /// `requireState` (`:249`): `Missing engine state` when there is no row.
    pub fn require_state(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Rc<RefCell<Snapshot>>, EngineError> {
        self.state(store, id)?.ok_or(EngineError::MissingState)
    }

    /// `deadline` (`:232`).
    pub fn deadline(
        &mut self,
        store: &EngineStore,
        id: &str,
        provider_deadline: Option<i64>,
    ) -> Result<Option<i64>, EngineError> {
        let snapshot = self.require_state(store, id)?;
        let deadline = snapshot.borrow_mut().deadline(provider_deadline);
        Ok(deadline)
    }

    /// `evict` (`:245`): never while a live write is pending.
    pub fn evict(&mut self, store: &EngineStore, id: &str) -> Result<(), EngineError> {
        if store.has_live_write(id)? {
            return Ok(());
        }
        self.drop(id.to_owned());
        Ok(())
    }

    /// A quarantined buffered write (step 8): the pin is already removed when this runs, so the
    /// snapshot is evicted and released whether or not an actor exists. Its overlay holds
    /// deltas that were never stored, at the same `seq` as the stored row.
    pub fn quarantined(&mut self, store: &EngineStore, id: &str) -> Result<(), EngineError> {
        self.evict(store, id)
    }

    /// `trim` (`:334`): the oldest snapshot without a live write leaves.
    pub(crate) fn trim(&mut self, store: &EngineStore) -> Result<(), EngineError> {
        if self.snapshots.len() <= self.capacity {
            return Ok(());
        }
        for id in self.snapshots.keys().cloned().collect::<Vec<_>>() {
            if store.has_live_write(&id)? {
                continue;
            }
            self.drop(id);
            break;
        }
        Ok(())
    }

    /// Every snapshot that leaves the map is released (`:345`): its cached entries are
    /// unreachable once it goes, and their decorated values point back at it.
    pub(crate) fn drop(&mut self, id: String) {
        let Some(snapshot) = self.snapshots.shift_remove(&id) else {
            return;
        };
        let key = Repo::key(&snapshot);
        self.seqs.remove(&key);
        self.stamps.remove(&key);
        snapshot.borrow_mut().release();
    }

    /// Release the thread's resident snapshot when `next` is about to replace it (`:352`).
    pub(crate) fn retire(&mut self, id: &str, next: &Rc<RefCell<Snapshot>>) {
        let Some(previous) = self.snapshots.get(id) else {
            return;
        };
        if Rc::ptr_eq(previous, next) {
            return;
        }
        let key = Repo::key(previous);
        self.seqs.remove(&key);
        self.stamps.remove(&key);
        previous.borrow_mut().release();
    }

    /// Record a snapshot as valid at the current generation, after its rows matched its state
    /// (a commit, step 8).
    pub(crate) fn stamp(&mut self, snapshot: &Rc<RefCell<Snapshot>>, seq: i64) {
        let key = Repo::key(snapshot);
        self.seqs.insert(key, seq);
        self.stamps.insert(key, self.generation);
    }
}

/// A row cell as text.
pub(crate) fn cell_text(value: &Value) -> Option<&str> {
    match value {
        Value::Text(text) => Some(text.as_str()),
        _ => None,
    }
}

/// A row cell as an integer.
pub(crate) fn cell_int(value: &Value) -> Option<i64> {
    match value {
        Value::Integer(number) => Some(*number),
        _ => None,
    }
}

pub(crate) fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

pub(crate) fn integer(value: i64) -> Value {
    Value::Integer(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::RecordBudget;
    use crate::repository::testsupport::{header, home};
    use crate::snapshot::decode::decode_header;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn resident(
        conn: &std::sync::Arc<ace_store::Connection>,
        budget: &Rc<RefCell<RecordBudget>>,
        thread: &str,
    ) -> Rc<RefCell<Snapshot>> {
        let (state, original) = decode_header(&header(thread)).unwrap();
        Rc::new(RefCell::new(
            Snapshot::new(std::sync::Arc::clone(conn), budget, state, Some(original)).unwrap(),
        ))
    }

    #[test]
    fn a_dropped_snapshot_is_freed_not_kept_in_the_cache() {
        // `snapshot-retention.process`: 1,500 reloads leave no released snapshot's entry in the
        // budget. The byte figure stood for "the dropped snapshot keeps nothing"; Rust asserts
        // the budget itself, on the same inputs.
        let conn = home("retention", &header("retention"));
        let mut repo = Repo::new(64);
        for _ in 0..1_500 {
            let snapshot = resident(&conn, repo.budget(), "retention");
            snapshot
                .borrow_mut()
                .agent_keys_by_id
                .write("root", "root".to_owned());
            assert_eq!(repo.budget().borrow().size(), 1, "one cached record");
            repo.snapshots
                .insert("retention".to_owned(), Rc::clone(&snapshot));
            repo.drop("retention".to_owned());
            assert_eq!(
                repo.budget().borrow().size(),
                0,
                "a dropped snapshot leaves the budget"
            );
        }
    }

    #[test]
    fn a_state_kept_past_its_snapshot_reads_native_runs_it_opens_later_as_currently_stored() {
        // `snapshot-release.process`: the task still holds the released snapshot; its reads go
        // to SQLite, so a run stored after the release is the one it sees.
        let conn = home("release", &header("release"));
        let mut repo = Repo::new(64);
        let snapshot = resident(&conn, repo.budget(), "release");
        repo.snapshots
            .insert("release".to_owned(), Rc::clone(&snapshot));
        repo.drop("release".to_owned());
        assert!(snapshot.borrow().is_released());
        stmt_cache::run(
            &conn,
            "INSERT INTO engine_state_records VALUES (?,?,?,?)",
            vec![
                text("release"),
                text("nativeRuns:root"),
                text("run-1"),
                Value::Text("\"stored-run\"".to_owned()),
            ],
        )
        .unwrap();
        let runs = snapshot.borrow_mut().native_runs("root").unwrap();
        assert_eq!(
            runs.get("run-1").map(String::as_str),
            Some("stored-run"),
            "the released snapshot's read falls through to SQLite"
        );
    }
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};
    use crate::snapshot::decode::decode_header;

    #[test]
    fn a_snapshot_spared_while_pinned_is_dropped_once_the_pin_is_gone() {
        // Generation 1 with a live write pinned skips the snapshot; a later sync at the same
        // generation must still drop it, or the rolled-back state stays resident.
        let conn = home("sync", &header("sync"));
        let (store, shell) = Shell::store_with_controls(&conn);
        let mut repo = Repo::new(64);
        let snapshot = repo
            .state(&store, "sync")
            .unwrap()
            .expect("the stored state");
        shell.rollback();
        shell.pin(true);
        repo.sync(&store).unwrap();
        assert!(repo.holds("sync"), "a pinned snapshot is spared");
        shell.pin(false);
        repo.sync(&store).unwrap();
        assert!(
            !repo.holds("sync"),
            "the pin is gone, so the stale snapshot goes"
        );
        assert!(snapshot.borrow().is_released());
        let _ = decode_header(&header("sync")).unwrap();
    }
}
