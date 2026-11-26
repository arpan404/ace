// SPDX-License-Identifier: Apache-2.0
//! E5.8 declares recovery and restart; E5.1 holds their place, the idle sweep's body and the
//! startup pass's per-thread step.

use crate::executor::TaskId;
use crate::{EngineError, State, ThreadId};

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
pub fn recover_thread(state: &mut State, thread: &ThreadId) -> Result<(), EngineError> {
    let Some(core) = state.engine.upgrade() else {
        return Ok(());
    };
    state.transition_prune_guards(&core.store)?;
    crate::transitions::dispatch::recover_thread(&core, state, thread)?;
    Ok(())
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
