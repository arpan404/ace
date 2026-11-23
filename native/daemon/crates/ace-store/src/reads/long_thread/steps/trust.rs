// SPDX-License-Identifier: Apache-2.0
//! Which stored item bodies read as stored.
//!
//! Rows from the confirmed boundary on read as stored; older rows are decoded
//! and re-encoded in the schema's order. The boundary and the rejected
//! sequences live beside the database, so a read sees its own snapshot.

use super::super::common::{LongError, all_rows_raw, get_row_raw};
use super::super::row::{int_at, strs_json, text_at};
use crate::{Connection, Value};
use std::sync::Arc;

/// The confirmed trust boundary: rows at or above it read as stored.
pub struct Trust {
    from: i64,
    rejected: Vec<i64>,
}

impl Trust {
    fn untrusted() -> Trust {
        Trust {
            from: i64::MAX,
            rejected: Vec::new(),
        }
    }

    /// Whether the body written at `seq` reads as stored.
    pub fn trusted(&self, seq: Option<i64>) -> bool {
        match seq {
            None => false,
            Some(seq) => seq >= self.from && !self.rejected.contains(&seq),
        }
    }
}

/// Load the trust boundary and the rejected sequences for `seqs`.
pub fn trust_for(conn: &Arc<Connection>, seqs: &[i64]) -> Result<Trust, LongError> {
    let row = get_row_raw(
        conn,
        "SELECT from_seq FROM stored_event_confirmed WHERE id=1",
        Vec::new(),
    )?;
    let Some(row) = row else {
        return Ok(Trust::untrusted());
    };
    let Ok(from) = int_at(&row, 0) else {
        return Ok(Trust::untrusted());
    };
    if seqs.is_empty() {
        return Ok(Trust {
            from,
            rejected: Vec::new(),
        });
    }
    let list = super::super::row::ints_json(seqs);
    let rows = all_rows_raw(
        conn,
        "SELECT seq FROM stored_event_rejected WHERE seq IN (SELECT value FROM json_each(?))",
        vec![Value::Text(list)],
    )?;
    let mut rejected = Vec::new();
    for row in rows {
        if let Ok(seq) = int_at(&row, 0) {
            rejected.push(seq);
        }
    }
    Ok(Trust { from, rejected })
}

/// Each requested item's creation sequence, when its row exists.
pub fn created_seqs(
    conn: &Arc<Connection>,
    thread_id: &str,
    item_ids: &[String],
) -> Result<Vec<(String, i64)>, LongError> {
    if item_ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = strs_json(item_ids)?;
    let rows = all_rows_raw(
        conn,
        "SELECT id,created_seq FROM items WHERE thread_id=? AND id IN (SELECT value FROM json_each(?))",
        vec![Value::Text(thread_id.to_owned()), Value::Text(list)],
    )?;
    let mut out = Vec::new();
    for row in rows {
        let id = text_at(&row, 0)?.to_owned();
        let seq = int_at(&row, 1)?;
        out.push((id, seq));
    }
    Ok(out)
}
