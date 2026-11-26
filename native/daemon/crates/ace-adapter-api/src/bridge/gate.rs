// SPDX-License-Identifier: Apache-2.0
//! The read gate (E3.0c): today's `outputFlow`, mirrored onto a diverted
//! child's pumps (ADR 0223 §7 rule 4). `answer` reads the state and answers the
//! chunk in one critical section, and `set_paused` moves the state and resumes
//! the pumps in the same one, so a resume can't land between the check and the
//! pause.

use ace_supervisor::divert::OutputControl;
use ace_supervisor::spawn::{Delivered, OutputStream};
use std::sync::{Arc, Mutex, MutexGuard};

/// Where a session's read gate stands (ADR 0223 §7 rule 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GateState {
    /// Reading, and chunks are answered `taken(true)`.
    #[default]
    Open,
    /// The engine's `outputFlow` is full: chunks are answered `taken(false)`.
    Paused,
    /// A commit failed: latched, and no resume ever.
    Failed,
    /// The session is stopping: read on to EOF, answering `taken(true)`.
    Draining,
}

/// One session's read gate. Clone it freely: every clone shares the state.
#[derive(Clone, Default)]
pub struct ReadGate {
    inner: Arc<Mutex<GateInner>>,
}

#[derive(Default)]
struct GateInner {
    state: GateState,
    before_drain: Option<GateState>,
    paused_while_draining: Option<bool>,
    exited: bool,
    output: Option<OutputControl>,
    /// The event queue is at its bound: the pumps stop even while the engine's
    /// own flow has room, so a stalled JS thread can't grow the queue.
    overflowed: bool,
    /// The session holds events for line order (the Cursor stray-line hold): the
    /// pumps stop for the same reason `overflowed` stops them.
    held: bool,
}

impl ReadGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// The diverted child's pumps, once the spawn has made them.
    pub fn attach(&self, output: OutputControl) {
        self.lock().output = Some(output);
    }

    /// The event queue is at its bound (`true`) or has room again (`false`).
    /// The pumps pause through the next delivered chunk's answer, exactly as the
    /// engine's own pause does; a drain ignores it, since a stopping session
    /// reads to EOF.
    pub fn overflow(&self, full: bool) {
        let mut inner = self.lock();
        if inner.overflowed == full {
            return;
        }
        inner.overflowed = full;
        if !full {
            resume_if_open(&inner);
        }
    }

    /// The session holds events it cannot deliver in order yet (`true`), or released them
    /// (`false`): the pumps stop through the next delivered chunk's answer, like `overflow`, so
    /// the hold cannot grow past the pipes' read-ahead while the consumer is stalled.
    pub fn hold(&self, held: bool) {
        let mut inner = self.lock();
        if inner.held == held {
            return;
        }
        inner.held = held;
        if !held {
            resume_if_open(&inner);
        }
    }

    /// Answers one delivered chunk under the gate's lock: `delivered.taken(false)` for Paused
    /// and Failed (or a queue at its bound, or a session holding events), `taken(true)` for Open
    /// and Draining. Never read the state and answer later.
    pub fn answer(&self, delivered: Delivered) {
        let inner = self.lock();
        delivered.taken(takes_more(inner.state, inner.overflowed, inner.held));
    }

    /// Under the lock. Paused→Open resumes both streams. In Draining it changes nothing now
    /// but records the latest value in `paused_while_draining`, so a pause or resume that
    /// arrives during a stop is not lost.
    pub fn set_paused(&self, paused: bool) {
        let mut inner = self.lock();
        match inner.state {
            GateState::Open if paused => inner.state = GateState::Paused,
            GateState::Paused if !paused => {
                inner.state = GateState::Open;
                // A queue at its bound or a hold keeps the pumps stopped; taking its
                // backlog or the note resumes them.
                resume_if_open(&inner);
            }
            GateState::Draining => inner.paused_while_draining = Some(paused),
            GateState::Open | GateState::Paused | GateState::Failed => {}
        }
    }

    /// Latches failure: no resume ever. In Draining it only sets `before_drain = Failed`
    /// (the drain goes on), so a later undrain restores Failed.
    pub fn fail(&self) {
        let mut inner = self.lock();
        if inner.state == GateState::Draining {
            inner.before_drain = Some(GateState::Failed);
        } else {
            inner.state = GateState::Failed;
        }
    }

    /// From Open, Paused or Failed: save that state in `before_drain`, →Draining, resume both
    /// streams. A second drain keeps the first saved state.
    pub fn drain(&self) {
        drain_locked(&mut self.lock());
    }

    /// Sets `exited`, then drain(): a close that follows can only restore the state the
    /// leader's exit was already draining from.
    pub fn exited(&self) {
        let mut inner = self.lock();
        inner.exited = true;
        drain_locked(&mut inner);
    }

    /// A close whose stop failed: restore `before_drain`, then apply `paused_while_draining`
    /// if one was recorded, and clear both. Failed stays failed whatever was recorded and is
    /// never resumed; Open or Paused with a recorded `false` comes back Open with both streams
    /// resumed; with a recorded `true`, Paused; with nothing recorded, the saved state exactly.
    /// A no-op once `exited` is set, or when not Draining.
    pub fn undrain(&self) {
        let mut inner = self.lock();
        if inner.exited || inner.state != GateState::Draining {
            return;
        }
        let saved = inner.before_drain.take();
        let recorded = inner.paused_while_draining.take();
        inner.state = if saved == Some(GateState::Failed) {
            GateState::Failed
        } else if recorded == Some(true) {
            GateState::Paused
        } else if recorded == Some(false) {
            resume_if_open(&inner);
            GateState::Open
        } else {
            saved.unwrap_or(GateState::Open)
        };
    }

    /// The mutex is only ever held for state moves and the pumps' own calls, which take
    /// no other lock of ours; a poisoned one is recovered so the drain still finishes.
    fn lock(&self) -> MutexGuard<'_, GateInner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn drain_locked(inner: &mut GateInner) {
    if inner.state != GateState::Draining {
        inner.before_drain = Some(inner.state);
        inner.state = GateState::Draining;
    }
    resume_both(inner);
}

/// Whether one delivered chunk may read more. A drain reads to EOF whatever is held.
fn takes_more(state: GateState, overflowed: bool, held: bool) -> bool {
    match state {
        GateState::Draining => true,
        GateState::Paused | GateState::Failed => false,
        GateState::Open => !overflowed && !held,
    }
}

/// The pumps read on when the gate is open and both stops are clear.
fn resume_if_open(inner: &GateInner) {
    if inner.state == GateState::Open && !inner.overflowed && !inner.held {
        resume_both(inner);
    }
}

/// Both pumps read on: the backlog the engine's flow had held back is wanted now.
fn resume_both(inner: &GateInner) {
    if let Some(output) = &inner.output {
        output.resume(OutputStream::Stdout);
        output.resume(OutputStream::Stderr);
    }
}

#[cfg(test)]
mod tests {
    use super::{GateState, ReadGate, takes_more};

    #[test]
    fn a_held_gate_answers_no_more_chunks_until_the_hold_is_released() {
        assert!(!takes_more(GateState::Open, false, true));
        assert!(takes_more(GateState::Open, false, false));
        // A queue at its bound and a hold both stop an open gate.
        assert!(!takes_more(GateState::Open, true, false));
        assert!(!takes_more(GateState::Open, true, true));
        // A paused or failed gate takes nothing, held or not.
        assert!(!takes_more(GateState::Paused, false, false));
        assert!(!takes_more(GateState::Failed, false, false));
        // Draining reads to EOF whatever is held.
        assert!(takes_more(GateState::Draining, true, true));
    }

    #[test]
    fn a_hold_release_clears_it_and_a_repeat_is_harmless() {
        let gate = ReadGate::new();
        gate.hold(true);
        assert!(gate.lock().held);
        gate.hold(true);
        assert!(gate.lock().held);
        gate.hold(false);
        assert!(!gate.lock().held);
        gate.hold(false);
        assert!(!gate.lock().held);
    }
}
