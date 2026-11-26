// SPDX-License-Identifier: Apache-2.0
//! E5.10 declares liveness, stop and delegation; E5.1 only holds their place.

use crate::State;
use crate::executor::TaskId;

/// Liveness, settled trees and delegation facts (E5.10).
#[derive(Debug, Default)]
pub struct Liveness;

/// Whether liveness holds no work E5.1 must wait for (E5.10 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

pub mod stop_intents;
pub mod stop_scope;
