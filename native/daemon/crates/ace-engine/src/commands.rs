// SPDX-License-Identifier: Apache-2.0
//! E5.4 declares commands, intents and the queue; E5.1 only holds their place.

use crate::State;
use crate::executor::TaskId;

/// Commands, intents and the queue (E5.4).
#[derive(Debug, Default)]
pub struct Commands;

/// Whether commands hold no work E5.1 must wait for (E5.4 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}
