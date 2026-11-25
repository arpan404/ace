// SPDX-License-Identifier: Apache-2.0
//! `stale-inputs.ts` (E5.4a): an uncertain input is retired when its moment passes, never sent
//! again. Its transcript notice stays. `retireUncertainInputs` takes the thread's backend as an
//! argument, so 4a needs no `Repo`.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::{EngineError, EngineStore};

fn ids(rows: &[ace_store::stmt_cache::Row]) -> Result<Vec<i64>, EngineError> {
    rows.iter()
        .map(|row| match row.get("id") {
            Some(Value::Integer(id)) => Ok(*id),
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
    const ENDED: &str = "SELECT id FROM intents WHERE thread_id=? AND uncertain=1 AND kind IN ('thread.send','thread.create') AND submitted_generation=?";
    let rows = stmt_cache::all_rows(
        store.conn(),
        ENDED,
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
    const SENDS_ONLY: &str = "SELECT id FROM intents WHERE thread_id=? AND uncertain=1 AND kind IN ('thread.send','thread.create')";
    const ALL_UNCERTAIN: &str = "SELECT id FROM intents WHERE thread_id=? AND uncertain=1";
    let rows = stmt_cache::all_rows(
        store.conn(),
        if keep_continuation {
            SENDS_ONLY
        } else {
            ALL_UNCERTAIN
        },
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

fn retire(conn: &Arc<ace_store::Connection>, rows: &[i64]) -> Result<bool, EngineError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn uncertain(conn: &Arc<ace_store::Connection>, id: i64, generation: i64) {
        conn.exec(&format!(
            "INSERT INTO intents (id,command_id,thread_id,kind,payload,status,attempts,awaiting,acknowledged,delivery,position,uncertain,submitted_generation)              VALUES ({id},'command-{id}','stale-big','thread.send','{{}}','running',0,0,0,'queue',{id},1,{generation})"
        ))
        .unwrap();
    }

    fn flagged(conn: &Arc<ace_store::Connection>, id: i64) -> i64 {
        let row = stmt_cache::get_row(
            conn,
            "SELECT uncertain FROM intents WHERE id=?",
            vec![Value::Integer(id)],
        )
        .unwrap()
        .unwrap();
        match row.get("uncertain") {
            Some(Value::Integer(value)) => *value,
            _ => -1,
        }
    }

    #[test]
    fn a_generation_above_2_32_retires_only_its_own_intent() {
        let conn = home("stale-big", &header("stale-big"));
        // Intent 1 is generation 1; the generation-2 intent is far above u32's range.
        uncertain(&conn, 1, 1);
        uncertain(&conn, 4_294_967_297, 2);
        let store = Shell::store(&conn);
        retire_ended_turn_inputs(&store, "stale-big", 2, 10.0).unwrap();
        assert_eq!(flagged(&conn, 1), 1);
        assert_eq!(flagged(&conn, 4_294_967_297), 0);
    }
}
