// SPDX-License-Identifier: Apache-2.0
//! Cursor turns a restart cut short, reconciled with Cursor's own store before they are called
//! failed (`cursor-reconcile.ts`, ADR 0043's 2026-11-22 amendment). This file holds the queue of
//! threads a startup marked: their lanes stay shut while a reconcile waits or runs, so a Resume
//! cannot open a second session that fences it.

use crate::executor::Lane;
use crate::sessions::attach::OpenFailure;
use crate::sessions::open_session::OpenRefusal;
use ace_json::Value;
use indexmap::IndexSet;
use std::collections::HashMap;
use std::rc::Rc;

use crate::{Core, EngineError, State};

/// The threads a startup marked for reconcile, and those still held (`CursorReconciles`).
#[derive(Debug, Default)]
pub struct CursorReconciles {
    /// Marked by startup, not started yet.
    pub(crate) marked: IndexSet<String>,
    /// Marked or reconciling: no other work of theirs starts until it ends.
    pub(crate) held: IndexSet<String>,
    /// Close ran: nothing more is scheduled or opened.
    pub(crate) closed: bool,
    timers: HashMap<String, u64>,
}

/// `add` (`cursor-reconcile.ts:247`): a thread whose cut-off Cursor work waits for its reconcile.
pub fn mark(state: &mut crate::State, thread: &str) {
    if !state.cursor.closed && state.cursor.held.insert(thread.to_owned()) {
        state.cursor.marked.insert(thread.to_owned());
    }
}

/// `holds` (`:256`): true while a thread waits for or runs its reconcile, busy retries included.
pub fn holds(state: &crate::State, thread: &str) -> bool {
    state.cursor.held.contains(thread)
}

/// `close` (`:317`): no reconcile starts or retries after this.
pub fn close(state: &mut crate::State) {
    state.cursor.closed = true;
}

/// The threads startup marked, in marking order (`start`, `:259`).
pub fn take_marked(state: &mut crate::State) -> Vec<String> {
    std::mem::take(&mut state.cursor.marked)
        .into_iter()
        .collect()
}

/// `release` (`:307`): the thread's lanes open again.
pub fn release(state: &mut crate::State, thread: &str) {
    state.cursor.marked.shift_remove(thread);
    state.cursor.held.shift_remove(thread);
}

/// Start reconciles only after startup has published readiness.
pub(crate) fn start(core: &Rc<Core>) {
    let threads = match core.with_state(take_marked) {
        Ok(threads) => threads,
        Err(error) => {
            core.ports.report(error.to_string());
            return;
        }
    };
    for thread in threads {
        let owner = Rc::clone(core);
        core.executor
            .spawn(Lane::Work, async move { reconcile(&owner, &thread).await })
            .detach();
    }
}

pub(crate) fn cancel(core: &Core) {
    let timers = core.with_state(|state| {
        close(state);
        std::mem::take(&mut state.cursor.timers)
    });
    if let Ok(timers) = timers {
        for key in timers.into_values() {
            core.ports.cancel_timer(key);
        }
    }
}

async fn reconcile(core: &Rc<Core>, thread: &str) {
    match reconcile_once(core, thread).await {
        Ok(()) => {}
        Err(error) => {
            core.ports.report(format!("{thread}: {error}"));
            let mut waits = FailureWaits::new(&BUSY_RETRY_MS);
            loop {
                if core.closing.get() {
                    return;
                }
                let outcome = core.store.atomic(|_| {
                    core.with_state(|state| end_failed(core, state, thread, core.ports.now()))?
                });
                match outcome {
                    Ok(()) => break,
                    Err(error) => core.ports.report(format!("{thread}: {error}")),
                }
                if !sleep(core, thread, waits.next().unwrap_or(60_000.0)).await {
                    return;
                }
            }
        }
    }
    if core.closing.get() {
        return;
    }
    let result = core
        .with_state(|state| release(state, thread))
        .and_then(|()| crate::queue::worker::wake(core, thread));
    if let Err(error) = result {
        core.ports.report(format!("{thread}: {error}"));
    }
}

async fn sleep(core: &Core, thread: &str, ms: f64) -> bool {
    if core.closing.get() {
        return false;
    }
    let timer = core.ports.set_timer(ms);
    if core
        .with_state(|state| state.cursor.timers.insert(thread.to_owned(), timer.key))
        .is_err()
    {
        core.ports.cancel_timer(timer.key);
        return false;
    }
    let fired = timer.fired.await.is_ok();
    let _ = core.with_state(|state| state.cursor.timers.remove(thread));
    fired && !core.closing.get()
}

async fn reconcile_once(core: &Rc<Core>, thread: &str) -> Result<(), EngineError> {
    if core.closing.get() || crate::queue::worker::fenced(core, thread)? {
        return Ok(());
    }
    let was_running = root_active(core, thread)?;
    let reserved = core.with_state(|state| state.reserve_slot(&core.store, thread))??;
    if !reserved {
        return Err(EngineError::ActorCapacityExceeded);
    }
    crate::actor::get_or_create(core, &thread.to_owned())?;
    let mut waits = BUSY_RETRY_MS.into_iter();
    loop {
        match crate::sessions::connect::stored(core, thread).await {
            Ok(()) => break,
            Err(OpenFailure::Refused(
                OpenRefusal::Closing
                | OpenRefusal::Deleted
                | OpenRefusal::Cleaning
                | OpenRefusal::Fenced,
            )) => return Ok(()),
            Err(OpenFailure::Provider(message)) if message.contains("session_store_busy") => {
                let Some(wait) = waits.next() else {
                    return Err(EngineError::Records(message));
                };
                if !sleep(core, thread, wait).await {
                    return Ok(());
                }
            }
            Err(error) => {
                return Err(EngineError::Records(format!(
                    "Cursor restart could not open the session: {error:?}"
                )));
            }
        }
    }
    crate::actor::mailbox::flush(Rc::clone(core), thread.to_owned(), core.executor.current()).await;
    if core.closing.get() || crate::queue::worker::fenced(core, thread)? {
        return Ok(());
    }
    if was_running && root_active(core, thread)? {
        crate::sessions::attach::close_for_settle(core, &thread.to_owned()).await?;
        if core.closing.get() || crate::queue::worker::fenced(core, thread)? {
            return Ok(());
        }
        return Err(EngineError::Records(
            "Cursor restart did not recover the active turn".into(),
        ));
    }
    core.store.atomic(|_| {
        core.with_state(|state| {
            let at = core.ports.now();
            if !was_running || finished(core, state, thread)? {
                release_hold(core, state, thread, at)?;
            } else {
                let snapshot = state.repo.require_state(&core.store, thread)?;
                let root = snapshot.borrow().state.root_key.clone();
                let fact = crate::restart::interrupted_notice(root.as_deref(), at, "restart", None);
                state.apply(
                    &core.store,
                    thread,
                    &ace_json::to_string(&Value::Array(vec![fact].into())),
                    at,
                    None,
                )?;
            }
            Ok(())
        })?
    })
}

fn root_active(core: &Core, thread: &str) -> Result<bool, EngineError> {
    core.with_state(|state| {
        let snapshot = state.repo.require_state(&core.store, thread)?;
        let mut snapshot = snapshot.borrow_mut();
        snapshot.hydrate_recovery()?;
        Ok(snapshot
            .state
            .root_key
            .as_deref()
            .and_then(|root| snapshot.state.agents.get(root))
            .is_some_and(|root| root.active_run.is_some()))
    })?
}

// ---------------------------------------------------------------------------------------------
// What a reconcile that cannot finish applies (`cursor-reconcile.ts:63`-`:173`)
// ---------------------------------------------------------------------------------------------

/// About 12 s in all, doubling from a tenth of a second (`cursor-reconcile.ts:60`).
pub const BUSY_RETRY_MS: [f64; 7] = [100.0, 200.0, 400.0, 800.0, 1600.0, 3200.0, 6000.0];

/// What a restart has always applied to cut-off Cursor work it could not reconcile
/// (`restartFailure`, `:63`): the uncertainty notice, the provider exit, the queue's provider
/// count and one interruption notice.
pub fn restart_failure(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<Vec<Value>, EngineError> {
    let (root, detail) = {
        let snapshot = state.repo.require_state(&core.store, thread)?;
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        (
            borrowed.state.root_key.clone(),
            crate::restart::lost_work(&borrowed.state, 0, Some("cursor-sdk"), at as i64),
        )
    };
    let mut facts = Vec::new();
    if let Some(detail) = detail {
        let mut draft = ace_json::Map::new();
        draft.insert("type", Value::from("notice"));
        draft.insert("level", Value::from("warning"));
        draft.insert("code", Value::from("recovery_uncertain"));
        draft.insert("title", Value::from("Recovery needed"));
        draft.insert("text", Value::from("Previous work needs reconciliation"));
        draft.insert("detail", Value::from(detail));
        draft.insert("complete", Value::Bool(true));
        facts.push(upsert(root.as_deref(), "recovery:uncertain", draft));
    }
    let mut exited = ace_json::Map::new();
    exited.insert("type", Value::from("process.exited"));
    exited.insert("deliberate", Value::Bool(false));
    exited.insert(
        "message",
        Value::from("Daemon restarted; previous provider work stopped"),
    );
    facts.push(Value::Object(exited));
    let mut changed = ace_json::Map::new();
    changed.insert("type", Value::from("queue.changed"));
    changed.insert("source", Value::from("provider"));
    changed.insert("count", Value::from(0));
    facts.push(Value::Object(changed));
    facts.push(crate::restart::interrupted_notice(
        root.as_deref(),
        at,
        "restart",
        None,
    ));
    Ok(facts)
}

/// True when the root's last turn ended completed (`finished`, `:96`).
pub fn finished(core: &Core, state: &mut State, thread: &str) -> Result<bool, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
    let root = borrowed.state.root_key.clone();
    let run = root
        .and_then(|root| borrowed.state.agents.get(&root).cloned())
        .and_then(|record| record.last_run)
        .and_then(|run| borrowed.state.runs.get(&run).cloned());
    Ok(run.is_some_and(|run| run.state == "completed"))
}

/// The queue's restart hold and its continuation go: the turn they were for is complete
/// (`release`, `:104`).
pub fn release_hold(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    let queue = crate::queue::store::get(&core.store, thread)?;
    if queue.trigger.as_deref() != Some("restart") && queue.reason.as_deref() != Some("restart") {
        return Ok(());
    }
    crate::intents::store::finish_continuation(core.store.conn(), thread)?;
    let held = queue.reason.as_deref() == Some("restart") && !queue.limited;
    let patch = if held {
        format!(
            r#"{{"continuation":null,"trigger":null,"paused":false,"reason":null,"holdToken":{}}}"#,
            queue.hold_token + 1
        )
    } else {
        format!(
            r#"{{"continuation":null,"trigger":null,"holdToken":{}}}"#,
            queue.hold_token + 1
        )
    };
    crate::queue::write::set(&core.store, thread, &patch, at)?;
    crate::queue::holds::sync(core, state, thread, at)
}

/// The turn a reconcile couldn't finish, failed with its queue held, and its send in doubt said
/// (`endFailed`, `:158`).
pub fn end_failed(
    core: &Core,
    state: &mut State,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    let active = {
        let snapshot = state.repo.require_state(&core.store, thread)?;
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        borrowed
            .state
            .root_key
            .as_ref()
            .and_then(|root| borrowed.state.agents.get(root))
            .is_some_and(|record| record.active_run.is_some())
    };
    if active {
        let facts = restart_failure(core, state, thread, at)?;
        core.store.atomic(|_| {
            state.apply(
                &core.store,
                thread,
                &ace_json::to_string(&Value::Array(facts.into())),
                at,
                None,
            )
        })?;
    }
    core.store.atomic(|_| {
        for intent in super::recovery::cursor_attempt::in_doubt(core, thread)? {
            super::recovery::cursor_attempt::unconfirmed(
                core,
                state,
                thread,
                intent.header.id,
                at,
            )?;
        }
        Ok(())
    })
}

/// The waits between tries to write a failed turn: the busy-store waits, then doubling to 60 s
/// (`failureWaits`, `:169`).
pub struct FailureWaits {
    first: Vec<f64>,
    index: usize,
    last: f64,
}

impl FailureWaits {
    pub fn new(first: &[f64]) -> FailureWaits {
        FailureWaits {
            first: first.to_vec(),
            index: 0,
            last: 100.0,
        }
    }
}

impl Iterator for FailureWaits {
    type Item = f64;

    fn next(&mut self) -> Option<f64> {
        if let Some(wait) = self.first.get(self.index) {
            self.last = *wait;
        } else {
            self.last = (self.last * 2.0).min(60_000.0);
        }
        self.index += 1;
        Some(self.last)
    }
}

fn upsert(root: Option<&str>, item: &str, draft: ace_json::Map) -> Value {
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(root.unwrap_or("root")));
    fact.insert("item", Value::from(item));
    fact.insert("draft", Value::Object(draft));
    Value::Object(fact)
}

#[cfg(test)]
mod tests;
