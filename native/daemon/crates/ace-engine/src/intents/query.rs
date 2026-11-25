// SPDX-License-Identifier: Apache-2.0
//! The live questions about one intent (`intents.ts:331`-`:378`): whether it or a sibling runs,
//! the interactions a turn end resolves, the steer it is fenced to, its selection, and whether
//! the provider confirmed its hand-over.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use super::store::{text, thread_value};
use crate::EngineError;
use crate::repository::residency::cell_text;

/// `running` (`:331`).
pub fn running(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents WHERE thread_id=? AND status='running' LIMIT 1";
    Ok(stmt_cache::get_row(conn, SQL, vec![thread_value(thread)])?.is_some())
}

/// `runningBesides` (`:337`).
pub fn running_besides(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    except: u32,
) -> Result<bool, EngineError> {
    const SQL: &str =
        "SELECT 1 FROM intents WHERE thread_id=? AND status='running' AND id<>? LIMIT 1";
    Ok(stmt_cache::get_row(
        conn,
        SQL,
        vec![thread_value(thread), Value::Integer(i64::from(except))],
    )?
    .is_some())
}

/// `resolvingInteractions` (`:344`).
pub fn resolving_interactions(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Vec<String>, EngineError> {
    const SQL: &str = "SELECT resolution_id FROM intents WHERE thread_id=? AND status='running' AND kind='interaction.resolve' AND resolution_id IS NOT NULL";
    let rows = stmt_cache::all_rows(conn, SQL, vec![thread_value(thread)])?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            row.get("resolution_id")
                .and_then(cell_text)
                .map(str::to_owned)
        })
        .collect())
}

/// `steerTarget` (`:353`): `Some(None)` is JSON null, `Some(Some(run))` a run, `None` unknown.
pub fn steer_target(
    conn: &Arc<ace_store::Connection>,
    intent: u32,
) -> Result<Option<Option<String>>, EngineError> {
    const SQL: &str = "SELECT json_type(payload,'$.payload.runId') AS kind, json_extract(payload,'$.payload.runId') AS run FROM intents WHERE id=?";
    let Some(row) = stmt_cache::get_row(conn, SQL, vec![Value::Integer(i64::from(intent))])? else {
        return Ok(None);
    };
    match text(row.get("kind")) {
        Some("null") => Ok(Some(None)),
        _ => Ok(text(row.get("run")).map(|run| Some(run.to_owned()))),
    }
}

/// `hasSelection` (`:359`).
pub fn has_selection(conn: &Arc<ace_store::Connection>, intent: u32) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT json_type(payload,'$.payload.model') AS model,json_type(payload,'$.payload.options') AS options FROM intents WHERE id=?";
    let Some(row) = stmt_cache::get_row(conn, SQL, vec![Value::Integer(i64::from(intent))])? else {
        return Ok(false);
    };
    Ok(row.get("model").and_then(cell_text).is_some()
        || row.get("options").and_then(cell_text).is_some())
}

/// `acknowledged` (`:372`): handed over, then confirmed.
pub fn acknowledged(conn: &Arc<ace_store::Connection>, intent: u32) -> Result<bool, EngineError> {
    const SQL: &str =
        "SELECT 1 FROM intents WHERE id=? AND acknowledged=1 AND submitted_generation IS NOT NULL";
    Ok(stmt_cache::get_row(conn, SQL, vec![Value::Integer(i64::from(intent))])?.is_some())
}
