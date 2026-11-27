// SPDX-License-Identifier: Apache-2.0
//! The reader's side of `OutputFlow` (`flow-control.ts`). The owner's room and its
//! wait are a JavaScript promise and an AbortSignal the shell owns; what stays
//! here is the guard both readers run: one drain at a time, pause the transport
//! while the owner is full, and fail once. Cancellation is the shell's check
//! (before and after the wait, as `waitForOutput` does), which is also what lets
//! a cancelled session read to EOF instead of waiting.

/// The drain guard shared by the line and JSONL readers: re-entrant drains are
/// refused, a blocked drain waits for the flow promise, and a failed or detached
/// reader reads nothing more.
#[derive(Debug, Clone, Default)]
pub struct ReaderFlow {
    draining: bool,
    blocked: bool,
    failed: bool,
    detached: bool,
}

impl ReaderFlow {
    pub fn new() -> ReaderFlow {
        ReaderFlow::default()
    }

    /// Enter a drain; false when one is already running, the reader is blocked,
    /// or it has failed or been detached.
    pub fn begin(&mut self) -> bool {
        if self.draining || self.blocked || self.failed || self.detached {
            return false;
        }
        self.draining = true;
        true
    }

    /// Leave a drain, whatever it did.
    pub fn end(&mut self) {
        self.draining = false;
    }

    /// The owner is full: hold the remainder until its promise resolves.
    pub fn block(&mut self) {
        self.blocked = true;
    }

    /// The owner's promise resolved.
    pub fn unblock(&mut self) {
        self.blocked = false;
    }

    /// Refuse everything after a framing or stream failure.
    pub fn fail(&mut self) {
        self.failed = true;
        self.draining = false;
    }

    /// The caller detached its listeners; nothing may be delivered afterwards.
    pub fn detach(&mut self) {
        self.detached = true;
    }
}
