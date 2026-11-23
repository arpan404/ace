// SPDX-License-Identifier: Apache-2.0
//! `turn.steps` range rows, as `long-thread/steps.ts` shapes them.
//!
//! Rust fetches the turn's `end_seq` and the step index rows in order;
//! TypeScript shapes them with its existing `decodeStoredItem`/trust code.
//! That keeps streaming tails, the 1 MiB budget and trust (including the
//! store's in-memory trust) exactly as the legacy path reads them: Rust never
//! holds bodies the page never shows.

use super::super::common::{LongError, all_rows_raw, get_row_raw, invalid};
use super::super::row::{int_at, text_at};
use crate::{Connection, Value};
use std::sync::Arc;

pub fn turn_steps(
    conn: &Arc<Connection>,
    thread_id: &str,
    turn_ordinal: i64,
    after: Option<i64>,
    limit: i64,
    _request_id: &str,
    _head_seq: i64,
) -> Result<String, LongError> {
    if !(1..=200).contains(&limit) {
        return Err(invalid("search_invalid_query"));
    }
    if turn_ordinal < 1 {
        return Err(invalid("turn_target_unavailable"));
    }
    let turn = get_row_raw(
        conn,
        "SELECT end_seq FROM long_turns WHERE thread_id=? AND ordinal=?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(turn_ordinal),
        ],
    )?
    .ok_or_else(|| invalid("turn_target_unavailable"))?;
    let end_seq = super::super::common::check_count(int_at(&turn, 0)?)?;
    let after_seq = after.unwrap_or(0);
    let rows = all_rows_raw(
        conn,
        "SELECT item_id,created_seq FROM long_items WHERE thread_id=? AND ordinal=? AND created_seq>? AND (role IS NULL OR role<>'user') ORDER BY created_seq LIMIT ?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(turn_ordinal),
            Value::Integer(after_seq),
            Value::Integer(limit + 1),
        ],
    )?;
    let mut out = String::with_capacity(4096);
    out.push_str("{\"end_seq\":");
    out.push_str(&end_seq.to_string());
    out.push_str(",\"rows\":[");
    for (index, row) in rows.iter().enumerate() {
        let item_id = text_at(row, 0)?;
        if item_id.is_empty() {
            return Err(invalid("invalid index row"));
        }
        let seq = super::super::common::check_count(int_at(row, 1)?)?;
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"item_id\":");
        let encoded =
            super::super::row::json_string(item_id).map_err(|error| invalid(&error.to_string()))?;
        out.push_str(&encoded);
        out.push_str(",\"created_seq\":");
        out.push_str(&seq.to_string());
        out.push('}');
    }
    out.push_str("]}");
    Ok(out)
}
