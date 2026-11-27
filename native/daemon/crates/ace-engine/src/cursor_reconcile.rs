// SPDX-License-Identifier: Apache-2.0
//! Cursor turns a restart cut short, reconciled with Cursor's own store before they are called
//! failed (`cursor-reconcile.ts`, ADR 0043's 2026-11-22 amendment). This file holds the queue of
//! threads a startup marked: their lanes stay shut while a reconcile waits or runs, so a Resume
//! cannot open a second session that fences it.

use ace_json::Value;
use indexmap::IndexSet;

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
}

/// `add` (`cursor-reconcile.ts:247`): a thread whose cut-off Cursor work waits for its reconcile.
pub fn mark(state: &mut crate::State, thread: &str) {
    state.cursor.marked.insert(thread.to_owned());
    state.cursor.held.insert(thread.to_owned());
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
    state.cursor.marked.iter().cloned().collect()
}

/// `release` (`:307`): the thread's lanes open again.
pub fn release(state: &mut crate::State, thread: &str) {
    state.cursor.held.shift_remove(thread);
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
