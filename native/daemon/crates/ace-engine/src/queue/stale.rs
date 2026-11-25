// SPDX-License-Identifier: Apache-2.0
//! `stale-inputs.ts` (E5.4a): an uncertain input is retired when its moment passes, never sent
//! again. Its transcript notice stays. `retireUncertainInputs` takes the thread's backend as an
//! argument, so 4a needs no `Repo`.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::{EngineError, EngineStore};

const SENDS: &str = "kind IN ('thread.send','thread.create')";

fn ids(rows: &[ace_store::stmt_cache::Row]) -> Result<Vec<u32>, EngineError> {
    rows.iter()
        .map(|row| match row.get("id") {
            Some(Value::Integer(id)) => Ok(*id as u32),
            _ => Err(EngineError::Records("Invalid intent identity".into())),
        })
        .collect()
}

/// `retireEndedTurnInputs` (`stale-inputs.ts:23`): the provider ended a turn in session
/// `generation`; its unconfirmed sends are settled.
pub fn retire_ended_turn_inputs(
    store: &EngineStore,
    thread: &str,
    generation: i64,
    at: f64,
) -> Result<(), EngineError> {
    let sql = format!(
        "SELECT id FROM intents WHERE thread_id=? AND uncertain=1 AND {SENDS} AND submitted_generation=?"
    );
    let rows = stmt_cache::all_rows(
        store.conn(),
        Box::leak(sql.into_boxed_str()),
        vec![Value::Text(thread.to_owned()), Value::Integer(generation)],
    )?;
    let rows = ids(&rows)?;
    if retire(store.conn(), &rows)? {
        release_uncertain_hold(store, thread, at)?;
    }
    Ok(())
}

/// `retireUncertainInputs` (`stale-inputs.ts:33`): a new message is the go-ahead past every
/// uncertain input, except a Cursor SDK continuation.
pub fn retire_uncertain_inputs(
    store: &EngineStore,
    thread: &str,
    backend: &str,
    at: f64,
) -> Result<(), EngineError> {
    let keep_continuation = backend == "cursor-sdk";
    let continuation = if keep_continuation {
        None
    } else {
        crate::intents::store::uncertain_continuation(store.conn(), thread)?
    };
    let sql = if keep_continuation {
        format!("SELECT id FROM intents WHERE thread_id=? AND uncertain=1 AND {SENDS}")
    } else {
        "SELECT id FROM intents WHERE thread_id=? AND uncertain=1".to_owned()
    };
    let rows = stmt_cache::all_rows(
        store.conn(),
        Box::leak(sql.into_boxed_str()),
        vec![Value::Text(thread.to_owned())],
    )?;
    if !retire(store.conn(), &ids(&rows)?)? {
        return Ok(());
    }
    if continuation.is_some() {
        crate::intents::store::finish_continuation(store.conn(), thread)?;
        super::store::set(
            store,
            thread,
            "{\"continuation\":null,\"trigger\":null}",
            at,
        )?;
    }
    release_uncertain_hold(store, thread, at)
}

fn retire(conn: &Arc<ace_store::Connection>, rows: &[u32]) -> Result<bool, EngineError> {
    for id in rows {
        super::messages::clear_uncertain(conn, *id)?;
        super::messages::prune(conn, *id)?;
    }
    Ok(!rows.is_empty())
}

/// Only the ambiguity hold is lifted; a limit, Stop or continuation hold keeps its own reason.
fn release_uncertain_hold(store: &EngineStore, thread: &str, at: f64) -> Result<(), EngineError> {
    let queue = super::store::get(store, thread)?;
    if queue.reason.as_deref() != Some("uncertain")
        || super::store::has_uncertain(store.conn(), thread)?
    {
        // The queue still changed: bump its revision so clients drop the retired entries.
        return super::store::set(store, thread, "{}", at);
    }
    if queue.limited || queue.continuation.is_some() {
        super::store::reconcile_uncertainty(store, thread, at)
    } else {
        super::store::set(store, thread, "{\"paused\":false,\"reason\":null}", at)
    }
}
