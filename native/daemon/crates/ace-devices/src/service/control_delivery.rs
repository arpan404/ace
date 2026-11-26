// SPDX-License-Identifier: Apache-2.0
//! Coalescing a devices channel's pushes while its frames drain
//! (`packages/devices/src/control-delivery.ts`).
//!
//! A replaceable push waits when one of its kind is already waiting, or when
//! the transport holds more than 256 KiB; a log batch is dropped under the same
//! pressure. Replies always go straight through. What waits is flushed 25 ms
//! later, and a flush that finds the transport still backed up re-arms.
//!
//! Sans-IO: the timer is the shell's, named by an id this module allocates.

use indexmap::IndexMap;

use super::wire::Push;

/// How long a coalesced push waits (`control-delivery.ts:15`).
pub const FLUSH_MS: f64 = 25.0;
/// The transport backlog above which pushes wait and log batches drop.
pub const BUFFERED_LIMIT: usize = 256 * 1024;
/// The refusal after the channel closed (`control-delivery.ts:28`).
pub const CLOSED: &str = "Device connection closed";

/// What `send` decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent<M> {
    /// Write it now, and await the write.
    Write(Push<M>),
    /// It waits for the flush. `arm` names the timer to start when none runs.
    Held { arm: Option<u64> },
    /// A log batch dropped under back pressure.
    Dropped,
}

/// What a timer firing decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Flush<M> {
    /// Write these in order, then report one failure.
    Write(Vec<Push<M>>),
    /// Still backed up: start this timer instead.
    Rearm(u64),
    /// Nothing to do: a stale or cancelled timer.
    Idle,
}

/// One channel's coalescing.
#[derive(Debug)]
pub struct ControlDelivery<M> {
    /// Waiting pushes by replacement key; a repeat keeps its first position
    /// (`Map.set` on an existing key), with the latest value.
    pending: IndexMap<String, Push<M>>,
    /// The timer that will flush, when one runs.
    cancel: Option<u64>,
    next_timer: u64,
    closed: bool,
}

impl<M> Default for ControlDelivery<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M> ControlDelivery<M> {
    pub fn new() -> Self {
        Self {
            pending: IndexMap::new(),
            cancel: None,
            next_timer: 0,
            closed: false,
        }
    }

    /// `send`: a replaceable push is coalesced while one of its kind waits or the
    /// transport is backed up, a log batch drops under pressure, and everything
    /// else writes now.
    pub fn send(&mut self, push: Push<M>, buffered: usize) -> Result<Sent<M>, String> {
        if self.closed {
            return Err(String::from(CLOSED));
        }
        if let Some(key) = push.kind.replace_key()
            && (self.pending.contains_key(&key) || buffered > BUFFERED_LIMIT)
        {
            self.pending.insert(key, push);
            return Ok(Sent::Held { arm: self.arm() });
        }
        if push.kind.is_logs() && buffered > BUFFERED_LIMIT {
            return Ok(Sent::Dropped);
        }
        Ok(Sent::Write(push))
    }

    /// The timer `timer` fired: flush what waits, or re-arm while the transport
    /// is still backed up.
    pub fn fire(&mut self, timer: u64, buffered: usize) -> Flush<M> {
        if self.closed || self.cancel != Some(timer) {
            return Flush::Idle;
        }
        self.cancel = None;
        if buffered > BUFFERED_LIMIT {
            return match self.arm() {
                Some(next) => Flush::Rearm(next),
                None => Flush::Idle,
            };
        }
        let messages: Vec<Push<M>> = self.pending.drain(..).map(|(_, push)| push).collect();
        Flush::Write(messages)
    }

    /// `close`: no further send, and nothing waits. Returns the timer to cancel.
    pub fn close(&mut self) -> Option<u64> {
        self.closed = true;
        self.pending.clear();
        self.cancel.take()
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// How many pushes wait, for tests and diagnostics.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    fn arm(&mut self) -> Option<u64> {
        if self.cancel.is_some() {
            return None;
        }
        self.next_timer = self.next_timer.saturating_add(1);
        self.cancel = Some(self.next_timer);
        Some(self.next_timer)
    }
}

#[cfg(test)]
mod tests;
