// SPDX-License-Identifier: Apache-2.0
//! Prompt admission (`prompts.ts`): the part that decides whether a failed send
//! may be retried. A prompt the server never received, or turned down outright,
//! nothing ran on, so ace may send it again; a prompt that may have been stored
//! (the request went out, or a 5xx followed it) is never resubmitted — the
//! inbox is reconciled instead.
//!
//! Sans-IO: the caller reports every request and reply it observed, asks for the
//! next prompt's id, and asks what a failure means. The admission lock is
//! `admission.rs`; the header, the body and the request itself are E5.6's.

use crate::session::model::message_id;

/// Which way an observed request went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// ace sent it.
    Send,
    /// the server answered it.
    Recv,
}

/// What a failed send means for the input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing ran: the server turned the input down, or never saw the request.
    /// ace may send it again.
    Rejected,
    /// The prompt may be stored and running: never send it again automatically.
    Uncertain,
}

/// The prompt sequence's admission state.
#[derive(Debug, Default)]
pub struct Prompts {
    sequence: u64,
    started: bool,
    refused: bool,
}

impl Prompts {
    pub fn new() -> Self {
        Self::default()
    }

    /// `observe`: a `prompt` or `command` request that went out started this
    /// send; a reply with a 4xx status is the server turning it down.
    pub fn observe(&mut self, direction: Direction, path: &str, status: Option<f64>) {
        if !path.ends_with("/prompt") && !path.ends_with("/command") {
            return;
        }
        if direction == Direction::Send {
            self.started = true;
            return;
        }
        let Some(status) = status else {
            return;
        };
        if (400.0..500.0).contains(&status) {
            self.refused = true;
        }
    }

    /// The next message id, from the wall clock, the sequence and the entropy:
    /// `messageId(now, ++sequence, entropy)`.
    pub fn next_id(&mut self, wall_time_ms: u64, entropy: &str) -> String {
        self.sequence = self.sequence.saturating_add(1);
        message_id(wall_time_ms, self.sequence, entropy)
    }

    /// The barrier is behind us and the steer target held: this send starts with
    /// no request observed yet.
    pub fn begin(&mut self) {
        self.started = false;
        self.refused = false;
    }

    /// What a failed send means. `admitted` says a command in the batch already
    /// returned, which alone makes the batch's outcome uncertain.
    pub fn outcome(&self, admitted: bool) -> Outcome {
        if !admitted && (self.refused || !self.started) {
            Outcome::Rejected
        } else {
            Outcome::Uncertain
        }
    }
}

#[cfg(test)]
mod tests;
