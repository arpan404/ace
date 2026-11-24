// SPDX-License-Identifier: Apache-2.0
//! E5.2 declares the thread actors; E5.1 only holds their place in the engine state.

use crate::executor::TaskId;
use crate::{EngineError, State, ThreadId};

/// The thread actors (E5.2).
#[derive(Debug, Default)]
pub struct Actors;

/// Whether the actors hold no work E5.1 must wait for (E5.2 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

/// E5.2's batch entry; the skeleton never reaches it.
pub fn frames(_state: &mut State, _thread: &ThreadId) -> Result<(), EngineError> {
    Err(EngineError::not_ported("actor frames", "E5.2"))
}
