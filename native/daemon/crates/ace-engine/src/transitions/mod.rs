// SPDX-License-Identifier: Apache-2.0
//! E5.9: thread switches, forks and merges, workspace changes and live moves.
//!
//! The durable metadata (`state`, `metadata`, `remembered`), the receipt's switch admission
//! (`switch_admission`) and the readiness questions (`readiness`) were ported earlier as E5.4's
//! synchronous dependencies; this item adds the pure transition decisions that do not need a
//! session: the usage-limit switch window and its recovery context (`switch_recovery`), native
//! fork replay (`fork_replay`), carried handoffs (`machine_handoff`), a fresh session after an
//! unusable store (`store_handoff`), and the live-move fence (`moves`). The asynchronous execution
//! of a switch, fork or merge itself needs E5.5's delivery and E5.6's sessions/models ports; it
//! lands when those do, on the seams they define.

use crate::State;
use crate::executor::TaskId;

/// Thread transitions, workspace changes and live moves (E5.9).
#[derive(Debug, Default)]
pub struct Transitions;

/// Whether transitions hold no work E5.1 must wait for (E5.9 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

pub mod facts;
pub mod fork_replay;
pub mod handoff;
pub mod history;
pub mod machine_handoff;
pub mod metadata;
pub mod readiness;
pub mod receipt;
pub mod remembered;
pub mod state;
pub mod store_handoff;
pub mod switch_admission;
pub mod switch_recovery;
