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
        if generation == self.generation {
            return Ok(());
        }
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
