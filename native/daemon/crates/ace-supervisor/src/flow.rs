// SPDX-License-Identifier: Apache-2.0
//! The reader's side of `OutputFlow` (`flow-control.ts`). The owner's room is a
//! JavaScript promise the shell owns; what stays here is the guard both readers
//! run: one drain at a time, pause the transport while the owner is full, stop
//! for cancellation instead of waiting, and fail once.

/// What a reader may do now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowDecision {
    /// The owner has room: read.
    Read,
    /// The owner is full but the session is live: wait for its promise.
    Wait,
    /// The session was cancelled: stop waiting and read to EOF.
    Cancelled,
}

/// `waitForOutput`'s order: cancellation is checked before and after the wait,
/// and a live owner that is not full needs no wait at all.
pub fn wait_decision(cancelled: bool, paused: bool) -> FlowDecision {
    if cancelled {
        FlowDecision::Cancelled
    } else if paused {
        FlowDecision::Wait
    } else {
        FlowDecision::Read
    }
}

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

    /// The owner has room again; the shell may resume its transport.
    pub fn is_blocked(&self) -> bool {
        self.blocked
    }

    /// Refuse everything after a framing or stream failure.
    pub fn fail(&mut self) {
        self.failed = true;
        self.draining = false;
    }

    pub fn is_failed(&self) -> bool {
        self.failed
    }

    /// The caller detached its listeners; nothing may be delivered afterwards.
    pub fn detach(&mut self) {
        self.detached = true;
    }

    pub fn is_detached(&self) -> bool {
        self.detached
    }
}
