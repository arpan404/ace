// SPDX-License-Identifier: Apache-2.0
//! E5.6 declares sessions and their provider processes; E5.1 holds their place and the
//! silence preparation `ready()` runs before recovery.

use crate::executor::TaskId;
use crate::{EngineError, State};

/// The open sessions (E5.6).
#[derive(Debug, Default)]
pub struct Sessions;

/// `silence.prepareGlobal()`: E5.6 fills this. E5.1's engine opens no session and holds no
/// silence state, so there is nothing to prepare.
pub fn prepare_silence(_state: &mut State) -> Result<(), EngineError> {
    Ok(())
}

/// Whether sessions hold no work E5.1 must wait for (E5.6 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}
