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
        && !root_limited(core, state, thread)?
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

/// Whether the thread's root agent still carries quota evidence (`recovery.ts:163`): the root
/// record as the store holds it, not only as the state happens to have it resident. A thread
/// with no stored state has no root, which reads as not limited.
fn root_limited(core: &Core, state: &mut State, thread: &str) -> Result<bool, EngineError> {
    let Some(snapshot) = state.repo.state(&core.store, thread)? else {
        return Ok(false);
    };
    let mut borrowed = snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?;
    let Some(root) = borrowed.state.root_key.clone() else {
        return Ok(false);
    };
    Ok(borrowed
        .agent(&root)?
        .is_some_and(|record| record.limited.is_some()))
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
/// The schedule and wake follow outside any `State` borrow, so a caller that already holds one
/// calls [`lift_in`] and then does them itself.
pub fn lift(core: &Core, state: &mut State, thread: &str, at: f64) -> Result<(), EngineError> {
    lift_in(core, state, thread, at)?;
    schedule(core)?;
    wake(core, thread);
    Ok(())
}

/// `Recovery.lift`'s writes, with no port call: the queue, the root's quota evidence and sync.
pub fn lift_in(core: &Core, state: &mut State, thread: &str, at: f64) -> Result<(), EngineError> {
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
    sync(core, state, thread, at)
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
        // the receipt back. That answer decides the arming too, so the deferred arm never asks
        // again after the receipt committed (a throw there would be swallowed).
        let admits = core.ports.admits()?;
        core.defer(Deferred::AfterPublish(Box::new(move || {
            if let Some(core) = ask.upgrade() {
                let _ = arm(&core, Some(admits));
            }
        })));
        return Ok(());
    }
    arm_weak(core)
}

fn arm_weak(core: &Core) -> Result<(), EngineError> {
    match core.self_weak.borrow().upgrade() {
        Some(core) => arm(&core, None),
        None => Ok(()),
    }
}

/// Arm the queue's next deadline; its firing is E5.8's `recovery::fire`. `gate` is the receipt's
/// own `admits` answer, read before the commit.
fn arm(core: &Rc<Core>, gate: Option<bool>) -> Result<(), EngineError> {
    crate::recovery::deadline::prune_deferrals(core)?;
    let previous = core.with_state(|state| state.recovery.cancel.take())?;
    if let Some(key) = previous {
        core.ports.cancel_timer(key);
    }
    // No deadline runs while maintenance holds new work or after close.
    if core.with_state(|state| state.recovery.closed)? {
        return Ok(());
    }
    let admits = match gate {
        Some(answer) => answer,
        None => core.ports.admits()?,
    };
    if !admits {
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
    let task = core.executor.spawn(Lane::Work, async move {
        if timer.fired.await.is_err() {
            return;
        }
        // Only the deadline still armed when the timer fired reports, and never one that fires
        // as the engine closes: a replaced or cancelled timer reports nothing.
        let report = ask
            .with_state(|state| {
                if state.recovery.cancel == Some(key) {
                    state.recovery.cancel = None;
                    !state.recovery.closed
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if !report || ask.closing.get() {
            return;
        }
        crate::recovery::deadline::fire(&ask);
    });
    // The task must outlive this call: a dropped `Task` cancels the waiter, so the deadline
    // would never report. `shut` stops it through the executor's admission, and a cancelled
    // timer resolves the receiver with an error.
    task.detach();
    Ok(())
}

/// `recovery.wake` through the after-commit queue.
pub fn wake(core: &Core, thread: &str) {
    core.defer(Deferred::Wake(thread.to_owned(), Lane::Work));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::ActorDeps;
    use crate::executor::{Budget, Notified, Notifier};
    use crate::frames::live::UnportedLive;
    use crate::repository::testsupport::{Shell, header, home};
    use std::sync::Arc;

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    struct Turn;

    impl Budget for Turn {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }

    /// An engine over `conn`, with the shell's timers and reports under the test's control.
    fn engine_on(conn: &Arc<ace_store::Connection>) -> (crate::Engine, std::rc::Rc<Shell>) {
        let (_, shell) = Shell::store_with_controls(conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell.clone(),
            crate::Inputs::default(),
            "[]",
            Box::new(ManualPump),
            conn,
            std::rc::Rc::new(ActorDeps::production(std::rc::Rc::new(UnportedLive), 0.0)),
        )
        .unwrap();
        (engine, shell)
    }

    /// Turns the pump until nothing is left, so a deferred or fired task runs.
    fn settle(engine: &crate::Engine) {
        for _ in 0..8 {
            let mut budget = Turn;
            engine.pump(&mut budget);
        }
    }

    fn with_deadline(conn: &Arc<ace_store::Connection>) {
        conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 9000)")
            .unwrap();
    }

    /// A deadline already due at the shell's clock (which reads 0).
    fn with_due_deadline(conn: &Arc<ace_store::Connection>) {
        conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 0)")
            .unwrap();
    }

    /// How many automatic Resume receipts the engine wrote.
    fn engine_commands(conn: &Arc<ace_store::Connection>) -> i64 {
        let row = ace_store::stmt_cache::get_row(
            conn,
            "SELECT COUNT(*) AS n FROM command_receipts WHERE device_id='engine'",
            Vec::new(),
        )
        .unwrap()
        .unwrap();
        row.get("n")
            .and_then(crate::repository::residency::cell_int)
            .unwrap_or(0)
    }

    /// The deadline timer's key, as the engine holds it (the sweep arms its own).
    fn armed_deadline(engine: &crate::Engine) -> u64 {
        engine
            .core()
            .with_state(|state| state.recovery.cancel)
            .unwrap()
            .expect("a deadline is armed")
    }

    #[test]
    fn a_cold_still_limited_root_keeps_its_hold() {
        // The root's quota evidence is only in the stored header: no snapshot is resident, so a
        // hold must not read as stale and turn into a cleared marker with its timer cancelled.
        let conn = home("t", &limited_header("t"));
        conn.exec(
            "INSERT INTO engine_queue (thread_id, resume_at, paused, reason, limited, reset_at, hold_token)
             VALUES ('t', 9000, 1, 'limit', 1, 9000, 4)",
        )
        .unwrap();
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        let mut state = crate::State::default();
        sync(core, &mut state, "t", 1_000.0).unwrap();
        let row = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT reason, limited, reset_at, hold_token FROM engine_queue WHERE thread_id='t'",
            Vec::new(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.get("reason"),
            Some(&ace_store::Value::Text("limit".into()))
        );
        assert_eq!(row.get("limited"), Some(&ace_store::Value::Integer(1)));
        assert_eq!(row.get("reset_at"), Some(&ace_store::Value::Integer(9000)));
        assert_eq!(row.get("hold_token"), Some(&ace_store::Value::Integer(4)));
        assert!(
            core.with_state(|state| state.recovery.cancel.is_none())
                .unwrap()
        );
    }

    #[test]
    fn a_due_deadline_resumes_once_and_firing_its_timer_again_does_nothing() {
        let conn = home("t", &header("t"));
        with_due_deadline(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        schedule(core).unwrap();
        settle(&engine);
        let key = armed_deadline(&engine);
        // The timer fires the automatic Resume once; the deadline is consumed with it.
        shell.fire(key);
        settle(&engine);
        assert_eq!(engine_commands(&conn), 1);
        let row = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT resume_at FROM engine_queue WHERE thread_id='t'",
            Vec::new(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(row.get("resume_at"), Some(&ace_store::Value::Null));
        assert!(
            core.with_state(|state| state.recovery.cancel.is_none())
                .unwrap()
        );
        // The same timer key again reaches no task: it settled its run.
        shell.fire(key);
        settle(&engine);
        assert_eq!(engine_commands(&conn), 1);
    }

    #[test]
    fn a_fired_deadline_replaced_before_the_pump_never_acts_and_the_replacement_does() {
        let conn = home("t", &header("t"));
        with_due_deadline(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        schedule(core).unwrap();
        settle(&engine);
        let first = armed_deadline(&engine);
        shell.fire(first);
        // The next receipt replaces the deadline before the fired task gets its turn.
        schedule(core).unwrap();
        settle(&engine);
        assert_eq!(engine_commands(&conn), 0, "the replaced deadline acted");
        assert!(
            core.with_state(|state| state.recovery.cancel.is_some())
                .unwrap(),
            "the replacement stays armed"
        );
        // The replacement is the one that acts, once.
        let replacement = armed_deadline(&engine);
        shell.fire(replacement);
        settle(&engine);
        assert_eq!(engine_commands(&conn), 1);
    }

    #[test]
    fn a_deadline_that_fires_as_the_engine_closes_acts_on_nothing() {
        let conn = home("t", &header("t"));
        with_due_deadline(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        schedule(core).unwrap();
        settle(&engine);
        let key = armed_deadline(&engine);
        core.with_state(|state| {
            state.recovery.closed = true;
            state.recovery.cancel = None;
        })
        .unwrap();
        shell.fire(key);
        settle(&engine);
        assert_eq!(engine_commands(&conn), 0);
        let row = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT resume_at FROM engine_queue WHERE thread_id='t'",
            Vec::new(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(row.get("resume_at"), Some(&ace_store::Value::Integer(0)));
    }

    #[test]
    fn a_receipt_reads_the_gate_once_and_its_answer_arms_the_deadline() {
        let conn = home("t", &header("t"));
        with_deadline(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        // A second `admits` call would throw: only the receipt's own answer may be used.
        shell.throw_admits_from(2);
        core.store
            .atomic(|_tx| {
                schedule(core)?;
                Ok(())
            })
            .unwrap();
        settle(&engine);
        assert_eq!(shell.admits_calls(), 1);
        assert!(shell.armed().contains(&armed_deadline(&engine)));
    }

    #[test]
    fn a_refused_gate_arms_no_deadline() {
        let conn = home("t", &header("t"));
        with_deadline(&conn);
        let (engine, shell) = engine_on(&conn);
        shell.answer_admits(Some(false));
        schedule(engine.core()).unwrap();
        settle(&engine);
        assert!(
            engine
                .core()
                .with_state(|state| state.recovery.cancel.is_none())
                .unwrap()
        );
    }

    #[test]
    fn a_gate_that_throws_inside_a_receipt_rolls_back_and_keeps_the_old_timer() {
        let conn = home("t", &header("t"));
        with_deadline(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        schedule(core).unwrap();
        settle(&engine);
        let old = armed_deadline(&engine);
        shell.throw_admits_from(shell.admits_calls() + 1);
        let outcome = core.store.atomic(|_tx| {
            schedule(core)?;
            Ok(())
        });
        assert!(outcome.is_err());
        settle(&engine);
        // The old timer is still armed and never cancelled: nothing committed.
        assert!(shell.armed().contains(&old));
        assert!(!shell.cancelled().contains(&old));
    }

    /// A stored header whose root agent still carries its quota evidence.
    fn limited_header(thread: &str) -> String {
        let mut state: ace_core::state::ThreadState =
            ace_json::from_value(&ace_json::parse(&header(thread)).unwrap()).unwrap();
        state.root_key = Some("root".to_owned());
        let record: ace_core::state::AgentRecord = ace_json::from_value(
            &ace_json::parse(&format!(
                r#"{{"agent":{{"id":"root","threadId":"{thread}","parentId":null,"origin":"person","native":{{"provider":"codex","nativeId":"native-root"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"idle"}},"createdAt":0}},"activity":"idle","lastSignalAt":0,"limited":{{"until":9000}}}}"#
            ))
            .unwrap(),
        )
        .unwrap();
        state.agents.insert("root".to_owned(), record);
        let text = ace_json::ser::to_string(&state).unwrap();
        format!(r#"{{"engineSnapshot":9,{}"#, &text[1..])
    }
}
