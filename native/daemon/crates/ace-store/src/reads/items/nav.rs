// SPDX-License-Identifier: Apache-2.0
//! Window navigation fetches: the target, neighbor and existence statements `window` issues
//! around its batched body reads. Each returns one small JSON value; the shaping loop stays
//! in TypeScript.

use super::{FetchError, Result, all, int_json, one};
use crate::{Connection, Value};
use std::sync::Arc;

fn cell_int(cell: &Value) -> Result<i64> {
    match cell {
        Value::Integer(n) => Ok(*n),
        _ => Err(FetchError::Input("Invalid stored item")),
    }
}

fn row_seq(row: &[Value]) -> Result<i64> {
    row.first()
        .map(cell_int)
        .unwrap_or(Err(FetchError::Input("Invalid stored item")))
}

/// The jump point: the first sequence at or after `around_seq`, else the newest. The two
/// indexed reads the loader runs, in the same order.
pub fn target(conn: &Arc<Connection>, thread_id: &str, around_seq: f64) -> Result<String> {
    let first = one(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? AND created_seq >= ? ORDER BY created_seq LIMIT 1",
        &[Value::Text(thread_id.to_owned()), Value::Real(around_seq)],
    )?;
    let seq = match first {
        Some(row) => Some(row_seq(&row)?),
        None => match one(
            conn,
            "SELECT created_seq FROM item_heads WHERE thread_id = ? ORDER BY created_seq DESC LIMIT 1",
            &[Value::Text(thread_id.to_owned())],
        )? {
            Some(row) => Some(row_seq(&row)?),
            None => None,
        },
    };
    match seq {
        Some(seq) => {
            let mut map = serde_json::Map::with_capacity(1);
            map.insert("targetSeq".to_owned(), int_json(seq));
            serde_json::to_string(&map).map_err(|error| FetchError::Encode(error.to_string()))
        }
        None => Ok("{\"targetSeq\":null}".to_owned()),
    }
}

/// Neighbor sequences around `target_seq`: the loader's older and newer reads, newest and
/// oldest first respectively.
pub fn neighbor_seqs(
    conn: &Arc<Connection>,
    thread_id: &str,
    target_seq: i64,
    before: f64,
    after: f64,
) -> Result<String> {
    let older = all(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Integer(target_seq),
            Value::Real(before),
        ],
    )?;
    let newer = all(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? AND created_seq > ? ORDER BY created_seq LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Integer(target_seq),
            Value::Real(after),
        ],
    )?;
    let mut older_out = Vec::with_capacity(older.len());
    for row in &older {
        older_out.push(row_seq(row)?);
    }
    let mut newer_out = Vec::with_capacity(newer.len());
    for row in &newer {
        newer_out.push(row_seq(row)?);
    }
    let mut map = serde_json::Map::with_capacity(2);
    map.insert(
        "older".to_owned(),
        serde_json::Value::Array(older_out.into_iter().map(int_json).collect()),
    );
    map.insert(
        "newer".to_owned(),
        serde_json::Value::Array(newer_out.into_iter().map(int_json).collect()),
    );
    serde_json::to_string(&map).map_err(|error| FetchError::Encode(error.to_string()))
}

/// Whether older rows exist before `first` and newer rows after `last`: the loader's two
/// existence checks.
pub fn existence(conn: &Arc<Connection>, thread_id: &str, first: i64, last: i64) -> Result<String> {
    let has_before = one(
        conn,
        "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq < ? LIMIT 1",
        &[Value::Text(thread_id.to_owned()), Value::Integer(first)],
    )?
    .is_some();
    let has_after = one(
        conn,
        "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq > ? LIMIT 1",
        &[Value::Text(thread_id.to_owned()), Value::Integer(last)],
    )?
    .is_some();
    Ok(format!(
        "{{\"hasBefore\":{has_before},\"hasAfter\":{has_after}}}"
    ))
}
