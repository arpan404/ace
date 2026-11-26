// SPDX-License-Identifier: Apache-2.0
//! E5.8 declares recovery and restart; E5.1 holds their place, the idle sweep's body and the
//! startup pass's per-thread step.

use crate::executor::TaskId;
use crate::{EngineError, State, ThreadId};

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

/// Recovery state: preferences, pending captures, the limit policy (E5.8), and the deadline
/// timer a receipt arms (E5.4d).
#[derive(Debug, Default)]
pub struct Recovery {
    /// The queue deadline timer's key, when one is armed.
    pub(crate) cancel: Option<u64>,
    /// The engine's defaults for a thread without its own preferences.
    pub(crate) defaults: ace_json::Value,
    /// Close ran: no new deadline is armed.
    pub(crate) closed: bool,
}

/// `repo.recovery.pruneIdle()`: the idle sweep's bounded batch (E5.8). Reported through
/// `onError` once per firing, never thrown.
pub fn prune_idle(_state: &mut State) -> Result<(), EngineError> {
    Err(EngineError::not_ported("the idle sweep", "E5.8"))
}

/// `recovery.prepare()`: E5.8's. E5.1 fails at the call, naming the item.
pub fn prepare(_state: &mut State) -> Result<(), EngineError> {
    Err(EngineError::not_ported("the recovery preparation", "E5.8"))
}

/// `recovery.prepare(thread)` and `recoverEngine`'s per-thread recovery (E5.8).
pub fn recover_thread(_state: &mut State, thread: &ThreadId) -> Result<(), EngineError> {
    let _ = thread;
    Err(EngineError::not_ported("restart recovery", "E5.8"))
}

/// `recovery.close()`: E5.8's. E5.1 fails at the call, naming the item; close reports it and
/// still runs every shutdown step below.
pub fn close(state: &mut State) -> Result<(), EngineError> {
    state.recovery.closed = true;
    Err(EngineError::not_ported("the recovery close", "E5.8"))
}

/// Whether recovery holds no work E5.1 must wait for (E5.8 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
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
