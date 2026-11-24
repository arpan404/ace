// SPDX-License-Identifier: Apache-2.0
//! E5.8 declares recovery and restart; E5.1 holds their place, the idle sweep's body and the
//! startup pass's per-thread step.

use crate::executor::TaskId;
use crate::{EngineError, State, ThreadId};

/// Recovery state: preferences, pending captures, the limit policy (E5.8).
#[derive(Debug, Default)]
pub struct Recovery;

/// `repo.recovery.pruneIdle()`: the idle sweep's bounded batch (E5.8). Reported through
/// `onError` once per firing, never thrown.
pub fn prune_idle(_state: &mut State) -> Result<(), EngineError> {
    Err(EngineError::not_ported("the idle sweep", "E5.8"))
}

/// `recovery.prepare()`: E5.8 fills this. E5.1's engine stores no recovery state yet, so there
/// is nothing to prepare.
pub fn prepare(_state: &mut State) -> Result<(), EngineError> {
    Ok(())
}

/// `recovery.prepare(thread)` and `recoverEngine`'s per-thread recovery (E5.8).
pub fn recover_thread(_state: &mut State, thread: &ThreadId) -> Result<(), EngineError> {
    let _ = thread;
    Err(EngineError::not_ported("restart recovery", "E5.8"))
}

/// `recovery.close()`: E5.8 fills this. E5.1 holds no capture to flush and no policy to stop.
pub fn close(_state: &mut State) -> Result<(), EngineError> {
    Ok(())
}

/// Whether recovery holds no work E5.1 must wait for (E5.8 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}
