// SPDX-License-Identifier: Apache-2.0
//! Per-thread provider store generations (E5.3, `store-generations.ts`). The table is created by
//! the opener (`transition-state.ts:62`); Rust only reads and advances it.

use ace_store::stmt_cache;

use crate::repository::residency::{cell_int, integer, text};
use crate::{EngineError, EngineStore, State};

/// Far past any real thread: a store that fails this often is not a store problem.
pub const MAX_STORE_GENERATION: i64 = 64;

pub const GET: &str = "SELECT generation FROM engine_store_generations WHERE thread_id=?";
pub const ADVANCE: &str = "INSERT INTO engine_store_generations VALUES (?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET generation=excluded.generation";

impl State {
    /// `get` (`:28`): 0 when absent, a non-negative integer else.
    pub fn store_generation(&mut self, store: &EngineStore, id: &str) -> Result<i64, EngineError> {
        let row = stmt_cache::get_row(store.conn(), GET, vec![text(id)])?;
        Ok(row
            .and_then(|row| row.get("generation").and_then(cell_int))
            .unwrap_or(0))
    }

    /// `advance` (`:35`): `get + 1`, inside the caller's transaction.
    pub fn advance_store_generation(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<i64, EngineError> {
        let next = self.store_generation(store, id)? + 1;
        stmt_cache::run(store.conn(), ADVANCE, vec![text(id), integer(next)])?;
        Ok(next)
    }
}
