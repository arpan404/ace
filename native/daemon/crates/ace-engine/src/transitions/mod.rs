// SPDX-License-Identifier: Apache-2.0
//! E5.9: thread switches, forks and merges, workspace changes and live moves.
//!
//! The durable metadata (`state`, `metadata`, `remembered`), the receipt's switch admission
//! (`switch_admission`) and the readiness questions (`readiness`) were ported earlier as E5.4's
//! synchronous dependencies; this item adds the pure transition decisions that do not need a
//! session: the usage-limit switch window and its recovery context (`switch_recovery`), native
//! fork replay (`fork_replay`), carried handoffs (`machine_handoff`), a fresh session after an
//! unusable store (`store_handoff`), and the live-move fence (`moves`). A merge's execution lands
//! here too (`dispatch`, `execute`), settling its intent and guards with its writes. A switch's
//! execution needs E5.6's sessions and models ports, a patch merge E5.5's worktree port and a
//! fork E5.4e's create seam; each refuses or waits, naming the item, rather than reporting work
//! it did not do.

use crate::EngineError;
use crate::State;
use crate::executor::TaskId;

/// Thread transitions, workspace changes and live moves (E5.9).
#[derive(Debug, Default)]
pub struct Transitions {
    /// Whether boot's readiness rebuild is still running. While it is, only the threads it has
    /// reached answer ready; a thread it has not reached is never "done".
    pub(crate) booting: bool,
    /// Threads whose readiness rebuild has committed this boot.
    pub(crate) rebuilt: std::collections::HashSet<String>,
}

/// Whether transitions hold no work E5.1 must wait for (E5.9 fills this).
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

/// Startup: prune stale guards, then mark readiness unbuilt until boot's pages replace it.
pub fn begin_boot(store: &crate::EngineStore, state: &mut State) -> Result<(), EngineError> {
    state.transition_prune_guards(store)?;
    state.transitions.booting = true;
    Ok(())
}

/// Boot's readiness rebuild is done: every thread now answers from its rebuilt index.
pub fn finish_boot(state: &mut State) {
    state.transitions.booting = false;
}

pub mod dispatch;
pub mod execute;
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
pub mod switch_ready;
pub mod switch_recovery;
