// SPDX-License-Identifier: Apache-2.0
//! E5.10 declares liveness, stop and delegation; E5.1 only holds their place.

use crate::State;
use crate::executor::TaskId;

/// Liveness, settled trees and delegation facts (E5.10).
#[derive(Debug, Default)]
pub struct Liveness {
    pub(crate) settling: std::collections::HashMap<String, Option<TaskId>>,
}

/// Whether liveness holds no work E5.1 must wait for (E5.10 fills this).
pub fn quiescent(state: &State, exclude: Option<TaskId>) -> bool {
    state
        .liveness
        .settling
        .values()
        .all(|task| task.is_some() && *task == exclude)
}

pub mod live;
pub mod notice;
pub mod reconcile;
pub mod retire;
pub mod stop_intents;
pub mod stop_scope;
pub mod tree;

pub use tree::{resumable, thread_tree};
