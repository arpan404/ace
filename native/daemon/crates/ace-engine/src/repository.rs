// SPDX-License-Identifier: Apache-2.0
//! E5.3 declares the repository; E5.1 declares the startup pass's candidate scan and quiescence.

use crate::executor::TaskId;
use crate::{EngineError, State, ThreadId};

/// The stored-thread repository (E5.3).
#[derive(Debug, Default)]
pub struct Repo;

/// The startup pass's next slice of threads to recover (E5.3). Before E5.3 the probe answers
/// with no rows so `ready()` can resolve; without it the unported path fails here, naming E5.3.
pub fn recovery_candidates(state: &mut State, slice: usize) -> Result<Vec<ThreadId>, EngineError> {
    if state.probe_empty_candidates {
        return Ok(Vec::new());
    }
    let _ = slice;
    Err(EngineError::not_ported(
        "the recovery-candidate scan",
        "E5.3",
    ))
}

/// Whether the repository holds no work E5.1 must wait for (E5.3 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}
