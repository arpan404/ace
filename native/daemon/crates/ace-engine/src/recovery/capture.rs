// SPDX-License-Identifier: Apache-2.0
//! What ace leaves a thread when work stops (`recovery.ts:200`-`:403`): the continuation a
//! shutdown or a provider exit records, the capture behind a restart decision, and the holds a
//! discard, a stop or a settled thread clears. Every write is one transaction with the queue's
//! sync, so a client never sees the hold without its continuation.

use ace_json::Value;

use crate::queue::{store as queue_store, write as queue_write};
use crate::restart::{RestartCapture, clear_capture, has_capture, record_capture};
use crate::{Core, EngineError, State};

const CANCEL_KINDS: [&str; 3] = ["thread.resume", "queue.resume", "thread.limit"];

/// How a discard leaves the queue: released, or held for a reason that still applies.
#[derive(Debug, Clone, Copy)]
pub struct QueueHold {
    pub paused: bool,
    pub reason: Option<&'static str>,
}

/// The hold a discard leaves when nothing else holds the thread.
pub const RELEASED: QueueHold = QueueHold {
    paused: false,
    reason: None,
};

/// A Stop's hold: resumable work goes, the person's Stop stays.
pub const STOPPED: QueueHold = QueueHold {
    paused: true,
    reason: Some("stopped"),
};

/// True for a queue a person stopped (`recovery.ts:852`).
pub fn stopped_hold(queue: &crate::queue::record::RecoveryRecord) -> bool {
    queue.paused && queue.reason.as_deref() == Some("stopped")
}

/// A Spade bot's old session (ADR 0133, superseded by ADR 0219): inert, so no hold ever starts
/// there (`recovery.ts:401`).
pub fn spade_owned(core: &Core, thread: &str) -> Result<bool, EngineError> {
    Ok(super::threads::get(&core.store, thread)?
        .is_some_and(|row| row.host.as_deref() == Some("spade-bot")))
}

/// `recovery.capture()` (`recovery.ts:280`): a plain continuation for interrupted live work, and
/// no restart capture (startup must not read an older one).
pub fn capture(core: &Core, thread: &str) -> Result<(), EngineError> {
    if spade_owned(core, thread)? {
        return Ok(());
    }
    core.with_state(|state| {
        core.store.atomic(|_| {
            capture_with(core, state, thread, &|_lost: &[String]| {
                ace_core::person_input::CONTINUE_MESSAGE.to_owned()
            })?;
            clear_capture(core.store.conn(), thread)?;
            Ok(())
        })
    })?
}

/// `recovery.captureRestart()` (`recovery.ts:293`): the continuation for work a shutdown or a
/// crash cut short, with the request the agent was waiting on saved beside it. Cursor SDK work
/// stays uncertain until checkpoint reconciliation, so it keeps the plain continuation.
pub fn capture_restart(core: &Core, thread: &str) -> Result<(), EngineError> {
    core.with_state(|state| capture_restart_in(core, state, thread))?
}

/// The capture inside a caller's `State` borrow (startup's first pass).
pub(super) fn capture_restart_in(
    core: &Core,
    state: &mut State,
    thread: &str,
) -> Result<(), EngineError> {
    if spade_owned(core, thread)? {
        return Ok(());
    }
    core.store.atomic(|_| {
        let cursor = state.backend(&core.store, thread)?.as_deref() == Some("cursor-sdk");
        let captured = capture_with(core, state, thread, &|lost: &[String]| {
            if cursor {
                ace_core::person_input::CONTINUE_MESSAGE.to_owned()
            } else {
                crate::restart::restart_continuation(lost)
            }
        })?;
        if captured {
            let waiting_on = open_request(core, state, thread)?;
            record_capture(core.store.conn(), thread, &RestartCapture { waiting_on })?;
        }
        Ok(())
    })
}

/// `recovery.captureWith()` (`recovery.ts:305`): true when live work was found and a continuation
/// recorded. A Stop is final, and a continuation already in doubt is not overwritten.
fn capture_with(
    core: &Core,
    state: &mut State,
    thread: &str,
    text: &dyn Fn(&[String]) -> String,
) -> Result<bool, EngineError> {
    if crate::intents::store::uncertain_continuation(core.store.conn(), thread)?.is_some() {
        return Ok(false);
    }
    let queue = queue_store::get(&core.store, thread)?;
    if stopped_hold(&queue) {
        return Ok(false);
    }
    let acknowledged = crate::intents::store::recovery_acknowledgement(core.store.conn(), thread)?;
    let now = core.ports.now();
    let Some(lost) = lost_lines(core, state, thread, usize::from(acknowledged), now)? else {
        return Ok(false);
    };
    let mut patch = ace_json::Map::new();
    patch.insert("continuation", Value::from(text(&lost)));
    patch.insert("trigger", Value::from("restart"));
    queue_write::set(
        &core.store,
        thread,
        &ace_json::to_string(&Value::Object(patch)),
        now,
    )?;
    crate::queue::holds::sync(core, state, thread, now)?;
    Ok(true)
}

/// `recovery.dropStaleCapture()` (`recovery.ts:324`): a shutdown captured live work, but the
/// provider finished it while closing, so the restart has nothing to continue.
pub fn drop_stale_capture(core: &Core, thread: &str, at: f64) -> Result<(), EngineError> {
    core.with_state(|state| drop_stale_capture_in(core, state, thread, at))?
}

pub(super) fn drop_stale_capture_in(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    if !has_capture(core.store.conn(), thread)? {
        return Ok(());
    }
    let queue = queue_store::get(&core.store, thread)?;
    if queue.trigger.as_deref() != Some("restart") || queue.paused {
        return Ok(());
    }
    let acknowledged = crate::intents::store::recovery_acknowledgement(core.store.conn(), thread)?;
    if lost_lines(core, state, thread, usize::from(acknowledged), at)?.is_some() {
        return Ok(());
    }
    queue_write::set(
        &core.store,
        thread,
        r#"{"continuation":null,"trigger":null}"#,
        at,
    )?;
    clear_capture(core.store.conn(), thread)
}

/// `recovery.releaseCompletedRestart()` (`recovery.ts:340`): a Cursor turn a restart cut short
/// that its reconcile read back as finished; the restart's hold and its continue go with it.
pub fn release_completed_restart(core: &Core, thread: &str, at: f64) -> Result<(), EngineError> {
    core.with_state(|state| release_completed_restart_in(core, state, thread, at))?
}

pub(super) fn release_completed_restart_in(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    if state.backend(&core.store, thread)?.as_deref() != Some("cursor-sdk") {
        return Ok(());
    }
    let queue = queue_store::get(&core.store, thread)?;
    if queue.trigger.as_deref() != Some("restart")
        || !queue.paused
        || queue.reason.as_deref() != Some("restart")
        || queue.limited
    {
        return Ok(());
    }
    if root_active_run(core, state, thread)? {
        return Ok(());
    }
    crate::intents::store::finish_continuation(core.store.conn(), thread)?;
    let patch = format!(
        r#"{{"continuation":null,"trigger":null,"paused":false,"reason":null,"holdToken":{}}}"#,
        queue.hold_token + 1
    );
    queue_write::set(&core.store, thread, &patch, at)?;
    clear_capture(core.store.conn(), thread)?;
    crate::queue::holds::sync(core, state, thread, at)
}

/// `recovery.resumeAfterRestart()` (`recovery.ts:366`): startup found the turn safe to continue,
/// so its restart continuation goes now, counting toward the loop guard.
pub fn resume_after_restart(core: &Core, thread: &str) -> Result<(), EngineError> {
    crate::restart::increment_streak(core.store.conn(), thread)?;
    super::deadline::automatic(core, thread, None)?;
    Ok(())
}

/// `recovery.holdInterrupted()` (`recovery.ts:375`): a provider died with work in flight, so the
/// turn is held for the person; ace never continues it by itself.
pub fn hold_interrupted(core: &Core, thread: &str) -> Result<(), EngineError> {
    core.with_state(|state| hold_interrupted_in(core, state, thread))?
}

pub(super) fn hold_interrupted_in(
    core: &Core,
    state: &mut State,
    thread: &str,
) -> Result<(), EngineError> {
    if spade_owned(core, thread)? {
        return Ok(());
    }
    if crate::intents::store::uncertain_continuation(core.store.conn(), thread)?.is_some() {
        return Ok(());
    }
    let queue = queue_store::get(&core.store, thread)?;
    if stopped_hold(&queue) {
        return Ok(());
    }
    // An earlier hold (a restart's, a limit's) keeps its reason, and what it is called.
    let kept = queue.paused && queue.reason.is_some();
    let continuation = queue
        .continuation
        .clone()
        .unwrap_or_else(|| ace_core::person_input::CONTINUE_MESSAGE.to_owned());
    let trigger = queue
        .trigger
        .clone()
        .unwrap_or_else(|| "restart".to_owned());
    let reason = if kept {
        queue.reason.clone()
    } else {
        Some("restart".to_owned())
    };
    let exited = if kept { queue.exited } else { true };
    let now = core.ports.now();
    let mut patch = ace_json::Map::new();
    patch.insert("continuation", Value::from(continuation));
    patch.insert("trigger", Value::from(trigger));
    patch.insert("paused", Value::Bool(true));
    patch.insert("reason", reason.map_or(Value::Null, Value::from));
    patch.insert("exited", Value::Bool(exited));
    patch.insert("holdToken", Value::from(queue.hold_token + 1));
    queue_write::set(
        &core.store,
        thread,
        &ace_json::to_string(&Value::Object(patch)),
        now,
    )?;
    crate::queue::holds::sync(core, state, thread, now)
}

/// `recovery.closeSettled()` (`recovery.ts:222`): a settled thread is finished for the person, so
/// a turn a Stop or a restart left on hold is over rather than waiting forever.
pub fn close_settled(core: &Core, thread: &str) -> Result<(), EngineError> {
    core.with_state(|state| close_settled_in(core, state, thread))?
}

pub(super) fn close_settled_in(
    core: &Core,
    state: &mut State,
    thread: &str,
) -> Result<(), EngineError> {
    if !super::threads::get(&core.store, thread)?.is_some_and(|row| row.settled) {
        return Ok(());
    }
    let queue = queue_store::get(&core.store, thread)?;
    if !queue.paused || queue.limited {
        return Ok(());
    }
    if !matches!(queue.reason.as_deref(), Some("restart") | Some("stopped")) {
        return Ok(());
    }
    // Child results wait under the hold too: sent, they would start a turn in a settled thread.
    if queue_store::waiting_sends(core.store.conn(), thread)? > 0 {
        return Ok(());
    }
    if queue_store::has_uncertain(core.store.conn(), thread)?
        || crate::intents::store::recovering(core.store.conn(), thread)?
    {
        return Ok(());
    }
    crate::intents::store::finish_continuation(core.store.conn(), thread)?;
    let patch = format!(
        r#"{{"paused":false,"reason":null,"continuation":null,"trigger":null,"holdToken":{}}}"#,
        queue.hold_token + 1
    );
    let now = core.ports.now();
    queue_write::set(&core.store, thread, &patch, now)?;
    crate::queue::holds::sync(core, state, thread, now)
}

/// `recovery.discard()` (`recovery.ts:244`): resumable work goes, the queue is released.
pub fn discard(core: &Core, thread: &str) -> Result<(), EngineError> {
    discard_holding(core, thread, RELEASED)
}

/// `recovery.discardKeepingStop()` (`recovery.ts:203`): cancelling a subtree discards resumable
/// work but keeps a Stop's hold for the person.
pub fn discard_keeping_stop(core: &Core, thread: &str) -> Result<(), EngineError> {
    let hold = if stopped_hold(&queue_store::get(&core.store, thread)?) {
        STOPPED
    } else {
        RELEASED
    };
    discard_holding(core, thread, hold)
}

/// `recovery.discardHolding()` (`recovery.ts:252`): discard with the hold in the same write, so
/// the thread never reads as waiting to send in between.
pub fn discard_holding(core: &Core, thread: &str, hold: QueueHold) -> Result<(), EngineError> {
    core.with_state(|state| discard_holding_in(core, state, thread, hold))??;
    crate::queue::holds::schedule(core)
}

pub(super) fn discard_holding_in(
    core: &Core,
    state: &mut State,
    thread: &str,
    hold: QueueHold,
) -> Result<(), EngineError> {
    core.store.atomic(|_| {
        let queue = queue_store::get(&core.store, thread)?;
        for intent in crate::intents::header::headers(core.store.conn(), Some(thread), None)? {
            if CANCEL_KINDS.contains(&intent.kind.as_str())
                && matches!(intent.status.as_str(), "pending" | "queued" | "running")
            {
                crate::intents::lifecycle::mark(
                    &core.store,
                    &intent,
                    "failed",
                    Some("Cancelled before delivery"),
                )?;
            }
        }
        let mut patch = ace_json::Map::new();
        patch.insert("continuation", Value::Null);
        patch.insert("trigger", Value::Null);
        patch.insert("paused", Value::Bool(hold.paused));
        patch.insert("reason", hold.reason.map_or(Value::Null, Value::from));
        patch.insert("limited", Value::Bool(false));
        patch.insert("resetAt", Value::Null);
        patch.insert("resumeAt", Value::Null);
        patch.insert("timerAction", Value::Null);
        patch.insert("holdToken", Value::from(queue.hold_token + 1));
        queue_write::set(
            &core.store,
            thread,
            &ace_json::to_string(&Value::Object(patch)),
            core.ports.now(),
        )?;
        crate::queue::holds::sync(core, state, thread, core.ports.now())
    })
}

/// `recovery.dropContinuationBehindStop()` (`recovery.ts:211`): builds before the Stop rule
/// captured a restart "continue" behind a Stop, which left a cancelled thread waiting forever.
pub fn drop_continuation_behind_stop(core: &Core, thread: &str) -> Result<(), EngineError> {
    core.with_state(|state| drop_continuation_behind_stop_in(core, state, thread))?
}

pub(super) fn drop_continuation_behind_stop_in(
    core: &Core,
    state: &mut State,
    thread: &str,
) -> Result<(), EngineError> {
    let queue = queue_store::get(&core.store, thread)?;
    if !stopped_hold(&queue) || queue.trigger.as_deref() != Some("restart") {
        return Ok(());
    }
    let now = core.ports.now();
    queue_write::set(
        &core.store,
        thread,
        r#"{"continuation":null,"trigger":null}"#,
        now,
    )?;
    crate::queue::holds::sync(core, state, thread, now)
}

/// A shutdown captures every actor's work before any session closes (`index.ts:1444`).
pub fn capture_all_restarts(core: &Core) -> Result<(), EngineError> {
    let threads: Vec<String> =
        core.with_state(|state| state.actors.by_thread.keys().cloned().collect())?;
    for thread in threads {
        capture_restart(core, &thread)?;
    }
    Ok(())
}

/// The background work a stop took with it, read over the thread's resident state.
fn lost_lines(
    core: &Core,
    state: &mut State,
    thread: &str,
    acknowledged: usize,
    now: f64,
) -> Result<Option<Vec<String>>, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
    Ok(crate::restart::lost_work_lines(
        &borrowed.state,
        acknowledged,
        now as i64,
    ))
}

/// The request the agent was waiting on the person to answer, read over its resident state.
fn open_request(
    core: &Core,
    state: &mut State,
    thread: &str,
) -> Result<Option<String>, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let keys: Vec<String> = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        borrowed
            .state
            .indexes
            .pending_interactions
            .keys()
            .cloned()
            .collect()
    };
    let mut borrowed = snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?;
    // Interactions are a lazy record section: load the ones the index names so the capture
    // reads the request the agent actually waits on, not an empty map.
    for key in keys {
        if borrowed.state.interactions.contains_key(&key) {
            continue;
        }
        if let Some(interaction) = borrowed.interactions.read(&key)? {
            borrowed.state.interactions.insert(key, interaction);
        }
    }
    Ok(crate::restart::open_request_line(&borrowed.state))
}

/// Whether the thread's root agent has a run in flight.
fn root_active_run(core: &Core, state: &mut State, thread: &str) -> Result<bool, EngineError> {
    let snapshot = state.repo.state(&core.store, thread)?;
    let Some(snapshot) = snapshot else {
        return Ok(false);
    };
    let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
    let root = borrowed.state.root_key.clone();
    Ok(root.is_some_and(|root| {
        borrowed
            .state
            .agents
            .get(&root)
            .is_some_and(|record| record.active_run.is_some())
    }))
}

#[cfg(test)]
mod tests;
