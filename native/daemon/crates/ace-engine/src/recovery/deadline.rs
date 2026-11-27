// SPDX-License-Identifier: Apache-2.0
//! The queue's one deadline: firing it, the deferred backoff behind a failing pass, and the
//! automatic Resume or limit move a due hold starts (`recovery.ts:579`-`:707`). The timer itself
//! is armed in `queue::holds`; this module is what its firing runs.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::commands::{error, payload_type};
use crate::executor::Lane;
use crate::queue::{deadline as queue_deadline, store as queue_store, write as queue_write};
use crate::repository::residency::cell_text;
use crate::{Core, EngineError};

use super::{DEADLINE_RETRY_MS, Deferral, deadline_deferral};

const RECEIPT: &str = "SELECT result FROM command_receipts WHERE command_id=?";
const RECORD: &str = "INSERT INTO command_receipts VALUES (?,?,?,?)";

/// `recovery.fire()` (`recovery.ts:629`): one deadline pass. Timer callbacks must never throw —
/// that would take the whole daemon down — so every failure is reported and the pass retried.
pub fn fire(core: &Core) {
    if let Err(error) = fire_pass(core) {
        // The pass rolled back, so its deadlines are still due; try them again shortly.
        core.ports.report(error.to_string());
        if let Err(error) = arm_retry(core, DEADLINE_RETRY_MS) {
            core.ports.report(error.to_string());
        }
    }
}

fn fire_pass(core: &Core) -> Result<(), EngineError> {
    if core.actor_deps.borrow().live.history_writing() {
        return Err(EngineError::Records(
            "History publication in progress".to_owned(),
        ));
    }
    prune_deferrals(core)?;
    let now = core.ports.now();
    for thread in queue_deadline::due(core.store.conn(), now as i64)? {
        let outcome = core.store.atomic(|_| fire_one(core, &thread, now));
        match outcome {
            Ok(()) => {
                core.with_state(|state| {
                    state.recovery.deferrals.shift_remove(&thread);
                })?;
            }
            // Contention: the whole pass is tried again shortly.
            Err(error) if core.actor_deps.borrow().live.is_store_retry(&error) => {
                return Err(error);
            }
            Err(_) => defer_deadline(core, &thread)?,
        }
    }
    crate::queue::holds::schedule(core)
}

/// `recovery.fireOne()` (`recovery.ts:658`): one thread's due hold.
fn fire_one(core: &Core, thread: &str, now: f64) -> Result<(), EngineError> {
    let queue = queue_store::get(&core.store, thread)?;
    match queue.timer_action.as_deref() {
        Some("snooze") => queue_write::set(
            &core.store,
            thread,
            r#"{"resumeAt":null,"timerAction":null,"reason":"manual"}"#,
            now,
        ),
        Some("clear") => super::observe::clear_limit(core, thread),
        action => {
            // Clear the deadline first, retaining a manual hold on capacity refusal.
            queue_write::set(
                &core.store,
                thread,
                r#"{"resumeAt":null,"timerAction":null}"#,
                now,
            )?;
            let migrate = matches!(action, Some("migrate"));
            automatic(
                core,
                thread,
                if migrate { Some("migrate_now") } else { None },
            )?;
            Ok(())
        }
    }
}

/// `recovery.automatic()` (`recovery.ts:579`): the engine's own Resume or limit move, as a
/// receipted command, or a hold kept for when the maintenance gate reopens.
pub fn automatic(
    core: &Core,
    thread: &str,
    action: Option<&str>,
) -> Result<Option<Value>, EngineError> {
    if super::capture::spade_owned(core, thread)? {
        return Ok(None);
    }
    let now = core.ports.now();
    // Maintenance holds turns ace would start by itself: keep a due deadline for when it reopens.
    if !core.ports.admits()? {
        let patch = format!(
            r#"{{"resumeAt":{},"timerAction":"{}"}}"#,
            now as i64,
            if action.is_some() {
                "migrate"
            } else {
                "resume"
            }
        );
        queue_write::set(&core.store, thread, &patch, now)?;
        core.with_state(|state| crate::queue::holds::sync(core, state, thread, now))??;
        return Ok(None);
    }
    let revision = queue_store::get(&core.store, thread)?.revision;
    let id = core.ports.command_id();
    let mut payload = ace_json::Map::new();
    payload.insert(
        "type",
        Value::from(if action.is_some() {
            "thread.limit"
        } else {
            "thread.resume"
        }),
    );
    payload.insert("threadId", Value::from(thread));
    payload.insert("expectedRevision", Value::from(revision as f64));
    if let Some(action) = action {
        payload.insert("action", Value::from(action));
    }
    let mut command = ace_json::Map::new();
    command.insert("id", Value::from(id.as_str()));
    command.insert("deviceId", Value::from("engine"));
    command.insert("payload", Value::Object(payload));
    let command = Value::Object(command);
    let result = core.store.atomic(|tx| {
        if let Some(existing) = receipt(tx.conn(), &id)? {
            return Ok(existing);
        }
        let result = core
            .with_state(|state| super::handle(core, state, &command))??
            .unwrap_or_else(|| error(&id, "invalid_recovery_command"));
        let text = ace_json::to_string(&result);
        stmt_cache::run(
            tx.conn(),
            RECORD,
            vec![
                Cell::Text(id.clone()),
                Cell::Text("engine".to_owned()),
                Cell::Integer(now as i64),
                Cell::Text(text),
            ],
        )?;
        Ok(result)
    })?;
    if result.get("error").and_then(Value::as_str) == Some("engine_capacity_exceeded") {
        let patch = format!(
            r#"{{"resumeAt":{},"timerAction":"{}"}}"#,
            now as i64 + 1000,
            if action.is_some() {
                "migrate"
            } else {
                "resume"
            }
        );
        queue_write::set(&core.store, thread, &patch, now)?;
    }
    Ok(Some(result))
}

/// A receipt already recorded for the engine's command id, if any.
fn receipt(
    conn: &std::sync::Arc<ace_store::Connection>,
    command_id: &str,
) -> Result<Option<Value>, EngineError> {
    let row = stmt_cache::get_row(conn, RECEIPT, vec![Cell::Text(command_id.to_owned())])?;
    let Some(text) = row.and_then(|row| row.get("result").and_then(cell_text).map(str::to_owned))
    else {
        return Ok(None);
    };
    Ok(Some(ace_json::parse(&text).map_err(|error| {
        EngineError::Records(error.to_string())
    })?))
}

/// `recovery.deferDeadline()` (`recovery.ts:678`): one thread's deadline moves back with doubling,
/// bounded delays, so it neither spins nor holds up the threads after it.
pub fn defer_deadline(core: &Core, thread: &str) -> Result<(), EngineError> {
    let key = queue_deadline::deadline_key(core.store.conn(), thread)?;
    let previous = core.with_state(|state| state.recovery.deferrals.get(thread).cloned())?;
    // Only the deadline it put off carries its backoff; a new hold starts over.
    let delay = deadline_deferral(
        previous
            .filter(|previous| Some(&previous.deadline) == key.as_ref())
            .map(|previous| previous.delay),
    );
    core.ports.report(format!(
        "Thread {thread}'s deadline failed; tried again in {delay} ms"
    ));
    let now = core.ports.now();
    let deadline = core.store.atomic(|_| {
        queue_deadline::defer(core.store.conn(), thread, now as i64 + delay as i64)?;
        queue_deadline::deadline_key(core.store.conn(), thread)
    })?;
    core.with_state(|state| match deadline {
        Some(deadline) => {
            state
                .recovery
                .deferrals
                .insert(thread.to_owned(), Deferral { deadline, delay });
        }
        None => {
            state.recovery.deferrals.shift_remove(thread);
        }
    })?;
    Ok(())
}

/// `recovery.pruneDeferrals()` (`recovery.ts:704`): forget backoff whose deadline is gone.
pub fn prune_deferrals(core: &Core) -> Result<(), EngineError> {
    let threads: Vec<String> =
        core.with_state(|state| state.recovery.deferrals.keys().cloned().collect())?;
    for thread in threads {
        let key = queue_deadline::deadline_key(core.store.conn(), &thread)?;
        let stale = core.with_state(|state| {
            state
                .recovery
                .deferrals
                .get(&thread)
                .is_some_and(|deferral| Some(&deferral.deadline) != key.as_ref())
        })?;
        if stale {
            core.with_state(|state| {
                state.recovery.deferrals.shift_remove(&thread);
            })?;
        }
    }
    Ok(())
}

/// Re-arms a failed pass after `ms`, replacing any armed deadline (`recovery.ts:651`-`:655`).
fn arm_retry(core: &Core, ms: f64) -> Result<(), EngineError> {
    let previous = core.with_state(|state| state.recovery.cancel.take())?;
    if let Some(key) = previous {
        core.ports.cancel_timer(key);
    }
    if core.with_state(|state| state.recovery.closed)? {
        return Ok(());
    }
    let timer = core.ports.set_timer(ms);
    let key = timer.key;
    core.with_state(|state| state.recovery.cancel = Some(key))?;
    let Some(ask) = core.self_rc() else {
        return Ok(());
    };
    let task = core.executor.spawn(Lane::Work, async move {
        if timer.fired.await.is_err() {
            return;
        }
        let run = ask
            .with_state(|state| {
                if state.recovery.cancel == Some(key) {
                    state.recovery.cancel = None;
                    !state.recovery.closed
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if run {
            fire(&ask);
        }
    });
    task.detach();
    Ok(())
}

/// The payload type of a command the engine records, for a caller that has only its JSON.
pub fn is_resume(command: &Value) -> bool {
    matches!(payload_type(command), "thread.resume" | "queue.resume")
}

#[cfg(test)]
mod tests;
