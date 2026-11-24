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
        if !full && inner.state == GateState::Open {
            resume_both(&inner);
        }
    }

    /// Answers one delivered chunk under the gate's lock: `delivered.taken(false)` for Paused
    /// and Failed (or a queue at its bound), `taken(true)` for Open and Draining. Never read
    /// the state and answer later.
    pub fn answer(&self, delivered: Delivered) {
        let inner = self.lock();
        let more = match inner.state {
            GateState::Draining => true,
            GateState::Paused | GateState::Failed => false,
            GateState::Open => !inner.overflowed,
        };
        delivered.taken(more);
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
                // A queue at its bound keeps the pumps stopped; taking its
                // backlog resumes them.
                if !inner.overflowed {
                    resume_both(&inner);
                }
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
            if !inner.overflowed {
                resume_both(&inner);
            }
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

/// Both pumps read on: the backlog the engine's flow had held back is wanted now.
fn resume_both(inner: &GateInner) {
    if let Some(output) = &inner.output {
        output.resume(OutputStream::Stdout);
        output.resume(OutputStream::Stderr);
    }
}
