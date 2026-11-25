// SPDX-License-Identifier: Apache-2.0
//! What a producer holds across the threadsafe function, and what a pump entry answers: a child
//! module of `executor` so the wake handle can reach the executor's own inbox.

use super::*;

/// A `Send` handle for producers on any thread (a session event, an I/O completion).
#[derive(Clone)]
pub struct ExecutorWake {
    pub(crate) shared: Arc<Shared>,
}

impl ExecutorWake {
    /// Pushes `item` onto the inbox, then does the producer move. After admission has closed
    /// it returns `Refused` and pushes nothing.
    pub fn push(&self, item: Item) -> Push {
        if self.shared.closed.load(SeqCst) {
            return Push::Refused;
        }
        if self.shared.inbox.push(item).is_err() {
            return Push::Refused;
        }
        self.shared.moved();
        Push::Accepted
    }
}

/// What a pump entry did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pump {
    /// The continuation must be scheduled with `setImmediate`.
    Rearm,
    /// The turn ran and nothing is left.
    Done,
    /// A stale notification, or a nested entry.
    Stale,
    /// The shared stack has a transaction open; re-arm.
    Busy,
}

/// The counters the probe and the bench read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExecutorStats {
    pub turns: u64,
    pub polls: u64,
    pub longest_poll_us: u64,
    pub slow_polls: u64,
    pub last_turn_polls: u32,
}
