// SPDX-License-Identifier: Apache-2.0
//! The admission lock (`packages/adapter-opencode/src/admission.ts`): HTTP
//! admissions are serialized, so one prompt's request and the next one's never
//! interleave, while execution and the durable inbox keep their own queues.
//!
//! Sans-IO: `acquire` grants at once or queues the caller's id; `release` hands
//! the lock to the next waiter; `abort` takes a waiter out (the caller's signal
//! fired). The prompt machine (E3-opencode.6) drives it in the TypeScript's
//! order: acquire, then the barrier, then the steer check.

use std::collections::VecDeque;

/// `this.waiting.length >= 64` (`admission.ts:14`).
pub const MAX_WAITERS: usize = 64;

/// Why an admission was refused. The TypeScript throws these texts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error("OpenCode admission waiter limit")]
    Full,
    #[error("OpenCode admission cancelled")]
    Cancelled,
}

/// What `acquire` did with the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Acquire {
    /// The lock is held now; `release` frees it.
    Granted,
    /// Queued behind the holder; `release` names this id when it is granted.
    Queued(u64),
}

/// The one admission lock of a session.
#[derive(Debug, Default)]
pub struct Admission {
    active: bool,
    next: u64,
    waiting: VecDeque<u64>,
}

impl Admission {
    pub fn new() -> Self {
        Self::default()
    }

    /// `acquire(signal)`: an aborted caller fails first, before the lock or the
    /// queue is looked at (the TypeScript's `throwIfAborted`), so it never takes
    /// either. Otherwise the lock when it is free, else a place in the queue,
    /// bounded at 64 waiters.
    pub fn acquire(&mut self, aborted: bool) -> Result<Acquire, AdmissionError> {
        if aborted {
            return Err(AdmissionError::Cancelled);
        }
        if !self.active {
            self.active = true;
            return Ok(Acquire::Granted);
        }
        if self.waiting.len() >= MAX_WAITERS {
            return Err(AdmissionError::Full);
        }
        let id = self.next;
        self.next = self.next.saturating_add(1);
        self.waiting.push_back(id);
        Ok(Acquire::Queued(id))
    }

    /// `release`: the next waiter, or nobody when the queue is empty.
    pub fn release(&mut self) -> Option<u64> {
        match self.waiting.pop_front() {
            Some(id) => Some(id),
            None => {
                self.active = false;
                None
            }
        }
    }

    /// A waiter's signal fired: it leaves the queue and its admission fails.
    /// False when it was not waiting (already granted, or already taken out).
    pub fn abort(&mut self, id: u64) -> bool {
        match self.waiting.iter().position(|waiting| *waiting == id) {
            Some(index) => {
                self.waiting.remove(index);
                true
            }
            None => false,
        }
    }

    /// Whether a caller holds the lock.
    pub fn active(&self) -> bool {
        self.active
    }

    /// How many callers wait.
    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }
}

#[cfg(test)]
mod tests;
