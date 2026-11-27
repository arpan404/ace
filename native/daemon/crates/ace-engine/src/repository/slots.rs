// SPDX-License-Identifier: Apache-2.0
//! Warm-session slots (E5.3, `repository.ts:496`-`:543`). `reserve` counts `engine_slots` minus
//! the retiring set against the capacity and asks the reclaim hook before refusing; `release`
//! deletes the row and forgets the retiring mark.

use ace_store::stmt_cache;

use super::Repo;
use crate::repository::residency::{cell_int, text};
use crate::{EngineError, EngineStore};

pub const SLOT: &str = "SELECT thread_id FROM engine_slots WHERE thread_id=?";
pub const COUNT: &str = "SELECT COUNT(*) AS count FROM engine_slots";
pub const TAKE: &str = "INSERT INTO engine_slots VALUES (?)";
pub const RELEASE: &str = "DELETE FROM engine_slots WHERE thread_id=?";

impl Repo {
    /// Whether the thread already holds a slot.
    pub fn reserved_slot(&self, store: &EngineStore, id: &str) -> Result<bool, EngineError> {
        store.atomic(|tx| Ok(stmt_cache::get_row(tx.conn(), SLOT, vec![text(id)])?.is_some()))
    }

    /// Idle sessions asked to close; their slots no longer count as taken.
    pub fn retiring_count(&self) -> usize {
        self.retiring.len()
    }

    /// `reserve` (`:516`), inside the store's transaction.
    pub fn reserve(&mut self, store: &EngineStore, id: &str) -> Result<bool, EngineError> {
        store.atomic(|tx| {
            if stmt_cache::get_row(tx.conn(), SLOT, vec![text(id)])?.is_some() {
                return Ok(true);
            }
            let count = stmt_cache::get_row(tx.conn(), COUNT, vec![])?
                .and_then(|row| row.get("count").and_then(cell_int))
                .unwrap_or(0);
            if count - self.retiring.len() as i64 >= self.capacity as i64 {
                // Evict before refusing: a finished thread's warm session gives up its slot.
                let freed = match &self.reclaim {
                    Some(reclaim) => reclaim(&self.retiring),
                    None => None,
                };
                let Some(freed) = freed else {
                    return Ok(false);
                };
                self.retiring.insert(freed);
            }
            stmt_cache::run(tx.conn(), TAKE, vec![text(id)])?;
            Ok(true)
        })
    }

    /// `release` (`:533`).
    pub fn release_slot(&mut self, store: &EngineStore, id: &str) -> Result<(), EngineError> {
        store.atomic(|tx| {
            stmt_cache::run(tx.conn(), RELEASE, vec![text(id)])?;
            Ok(())
        })?;
        self.retiring.remove(id);
        Ok(())
    }
}
