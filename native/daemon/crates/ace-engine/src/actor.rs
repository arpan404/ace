// SPDX-License-Identifier: Apache-2.0
//! E5.2 declares the thread actors; E5.1 only holds their place in the engine state.

use crate::executor::TaskId;
use crate::{EngineError, State, ThreadId};

/// The thread actors (E5.2). `seals` counts the flushes that asked every actor to seal its
/// pending frame batch; E5.1 has no actors, so it is the proof that flush reaches this step.
#[derive(Debug, Default)]
pub struct Actors {
    pub seals: u32,
}

/// Seals every actor's pending frame batch before a flush's quiescence loop (E5.2 fills this;
/// `actor.flush()`'s `sealFrames`). E5.1 has no actors.
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
