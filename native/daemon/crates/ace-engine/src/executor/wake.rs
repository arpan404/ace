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
        // and a turn never reads "drained" while an admitted item is still on its way in. The
        // guard unwinds with a panicking notifier, so the count can never be stranded.
        self.shared.enter();
        let _leave = Inflight(&self.shared);
        if self.shared.closed.load(SeqCst) {
            return Push::Refused;
        }
        // The shutdown test forces this window: a producer paused between its admission check
        // and its push, so a close lands mid-span.
        #[cfg(test)]
        if self.shared.pause_producer.load(SeqCst) {
            let mut waited = 0u64;
            while self.shared.pause_producer.load(SeqCst) && waited < 200_000_000 {
                std::hint::spin_loop();
                waited += 1;
            }
        }
        if self.shared.inbox.push(item).is_err() {
            return Push::Refused;
        }
        self.shared.moved();
        Push::Accepted
    }
}

/// Ends a producer's counted span when it leaves `push`, including by unwinding.
struct Inflight<'a>(&'a Shared);

impl Drop for Inflight<'_> {
    fn drop(&mut self) {
        self.0.leave();
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
