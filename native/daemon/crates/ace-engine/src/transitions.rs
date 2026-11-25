// SPDX-License-Identifier: Apache-2.0
//! E5.9 declares transitions; E5.1 only holds their place.

use crate::State;
use crate::executor::TaskId;

/// Thread transitions, workspace changes and live moves (E5.9).
#[derive(Debug, Default)]
pub struct Transitions;

/// Whether transitions hold no work E5.1 must wait for (E5.9 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}
