// SPDX-License-Identifier: Apache-2.0
//! Sequence allocation and reservation (task 5.2b). Ports `apps/daemon/src/stream-sequences.ts`
//! exactly: one cursor shared by every writer, provisional allocation ahead of the reservation
//! that stores it, and a confirmed range that moves only when the outermost transaction that
//! wrote it commits.
//!
//! JavaScript numbers stay `f64`: every caller is still TypeScript. `None` models the TS `NaN`
//! (`reservedThrough()` returns `NaN` for it, and every comparison against it is false), so a
//! database whose `host_sequence` has no row cannot allocate.

use crate::stmt_cache;
use crate::{Connection, Value};
use std::fmt;
use std::sync::Arc;

/// The largest integer a JavaScript number counts exactly.
const MAX_SEQUENCE: f64 = 9_007_199_254_740_991.0;
/// The smallest range `prepare` reserves.
const MIN_RANGE: f64 = 65_536.0;
/// The high-water mark's row (`host_sequence` holds exactly one).
const READ_MARK: &str = "SELECT seq FROM host_sequence WHERE id=1";
/// A stored row moves the mark in its own transaction, as the TS writers do.
const MOVE_MARK: &str = "UPDATE host_sequence SET seq=MAX(seq,?) WHERE id=1";
/// The head counts event rows and deletion tombstones.
const READ_HEAD: &str = "SELECT MAX(seq) AS seq FROM (
      SELECT MAX(seq) AS seq FROM events UNION ALL SELECT MAX(seq) AS seq FROM usage_deletions
    )";
const READ_ROW: &str = "SELECT 1 FROM events WHERE seq=?";

/// Why allocation failed. Display is the message the TypeScript throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceError {
    Exhausted,
}

impl fmt::Display for SequenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Sequence exhausted")
    }
}

impl std::error::Error for SequenceError {}

/// Whether `value` is an integer a JavaScript number holds exactly.
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SEQUENCE
}

/// A `seq` cell as the TS's `Number(...)` reads it; anything else is the TS's `NaN`.
fn sequence(cell: Option<&Value>) -> Option<f64> {
    match cell {
        Some(Value::Integer(n)) => Some(*n as f64),
        Some(Value::Real(n)) => Some(*n),
        _ => None,
    }
}

/// The allocator: one cursor, and the confirmed reservation.
#[derive(Debug, Clone)]
pub struct Sequences {
    /// The last sequence handed out. `None` while `host_sequence` has no row.
    cursor: Option<f64>,
    /// Reserved through, by a committed outermost transaction. `None` while none has.
    confirmed: Option<f64>,
}

impl Sequences {
    /// Reads `host_sequence`. No row: both fields are `None`, as `Number(undefined)` is `NaN`
    /// in the TS, and every `next` fails with `Exhausted`.
    pub fn initialize(conn: &Arc<Connection>) -> Result<Sequences, crate::Error> {
        let row = stmt_cache::get_row(conn, READ_MARK, Vec::new())?;
        let found = sequence(row.as_ref().and_then(|row| row.get("seq")));
        Ok(Sequences {
            cursor: found,
            confirmed: found,
        })
    }

    /// `reservedThrough()`: the confirmed reservation; `NaN` when none has committed.
    pub fn reserved_through(&self) -> f64 {
        self.confirmed.unwrap_or(f64::NAN)
    }

    /// Larger of `MAX(events.seq)` and `MAX(usage_deletions.seq)`; 0 when both are empty.
    pub fn head(&self, conn: &Arc<Connection>) -> Result<f64, crate::Error> {
        let row = stmt_cache::get_row_raw(conn, READ_HEAD, Vec::new())?;
        Ok(sequence(row.as_ref().and_then(|cells| cells.first())).unwrap_or(0.0))
    }

    /// False when `after` is past both the head and the confirmed reservation; else true for 0,
    /// for the head, or for a sequence stored in `events`.
    pub fn replay_safe(&self, conn: &Arc<Connection>, after: f64) -> Result<bool, crate::Error> {
        let head = self.head(conn)?;
        // A `None` confirmed makes the TS comparison false, so only the head bounds `after`.
        let beyond_confirmed = self.confirmed.is_some_and(|confirmed| after > confirmed);
        if after > head && beyond_confirmed {
            return Ok(false);
        }
        if after == 0.0 || after == head {
            return Ok(true);
        }
        let row = stmt_cache::get_row(conn, READ_ROW, vec![Value::Real(after)])?;
        Ok(row.is_some())
    }

    /// Provisional allocation. The cursor moves before the exhaustion check, exactly as the TS
    /// does, so a failed `next` never hands out the same sequence twice. A `None` cursor stays
    /// `None` and fails.
    pub fn next(&mut self, after: f64) -> Result<f64, SequenceError> {
        let Some(cursor) = self.cursor else {
            return Err(SequenceError::Exhausted);
        };
        let cursor = cursor.max(after) + 1.0;
        self.cursor = Some(cursor);
        if !safe_integer(cursor) {
            return Err(SequenceError::Exhausted);
        }
        Ok(cursor)
    }

    /// The range a refill would reserve: `None` when the confirmed reservation already covers
    /// `after + events`. Pure: a pending reservation never counts, so every admission asks.
    pub fn reservation(&self, events: f64, after: f64) -> Result<Option<f64>, SequenceError> {
        if self
            .confirmed
            .is_some_and(|confirmed| after + events <= confirmed)
        {
            return Ok(None);
        }
        let through = after + MIN_RANGE.max(events);
        if !safe_integer(through) {
            return Err(SequenceError::Exhausted);
        }
        Ok(Some(through))
    }

    /// Writes the reservation, inside the caller's transaction. Changes no field.
    pub fn reserve(&self, conn: &Arc<Connection>, through: f64) -> Result<(), crate::Error> {
        // `all_rows_raw` steps the write to completion; a statement cache holds the prepared
        // statement, and `bind` resets it before the next use.
        stmt_cache::all_rows_raw(conn, MOVE_MARK, vec![Value::Real(through)]).map(|_| ())
    }

    /// Monotonic: raises `confirmed` to `through` unless it already is, and says whether it
    /// rose. Only the outcome's `committed` calls it.
    pub fn confirm(&mut self, through: f64) -> bool {
        if self.confirmed.is_some_and(|confirmed| confirmed >= through) {
            return false;
        }
        self.confirmed = Some(through);
        true
    }

    /// Whether every sequence through `seq` lies in the confirmed reservation.
    pub fn covers(&self, seq: f64) -> bool {
        self.confirmed.is_some_and(|confirmed| seq <= confirmed)
    }
}
