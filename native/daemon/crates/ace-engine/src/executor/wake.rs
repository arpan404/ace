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
        // Counted for its whole check-push-move span: a close that races this push waits it out,
        // and a turn never reads "drained" while an admitted item is still on its way in.
        self.shared.inflight.fetch_add(1, SeqCst);
        if self.shared.closed.load(SeqCst) {
            self.shared.inflight.fetch_sub(1, SeqCst);
            return Push::Refused;
        }
        if self.shared.inbox.push(item).is_err() {
            self.shared.inflight.fetch_sub(1, SeqCst);
            return Push::Refused;
        }
        self.shared.moved();
        self.shared.inflight.fetch_sub(1, SeqCst);
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
