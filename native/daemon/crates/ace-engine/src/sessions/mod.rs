// SPDX-License-Identifier: Apache-2.0
//! E5.6 declares sessions and their provider processes; E5.1 holds their place and the
//! silence preparation `ready()` runs before recovery.

use crate::executor::TaskId;
use crate::{EngineError, State};

/// The engine's session interface, in the shape E5.6 will consume (declared by E3-pi.3).
///
/// A session hands its frames, identity, failure and terminal exit to one `SessionObserver`,
/// in the order it produced them. E5.6 owns the implementation that folds frames into the
/// engine's ordered queue and settles the thread on `exit`; until then the Pi session in
/// `ace-adapter-pi` is the only caller, and a test observer stands in for the engine.
pub use ace_adapter_api::{SessionExit, SessionFrame, SessionObserver};

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

pub mod metadata;
