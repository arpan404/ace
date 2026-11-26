// SPDX-License-Identifier: Apache-2.0
//! Recovery and restart, the durable half (E5.8, `engine/recovery.ts`): the queue's one deadline
//! and the deferrals behind a failing pass, what ace does with a capture or a limit, and the
//! limit policy that loads beside a receipt. The rules over a thread's state live in `restart`;
//! the hold writes they share live in `queue::holds`.
//!
//! Everything here takes the clock's time and the store as arguments; no state holds a
//! connection, and no logic reads the wall clock (`Date.now()` is banned in logic code).

pub mod attempt;
pub mod capture;
pub mod children;
pub mod cursor_attempt;
pub mod cursor_migration;
pub mod deadline;
pub mod imported;
pub mod observe;
pub mod provider_recovery;
pub mod session_bound;
pub mod startup;
pub mod threads;

use crate::executor::TaskId;
use crate::{Core, EngineError, State, ThreadId};
use std::rc::Rc;

/// A deadline pass that could not commit (the store is busy, say) runs again after this
/// (`recovery.ts:48`).
pub const DEADLINE_RETRY_MS: f64 = 1_000.0;
/// The longest wait a deadline that keeps failing is put off to (`recovery.ts:49`).
pub const DEADLINE_DEFERRAL_MAX_MS: f64 = 600_000.0;

/// The next wait for a deadline that keeps failing: doubling from a second, capped
/// (`recovery.ts:51`). Only the deadline it put off carries its backoff; a new hold starts over.
pub fn deadline_deferral(previous: Option<f64>) -> f64 {
    let next = previous.map_or(DEADLINE_RETRY_MS, |previous| previous * 2.0);
    next.min(DEADLINE_DEFERRAL_MAX_MS)
}

/// One thread's deadline that could not be acted on: the deadline it was put off to, and how
/// long that deferral was (`recovery.ts:67`).
#[derive(Debug, Clone, PartialEq)]
pub struct Deferral {
    pub deadline: String,
    pub delay: f64,
}

/// Told when a thread's limit policy finished loading, whatever it decided.
pub type PolicyListener = Rc<dyn Fn(&str)>;

/// Recovery state (`recovery.ts:55`-`:75`): preferences, pending captures, the limit policy and
/// the deadline timer a receipt arms (E5.4d).
#[derive(Default)]
pub struct Recovery {
    /// The queue deadline timer's key, when one is armed.
    pub(crate) cancel: Option<u64>,
    /// The engine's defaults for a thread without its own preferences.
    pub(crate) defaults: ace_json::Value,
    /// Close ran: no new deadline is armed and no policy load starts.
    pub(crate) closed: bool,
    /// Threads whose deadline keeps failing (`recovery.ts:67`), in insertion order.
    pub(crate) deferrals: indexmap::IndexMap<ThreadId, Deferral>,
    /// Policy loads in flight, at most 64 (`recovery.ts:68`).
    pub(crate) pending_policy: indexmap::IndexMap<ThreadId, ()>,
    /// Loads past the bound, by hold token: each starts as a running one finishes.
    pub(crate) waiting_policy: indexmap::IndexMap<ThreadId, i64>,
    /// Told when a thread's limit policy finished loading (`recovery.ts:72`).
    pub(crate) policy_listeners: Vec<PolicyListener>,
}

impl std::fmt::Debug for Recovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recovery")
            .field("cancel", &self.cancel)
            .field("closed", &self.closed)
            .field("deferrals", &self.deferrals)
            .field("pending_policy", &self.pending_policy)
            .field("waiting_policy", &self.waiting_policy)
            .finish_non_exhaustive()
    }
}

/// `recovery.prepare()` (`recovery.ts:92`): the preferences port's answer — or the engine's
/// defaults — parsed, then kept as the defaults or written on the thread's queue row.
///
/// The TypeScript awaits `store.writable()` first; the asynchronous caller does that through
/// [`prepare_ready`] and [`observe::refresh_policy`], so this part stays synchronous and pure of
/// waits (a receipt can call it).
pub fn prepare(core: &Core, thread: Option<&str>) -> Result<(), EngineError> {
    let defaults = core.with_state(|state| state.recovery.defaults.clone())?;
    let supplied = if core.inputs().has_preferences {
        Some(core.ports.preferences()?)
    } else {
        None
    };
    let supplied_value = supplied
        .as_deref()
        .and_then(|text| ace_json::parse(text).ok());
    let value = crate::queue::admission::preferences(supplied_value.as_ref(), &defaults);
    match thread {
        Some(thread) => {
            let text = ace_json::to_string(&value);
            core.store.atomic(|tx| {
                ace_store::stmt_cache::run(
                    tx.conn(),
                    "UPDATE engine_queue SET preferences=? WHERE thread_id=?",
                    vec![
                        ace_store::Value::Text(text),
                        ace_store::Value::Text(thread.to_owned()),
                    ],
                )?;
                Ok(())
            })
        }
        None => core.with_state(|state| state.recovery.defaults = value),
    }
}

/// `ready()`'s recovery step (`index.ts:460`): the store is writable, then the defaults load.
pub async fn prepare_ready(core: &Rc<Core>) -> Result<(), EngineError> {
    let live = Rc::clone(&core.actor_deps.borrow().live);
    live.writable().await;
    prepare(core, None)
}

/// `recovery.prepare(thread)` (`index.ts:1134`): the thread's settings load before its command.
pub async fn prepare_thread(core: &Rc<Core>, thread: &str) -> Result<(), EngineError> {
    let live = Rc::clone(&core.actor_deps.borrow().live);
    live.writable().await;
    prepare(core, Some(thread))
}

/// `recovery.handle()` (`recovery.ts:111`): the queue receipt, then the person's own accepted
/// Resume starts a fresh run for the loop guard.
pub fn handle(
    core: &Core,
    state: &mut State,
    command: &ace_json::Value,
) -> Result<Option<ace_json::Value>, EngineError> {
    let result = crate::queue::commands::handle(core, state, command)?;
    let kind = crate::commands::payload_type(command);
    let device = command
        .get("deviceId")
        .and_then(ace_json::Value::as_str)
        .unwrap_or_default();
    let accepted = result
        .as_ref()
        .is_some_and(|result| result.get("ok").and_then(ace_json::Value::as_bool) == Some(true));
    if accepted
        && device != "engine"
        && (kind == "thread.resume" || kind == "queue.resume")
        && let Some(thread) = command
            .get("payload")
            .and_then(|payload| payload.get("threadId"))
            .and_then(ace_json::Value::as_str)
    {
        crate::queue::admission::clear_restart_streak(core.store.conn(), thread)?;
    }
    Ok(result)
}

/// `repo.recovery.pruneIdle()` (`provider-recovery.ts:354`): the idle sweep's bounded batch.
pub fn prune_idle(core: &Core) -> Result<(), EngineError> {
    provider_recovery::sweep(core)
}

/// `recovery.prepare(thread)` and startup's per-thread recovery (`restart.ts:40`-`:413`).
pub fn recover_thread(_state: &mut State, thread: &ThreadId) -> Result<(), EngineError> {
    let _ = thread;
    Err(EngineError::not_ported("restart recovery", "E5.8"))
}

/// `recovery.close()` (`recovery.ts:841`): no deadline is armed and no policy load starts.
pub fn close(state: &mut State) {
    state.recovery.closed = true;
    state.recovery.waiting_policy.clear();
}

/// Whether recovery holds no work E5.1 must wait for: a policy load still running (or waiting
/// its turn) settles the thread on settings nobody has read yet (`recovery.ts:576`).
pub fn quiescent(state: &State, _exclude: Option<TaskId>) -> bool {
    state.recovery.pending_policy.is_empty() && state.recovery.waiting_policy.is_empty()
}

/// `recovery.policyLoading()` (`recovery.ts:569`): what ace does at reset isn't known yet.
pub fn policy_loading(state: &State, thread: &str) -> bool {
    state.recovery.pending_policy.contains_key(thread)
        || state.recovery.waiting_policy.contains_key(thread)
}

/// `recovery.onPolicyLoaded()` (`recovery.ts:572`): the returned index removes the listener.
pub fn add_policy_listener(state: &mut State, listener: PolicyListener) -> usize {
    state.recovery.policy_listeners.push(listener);
    state.recovery.policy_listeners.len() - 1
}

/// Removes one listener; an index another removal already took is ignored.
pub fn remove_policy_listener(state: &mut State, index: usize) {
    if index < state.recovery.policy_listeners.len() {
        state.recovery.policy_listeners.remove(index);
    }
}

/// `recovery.moveTarget()` (`recovery.ts:708`): the account a usage-limit move goes to.
pub fn move_target(
    core: &Core,
    thread: &str,
    requested: Option<&str>,
) -> Result<String, EngineError> {
    if !core.ports.has_move_target() {
        return Err(EngineError::Records(
            "Account migration is unavailable".to_owned(),
        ));
    }
    Ok(core.ports.move_target(thread, requested)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first failure waits a second, then doubles, and stops at ten minutes.
    #[test]
    fn a_failing_deadline_is_put_off_with_doubling_bounded_waits() {
        assert_eq!(deadline_deferral(None), DEADLINE_RETRY_MS);
        assert_eq!(deadline_deferral(Some(DEADLINE_RETRY_MS)), 2_000.0);
        assert_eq!(deadline_deferral(Some(2_000.0)), 4_000.0);
        assert_eq!(
            deadline_deferral(Some(DEADLINE_DEFERRAL_MAX_MS)),
            DEADLINE_DEFERRAL_MAX_MS
        );
        assert_eq!(
            deadline_deferral(Some(DEADLINE_DEFERRAL_MAX_MS / 1.5)),
            DEADLINE_DEFERRAL_MAX_MS,
            "the cap holds just below it"
        );
    }
}
