// SPDX-License-Identifier: Apache-2.0
//! One connection to ace-media's ingest, as a state machine. The hello goes first with the
//! source's single-use token; units follow in order, never coalesced.
//!
//! The shell hands each `Write` to the socket in the order given and reports each one back,
//! in that order, as written or failed. Bytes handed over and not yet reported are the
//! backlog. Every unit counts against `limit`, keyframes too. A delta that won't fit is dropped
//! with what follows it up to the next keyframe, which is asked for once. A keyframe that won't
//! fit waits, the newest only, until the backlog makes room; a backlog still too big
//! `drain_limit` after it overflowed is a cut.
//!
//! States: `Open` → `Finishing` (its waiting keyframe, then its end frame) → `Ended` | `Cut`.
//! `Ended` is reached only when the end frame's write is reported done, which is what makes
//! ace-media's end marker a clean one, and the finish's deadline stays armed until then. Every
//! failure (a failed write, the socket closing, the deadline) goes through one cut, reported
//! once. `Ended` and `Cut` are final: nothing is written in either.
use crate::frame;
use std::collections::VecDeque;
use zeroize::Zeroizing;

pub const QUEUE_LIMIT: usize = 4 * 1024 * 1024;
/// Milliseconds the backlog may stay too big, or a finish may take, before the path is cut.
pub const DRAIN_LIMIT_MS: u64 = 2_000;

/// Bytes for the socket. The hello holds the token and is wiped when dropped.
#[derive(Debug, PartialEq, Eq)]
pub enum Bytes {
    Hello(Zeroizing<Vec<u8>>),
    Frame(Vec<u8>),
}
impl Bytes {
    pub fn as_slice(&self) -> &[u8] {
        match self {
            Self::Hello(bytes) => bytes,
            Self::Frame(bytes) => bytes,
        }
    }
}

/// Why a path was cut (ace-media sees an interrupted end).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cut {
    WriteFailed,
    Closed,
    DrainLimit,
}
impl Cut {
    pub fn reason(self) -> &'static str {
        match self {
            Self::WriteFailed => "write-failed",
            Self::Closed => "closed",
            Self::DrainLimit => "drain-limit",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Hand these bytes to the socket after every earlier write; report it with `id`.
    Write { id: u64, bytes: Bytes },
    /// The end frame is written: close the connection gracefully.
    Shutdown,
    /// Close the connection at once, abandoning any write in progress.
    Destroy,
    /// The path ended cleanly.
    Ended,
    /// The path was cut. Reported once, never for `close()`.
    Cut(Cut),
    /// The producer should send a keyframe next.
    Keyframe,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriterState {
    Open,
    /// `end_written` once the end frame has been handed over, not yet confirmed.
    Finishing {
        end_written: bool,
    },
    Ended,
    Cut,
}

#[derive(Debug)]
pub struct Writer {
    state: WriterState,
    limit: usize,
    drain_limit_ms: u64,
    skipping: bool,
    /// The newest keyframe that didn't fit.
    pending: Option<Vec<u8>>,
    /// The armed deadline: over budget while open, or a finish in progress.
    deadline: Option<u64>,
    /// Writes handed over and not yet reported, oldest first.
    outstanding: VecDeque<(u64, usize)>,
    backlog: usize,
    next_id: u64,
    end_id: Option<u64>,
}

impl Writer {
    /// A new connection's writer and its first action, the hello. The caller's token can be
    /// wiped once this returns.
    pub fn new(
        token: &[u8; frame::TOKEN_LEN],
        limit: usize,
        drain_limit_ms: u64,
    ) -> (Self, Vec<Action>) {
        let mut writer = Self {
            state: WriterState::Open,
            limit,
            drain_limit_ms,
            skipping: false,
            pending: None,
            deadline: None,
            outstanding: VecDeque::new(),
            backlog: 0,
            next_id: 0,
            end_id: None,
        };
        let mut out = Vec::new();
        writer.write(Bytes::Hello(frame::hello(token)), &mut out);
        (writer, out)
    }

    pub fn state(&self) -> WriterState {
        self.state
    }

    /// Bytes handed to the socket and not yet reported.
    pub fn backlog(&self) -> usize {
        self.backlog
    }

    /// Finishing, ended or cut: no more units are taken.
    pub fn closed(&self) -> bool {
        self.state != WriterState::Open
    }

    /// Queues one video unit; false once finishing, ended or cut. A dropped delta is still
    /// taken (true): it belongs to this path.
    pub fn unit(&mut self, now: u64, bytes: Vec<u8>, key: bool, out: &mut Vec<Action>) -> bool {
        if self.state != WriterState::Open {
            return false;
        }
        // Waiting for room: the newest keyframe replaces the one held, deltas are dropped.
        if self.deadline.is_some() {
            if key {
                self.pending = Some(bytes);
            } else if self.pending.is_none() {
                self.ask(out);
            }
            return true;
        }
        if self.skipping && !key {
            return true;
        }
        if self.fits(bytes.len()) {
            self.skipping = false;
            self.write(Bytes::Frame(bytes), out);
            return true;
        }
        if key {
            self.pending = Some(bytes);
        } else {
            self.ask(out);
        }
        self.arm(now);
        true
    }

    /// No more units: the waiting keyframe goes once there is room, then the end frame. Once
    /// only: a second finish neither re-arms the deadline nor writes another end frame.
    pub fn finish(&mut self, now: u64, out: &mut Vec<Action>) {
        if self.state != WriterState::Open {
            return;
        }
        self.state = WriterState::Finishing { end_written: false };
        self.deadline = None;
        self.arm(now);
        // With no keyframe waiting, the end frame goes at once.
        self.room(out);
    }

    /// The socket took write `id`. Reports out of order or unknown are ignored.
    pub fn written(&mut self, id: u64, out: &mut Vec<Action>) {
        if self.outstanding.front().map(|(i, _)| *i) != Some(id) {
            return;
        }
        if let Some((_, len)) = self.outstanding.pop_front() {
            self.backlog -= len;
        }
        if self.end_id == Some(id) {
            if self.state == (WriterState::Finishing { end_written: true }) {
                self.state = WriterState::Ended;
                self.deadline = None;
                out.push(Action::Shutdown);
                out.push(Action::Ended);
            }
            return;
        }
        self.room(out);
    }

    pub fn write_failed(&mut self, out: &mut Vec<Action>) {
        self.cut(Cut::WriteFailed, out);
    }

    /// ace-media closed the connection, or the socket broke.
    pub fn socket_closed(&mut self, out: &mut Vec<Action>) {
        self.cut(Cut::Closed, out);
    }

    /// The clock moved on. The deadline is judged on the backlog as it is now.
    pub fn tick(&mut self, now: u64, out: &mut Vec<Action>) {
        let Some(deadline) = self.deadline else {
            return;
        };
        if now < deadline {
            return;
        }
        self.room(out);
        let over = match self.state {
            WriterState::Finishing { .. } => true,
            WriterState::Open => self.deadline.is_some(),
            _ => false,
        };
        if over {
            self.cut(Cut::DrainLimit, out);
        }
    }

    /// At once, dropping what is queued: ace-media sees the path cut. Not reported.
    pub fn close(&mut self, out: &mut Vec<Action>) {
        if self.terminal() {
            return;
        }
        self.state = WriterState::Cut;
        self.stop();
        out.push(Action::Destroy);
    }

    fn terminal(&self) -> bool {
        matches!(self.state, WriterState::Ended | WriterState::Cut)
    }

    /// The only way a failure is reported, at most once.
    fn cut(&mut self, cut: Cut, out: &mut Vec<Action>) {
        if self.terminal() {
            return;
        }
        self.state = WriterState::Cut;
        self.stop();
        out.push(Action::Destroy);
        out.push(Action::Cut(cut));
    }

    fn stop(&mut self) {
        self.deadline = None;
        self.pending = None;
    }

    /// An empty socket takes any unit, so a keyframe bigger than the budget still goes.
    fn fits(&self, bytes: usize) -> bool {
        self.backlog == 0 || self.backlog + bytes <= self.limit
    }

    /// Writes only while open or finishing.
    fn write(&mut self, bytes: Bytes, out: &mut Vec<Action>) -> Option<u64> {
        if !matches!(
            self.state,
            WriterState::Open | WriterState::Finishing { .. }
        ) {
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        let len = bytes.as_slice().len();
        self.backlog += len;
        self.outstanding.push_back((id, len));
        out.push(Action::Write { id, bytes });
        Some(id)
    }

    /// Only from a finish whose keyframe has gone (or never waited).
    fn write_end(&mut self, out: &mut Vec<Action>) {
        if self.state != (WriterState::Finishing { end_written: false }) {
            return;
        }
        self.state = WriterState::Finishing { end_written: true };
        self.end_id = self.write(Bytes::Frame(frame::end()), out);
    }

    fn ask(&mut self, out: &mut Vec<Action>) {
        if self.skipping {
            return;
        }
        self.skipping = true;
        out.push(Action::Keyframe);
    }

    fn arm(&mut self, now: u64) {
        self.deadline = Some(now.saturating_add(self.drain_limit_ms));
    }

    /// Room in the backlog: an open path's waiting keyframe goes, or a finish moves on.
    fn room(&mut self, out: &mut Vec<Action>) {
        match self.state {
            WriterState::Open if self.deadline.is_some() => {
                let room = match &self.pending {
                    Some(pending) => self.fits(pending.len()),
                    None => self.backlog <= self.limit,
                };
                if !room {
                    return;
                }
                self.deadline = None;
                if let Some(pending) = self.pending.take() {
                    self.skipping = false;
                    self.write(Bytes::Frame(pending), out);
                }
            }
            WriterState::Finishing { end_written: false } => {
                if self.pending.as_ref().is_some_and(|p| !self.fits(p.len())) {
                    return;
                }
                if let Some(pending) = self.pending.take() {
                    self.write(Bytes::Frame(pending), out);
                }
                // The deadline stays armed until the end frame's write is reported done.
                self.write_end(out);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
#[path = "writer_tests.rs"]
mod tests;
