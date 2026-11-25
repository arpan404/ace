// SPDX-License-Identifier: Apache-2.0
//! E5.2 declares the thread actors; E5.1 only holds their place in the engine state.

use crate::executor::TaskId;
use crate::{Core, EngineError, State, ThreadId};

/// The thread actors (E5.2). `seals` counts the flushes that asked every actor to seal its
/// pending frame batch; E5.1 has no actors, so it is the proof that flush reaches this step.
#[derive(Debug, Default)]
pub struct Actors {
    pub seals: u32,
}

/// Seals every actor's pending frame batch and flushes the live buffer, before and after the
/// worker wait (`index.ts:1414`, `:1416`; E5.2 fills this in with `actor.flush()`). E5.1 has no
/// actors, so it records that the flush reached this step.
pub async fn flush_all(core: &Core, _exclude: Option<TaskId>) -> Result<(), EngineError> {
    core.with_state(seal)
}

/// One `flush_all` pass: seals the pending batch (`actor.flush()`'s `sealFrames`).
pub fn seal(state: &mut State) {
    state.actors.seals += 1;
}

/// Whether the actors hold no work E5.1 must wait for (E5.2 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

/// E5.2's batch entry; the skeleton never reaches it.
pub fn frames(_state: &mut State, _thread: &ThreadId) -> Result<(), EngineError> {
    Err(EngineError::not_ported("actor frames", "E5.2"))
}
