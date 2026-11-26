// SPDX-License-Identifier: Apache-2.0
//! `Recovery`'s hold paths (`recovery.ts:618`-`:627`, `:717`-`:739`, `:780`-`:840`, E5.4d): the
//! queue sync a receipt ends with, limit and snooze hold release, the hold token, the binding
//! change and the deadline timer. Firing a deadline (`recovery::fire`) stays E5.8's.

use ace_json::Value;
use std::rc::{Rc, Weak};

use crate::executor::{Deferred, Lane};
use crate::{Core, EngineError, State};

/// `recovery.sync`: clients see the queue's shown state, then core learns the retained work.
pub fn sync(core: &Core, state: &mut State, thread: &str, now: f64) -> Result<(), EngineError> {
    let held = crate::queue::store::get(&core.store, thread)?;
    // `recovery.ts:166`-`:172`: an older build could leave the child's quota hold on the parent's
    // account. Retire it, keeping the child's own quota evidence.
    if held.limited
        && !root_limited(state, thread)
        && matches!(held.reason.as_deref(), Some("limit") | Some("snooze"))
        && !crate::intents::store::recovering(core.store.conn(), thread)?
    {
        binding_changed(core, thread, now)?;
    }
    let queue = crate::queue::store::shown(&core.store, thread)?;
    let saved = core
        .store
        .get_thread(thread)?
        .and_then(|text| ace_json::parse(&text).ok())
        .and_then(|row| row.get("queue").cloned());
    let same = saved.as_ref().is_some_and(|saved| {
        saved.get("pendingCount").and_then(Value::as_i64) == Some(queue.pending_count)
            && saved.get("revision").and_then(Value::as_i64) == Some(queue.revision)
    });
    if !same {
        let mut next = ace_json::Map::new();
        next.insert("paused", Value::Bool(queue.paused));
        next.insert(
            "reason",
            queue.reason.as_deref().map_or(Value::Null, Value::from),
        );
        next.insert(
            "resumeAt",
            queue
                .resume_at
                .map_or(Value::Null, |at| Value::from(at as f64)),
        );
        next.insert("revision", Value::from(queue.revision as f64));
        next.insert("pendingCount", Value::from(queue.pending_count as f64));
        if queue.exited {
            next.insert("exited", Value::Bool(true));
        }
        let woken =
            crate::queue::wake::wake_for(&core.store, thread, &Value::Object(next.clone()), now)?;
        let mut events = woken;
        let mut updated = ace_json::Map::new();
        updated.insert("type", Value::from("queue.updated"));
        for (key, value) in next {
            updated.insert(key, value);
        }
        events.push(Value::Object(updated));
        core.store.write_events(
            thread,
            &ace_json::to_string(&Value::Array(events.into())),
            now,
        )?;
    }
    if let Some(fact) = engine_queue_fact(state, core, thread)? {
        state.apply(
            &core.store,
            thread,
            &ace_json::to_string(&Value::Array(vec![fact].into())),
            now,
            None,
        )?;
    }
    Ok(())
}

/// Whether the thread's root agent still carries quota evidence. A thread with no resident
/// snapshot has no root, which reads as not limited (`recovery.ts:163`).
fn root_limited(state: &State, thread: &str) -> bool {
    let Some(snapshot) = state.repo.snapshots.get(thread) else {
        return false;
    };
    let borrowed = snapshot.borrow();
    let Some(root) = borrowed.state.root_key.as_deref() else {
        return false;
    };
    borrowed
        .state
        .agents
        .get(root)
        .is_some_and(|record| record.limited.is_some())
}

/// `repo.engineQueueFact` (`repository.ts:586`) over the receipt's own state.
fn engine_queue_fact(
    state: &mut State,
    core: &Core,
    thread: &str,
) -> Result<Option<Value>, EngineError> {
    let count = state.queued_count(&core.store, thread)?;
    let held = count > 0 && crate::queue::store::held_on_failed_send(core.store.conn(), thread)?;
    let stopped =
        count > 0 && !held && crate::queue::store::stopped_by_person(core.store.conn(), thread)?;
    if let Some(snapshot) = state.repo.snapshots.get(thread) {
        let borrowed = snapshot.borrow();
        if borrowed.state.queue_sources.engine == count
            && borrowed.state.queue_held.unwrap_or(false) == held
            && borrowed.state.queue_stopped.unwrap_or(false) == stopped
        {
            return Ok(None);
        }
    }
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("queue.changed"));
    fact.insert("source", Value::from("engine"));
    fact.insert("count", Value::from(count));
    if held {
        fact.insert("held", Value::Bool(true));
    }
    if stopped {
        fact.insert("stopped", Value::Bool(true));
    }
    Ok(Some(Value::Object(fact)))
}

/// `recovery.releaseLimitHold` (`:717`): the person's message is the go-ahead for a limit hold.
pub fn release_limit_hold(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    let queue = crate::queue::store::get(&core.store, thread)?;
    if !queue.paused {
        return Ok(());
    }
    let limit_hold = matches!(queue.reason.as_deref(), Some("limit") | Some("snooze"));
    let cleared =
        !queue.limited && queue.reason.as_deref() == Some("manual") && queue.reset_at.is_some();
    if (!limit_hold && !cleared)
        || crate::queue::store::has_uncertain(core.store.conn(), thread)?
        || crate::intents::store::recovering(core.store.conn(), thread)?
    {
        return Ok(());
    }
    lift(core, state, thread, at)
}

/// `Recovery.lift` (`:733`): lift a limit hold nothing holds any more, with no continuation.
pub fn lift(core: &Core, state: &mut State, thread: &str, at: f64) -> Result<(), EngineError> {
    let queue = crate::queue::store::get(&core.store, thread)?;
    crate::intents::store::finish_continuation(core.store.conn(), thread)?;
    let patch = format!(
        r#"{{"limited":false,"paused":false,"reason":null,"resetAt":null,"resumeAt":null,"timerAction":null,"continuation":null,"trigger":null,"holdToken":{}}}"#,
        queue.hold_token + 1
    );
    crate::queue::write::set(&core.store, thread, &patch, at)?;
    let cleared = cleared_limits(state, thread);
    if !cleared.is_empty() {
        state.apply(
            &core.store,
            thread,
            &ace_json::to_string(&Value::Array(cleared.into())),
            at,
            None,
        )?;
    }
    sync(core, state, thread, at)?;
    schedule(core)?;
    wake(core, thread);
    Ok(())
}

/// The `limit.cleared` facts a root's limited record deserves.
fn cleared_limits(state: &mut State, thread: &str) -> Vec<Value> {
    let Some(snapshot) = state.repo.snapshots.get(thread) else {
        return Vec::new();
    };
    let borrowed = snapshot.borrow();
    let root = borrowed.state.root_key.clone();
    borrowed
        .state
        .agents
        .iter()
        .filter(|(key, record)| Some((*key).clone()) == root && record.limited.is_some())
        .map(|(key, _)| {
            let mut fact = ace_json::Map::new();
            fact.insert("type", Value::from("limit.cleared"));
            fact.insert("agent", Value::from(key.as_str()));
            Value::Object(fact)
        })
        .collect()
}

/// `Recovery.owns`: the hold token the caller read is still the thread's.
pub fn owns(core: &Core, thread: &str, token: i64) -> Result<bool, EngineError> {
    Ok(crate::queue::store::get(&core.store, thread)?.hold_token == token)
}

/// `Recovery.begin`: clear the root's limit evidence for the hold the caller owns.
pub fn begin(
    core: &Core,
    state: &mut State,
    thread: &str,
    token: i64,
    at: f64,
) -> Result<bool, EngineError> {
    if !owns(core, thread, token)? {
        return Ok(false);
    }
    let cleared = cleared_limits(state, thread);
    if !cleared.is_empty() {
        state.apply(
            &core.store,
            thread,
            &ace_json::to_string(&Value::Array(cleared.into())),
            at,
            None,
        )?;
    }
    Ok(true)
}

/// `Recovery.release`: the hold the caller owns no longer holds.
pub fn release(core: &Core, thread: &str, token: i64, at: f64) -> Result<(), EngineError> {
    if !owns(core, thread, token)? {
        return Ok(());
    }
    crate::queue::write::set(
        &core.store,
        thread,
        r#"{"limited":false,"paused":false,"reason":null,"resumeAt":null,"timerAction":null}"#,
        at,
    )
}

/// `Recovery.bindingChanged` (`:724`): a limit or snooze hold becomes a cleared-limit marker.
pub fn binding_changed(core: &Core, thread: &str, at: f64) -> Result<(), EngineError> {
    let queue = crate::queue::store::get(&core.store, thread)?;
    let left = queue.paused && matches!(queue.reason.as_deref(), Some("limit") | Some("snooze"));
    let patch = format!(
        r#"{{"limited":false,"resetAt":{},"resumeAt":null,"timerAction":null,"holdToken":{},"reason":{}}}"#,
        if left {
            format!("{}", at as i64)
        } else {
            "null".to_owned()
        },
        queue.hold_token + 1,
        if left {
            "\"manual\"".to_owned()
        } else {
            queue
                .reason
                .as_deref()
                .map_or("null".to_owned(), |reason| format!("\"{reason}\""))
        }
    );
    crate::queue::write::set(&core.store, thread, &patch, at)?;
    schedule(core)
}

/// `Recovery.schedule` (`:618`): cancel the previous deadline and arm the next at commit.
pub fn schedule(core: &Core) -> Result<(), EngineError> {
    let ask: Weak<Core> = core.self_weak.borrow().clone();
    if core.ports.is_transaction_open() {
        // Read the port now, as TypeScript's `schedule` does inside the receipt: a throw rolls
        // the receipt back. The arming itself waits for the commit.
        let _admits = core.ports.admits()?;
        core.defer(Deferred::AfterPublish(Box::new(move || {
            if let Some(core) = ask.upgrade() {
                let _ = arm(&core);
            }
        })));
        return Ok(());
    }
    arm_weak(core)
}

fn arm_weak(core: &Core) -> Result<(), EngineError> {
    match core.self_weak.borrow().upgrade() {
        Some(core) => arm(&core),
        None => Ok(()),
    }
}

/// Arm the queue's next deadline; its firing is E5.8's `recovery::fire`.
fn arm(core: &Rc<Core>) -> Result<(), EngineError> {
    let previous = core.with_state(|state| state.recovery.cancel.take())?;
    if let Some(key) = previous {
        core.ports.cancel_timer(key);
    }
    // No deadline runs while maintenance holds new work or after close.
    if core.with_state(|state| state.recovery.closed)? || !core.ports.admits()? {
        return Ok(());
    }
    let Some(at) = crate::queue::deadline::next_deadline(core.store.conn())? else {
        return Ok(());
    };
    let timer = core
        .ports
        .set_timer((at as f64 - core.ports.now()).max(0.0));
    let key = timer.key;
    core.with_state(|state| state.recovery.cancel = Some(key))?;
    let ask = Rc::clone(core);
    let _timer = core.executor.spawn(Lane::Work, async move {
        if timer.fired.await.is_err() {
            return;
        }
        let _ = ask.with_state(|state| {
            if state.recovery.cancel == Some(key) {
                state.recovery.cancel = None;
            }
        });
        ask.ports
            .report(EngineError::not_ported("a recovery deadline", "E5.8").to_string());
    });
    Ok(())
}

/// `recovery.wake` through the after-commit queue.
pub fn wake(core: &Core, thread: &str) {
    core.defer(Deferred::Wake(thread.to_owned(), Lane::Work));
}
