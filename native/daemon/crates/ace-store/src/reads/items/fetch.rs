// SPDX-License-Identifier: Apache-2.0
//! Batched item-head, body, preview and chunk fetches: the same statements the TypeScript
//! loaders issued one by one, run once per call on the store's own connection.

use super::{FetchError, Result, all, rows_json};
use crate::{Connection, Value};
use std::sync::Arc;

/// Page heads, newest first: `SELECT` the loader's own columns for `limit` rows before
/// `before`. One statement whatever the page holds.
pub fn heads(conn: &Arc<Connection>, thread_id: &str, before: f64, limit: f64) -> Result<String> {
    let rows = all(
        conn,
        "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Real(before),
            Value::Real(limit),
        ],
    )?;
    rows_json(&["id", "created_seq", "size", "item_type"], &rows)
}

/// Heads for explicit sequences: one statement for the window's jump point and neighbors.
pub fn heads_by_seqs(conn: &Arc<Connection>, thread_id: &str, seqs_json: &str) -> Result<String> {
    let rows = all(
        conn,
        "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq IN (SELECT value FROM json_each(?))",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Text(seqs_json.to_owned()),
        ],
    )?;
    rows_json(&["id", "created_seq", "size", "item_type"], &rows)
}

/// Bodies plus append-only chunks for `ids_json` (a JSON array of ids), as `materializeAll`
/// reads them: each body's row (kind 0) before its chunks (kind 1), in sequence order. One
/// statement, one snapshot: a completion committed meanwhile is seen whole or not at all.
pub fn bodies(conn: &Arc<Connection>, ids_json: &str) -> Result<String> {
    let rows = all(
        conn,
        "SELECT j.value AS id, 0 AS kind, i.item, i.created_seq, NULL AS seq, NULL AS field, NULL AS append
           FROM json_each(?1) j JOIN items i ON i.id = j.value
         UNION ALL
         SELECT j.value, 1, NULL, NULL, c.seq, c.field, c.append
           FROM json_each(?1) j JOIN item_text_chunks c ON c.item_id = j.value
         ORDER BY 1, 2, 5",
        &[Value::Text(ids_json.to_owned())],
    )?;
    rows_json(
        &[
            "id",
            "kind",
            "item",
            "created_seq",
            "seq",
            "field",
            "append",
        ],
        &rows,
    )
}

/// Stored previews for `ids_json`: each preview's item JSON, target and creation sequence
/// (null when its item row is gone). One statement.
pub fn previews(conn: &Arc<Connection>, ids_json: &str) -> Result<String> {
    let rows = all(
        conn,
        "SELECT p.id, p.item, p.target, i.created_seq FROM item_previews p LEFT JOIN items i ON i.id = p.id WHERE p.id IN (SELECT value FROM json_each(?))",
        &[Value::Text(ids_json.to_owned())],
    )?;
    rows_json(&["id", "item", "target", "created_seq"], &rows)
}

/// Whole bodies in a creation range: the page's items without per-item statements.
pub fn range_bodies(
    conn: &Arc<Connection>,
    thread_id: &str,
    oldest: f64,
    before: f64,
) -> Result<String> {
    let rows = all(
        conn,
        "SELECT id, item, created_seq FROM items WHERE thread_id = ? AND created_seq >= ? AND created_seq < ? ORDER BY created_seq",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Real(oldest),
            Value::Real(before),
        ],
    )?;
    rows_json(&["id", "item", "created_seq"], &rows)
}

/// Text chunks for `ids_json`, in `(item_id, seq)` order. One statement for the page's
/// every chunk, instead of one per item.
pub fn chunks(conn: &Arc<Connection>, ids_json: &str) -> Result<String> {
    let rows = all(
        conn,
        "SELECT item_id, seq, field, append FROM item_text_chunks WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY 1, 2",
        &[Value::Text(ids_json.to_owned())],
    )?;
    rows_json(&["item_id", "seq", "field", "append"], &rows)
}

/// A tail's head rows: the newest `limit + 1` plus the root lane's newest `limit / 2` (the
/// root agent's and the thread's own), exactly the loader's three indexed reads. One call,
/// up to three statements, concatenated as the loader concatenates them.
pub fn tail_heads(
    conn: &Arc<Connection>,
    thread_id: &str,
    root_agent_id: Option<&str>,
    limit: f64,
) -> Result<String> {
    if !limit.is_finite() || limit < 0.0 {
        return Err(FetchError::Input("Invalid item page"));
    }
    let half = (limit / 2.0).floor();
    let mut rows = all(
        conn,
        "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ? ORDER BY created_seq DESC LIMIT ?",
        &[Value::Text(thread_id.to_owned()), Value::Real(limit + 1.0)],
    )?;
    if let Some(root) = root_agent_id {
        let lane = all(
            conn,
            "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ? AND agent_id = ? ORDER BY created_seq DESC LIMIT ?",
            &[
                Value::Text(thread_id.to_owned()),
                Value::Text(root.to_owned()),
                Value::Real(half),
            ],
        )?;
        rows.extend(lane);
    }
    let own = all(
        conn,
        "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ? AND agent_id = ? ORDER BY created_seq DESC LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Text(String::new()),
            Value::Real(half),
        ],
    )?;
    rows.extend(own);
    rows_json(&["id", "created_seq", "size", "agent_id"], &rows)
}
