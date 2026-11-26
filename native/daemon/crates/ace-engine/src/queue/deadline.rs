// SPDX-License-Identifier: Apache-2.0
//! The queue's deadlines (`queue-store.ts:413`-`:459`): the next one, the limited threads, the
//! due ones, the key a hold reads as, and a deferred deadline. A deleted thread whose state was
//! purged keeps its row; it has nothing to resume and must not hold up the threads after it.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use super::store::ensure;
use crate::EngineError;
use crate::repository::residency::{cell_int, cell_text};

const NEXT_DEADLINE: &str = "SELECT resume_at FROM engine_queue WHERE resume_at IS NOT NULL AND thread_id IN (SELECT thread_id FROM thread_state)\n      ORDER BY resume_at LIMIT 1";
const LIMITED: &str = "SELECT thread_id FROM engine_queue WHERE limited=1 AND paused=1 AND reason='limit'\n      AND thread_id IN (SELECT thread_id FROM thread_state) LIMIT 256";
const DUE: &str = "SELECT thread_id FROM engine_queue WHERE resume_at<=? AND thread_id IN (SELECT thread_id FROM thread_state)\n      ORDER BY resume_at LIMIT 64";
const DEADLINE_KEY: &str = "SELECT resume_at,hold_token FROM engine_queue WHERE thread_id=? AND resume_at IS NOT NULL\n      AND thread_id IN (SELECT thread_id FROM thread_state)";

/// `nextDeadline` (`:417`).
pub fn next_deadline(conn: &Arc<ace_store::Connection>) -> Result<Option<i64>, EngineError> {
    let row = stmt_cache::get_row(conn, NEXT_DEADLINE, Vec::new())?;
    Ok(row.and_then(|row| row.get("resume_at").and_then(cell_int)))
}

/// `limited` (`:425`).
pub fn limited(conn: &Arc<ace_store::Connection>) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(conn, LIMITED, Vec::new())?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
        .collect())
}

/// `due` (`:433`).
pub fn due(conn: &Arc<ace_store::Connection>, now: i64) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(conn, DUE, vec![Value::Integer(now)])?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
        .collect())
}

/// `deadlineKey` (`:445`).
pub fn deadline_key(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, DEADLINE_KEY, vec![Value::Text(thread.to_owned())])?;
    Ok(row.map(|row| {
        format!(
            "{}:{}",
            row.get("resume_at").and_then(cell_int).unwrap_or(0),
            row.get("hold_token").and_then(cell_int).unwrap_or(0)
        )
    }))
}

/// `defer` (`:453`).
pub fn defer(conn: &Arc<ace_store::Connection>, thread: &str, at: i64) -> Result<(), EngineError> {
    const SQL: &str =
        "UPDATE engine_queue SET resume_at=? WHERE thread_id=? AND resume_at IS NOT NULL";
    ensure(conn, thread)?;
    stmt_cache::run(
        conn,
        SQL,
        vec![Value::Integer(at), Value::Text(thread.to_owned())],
    )?;
    Ok(())
}
