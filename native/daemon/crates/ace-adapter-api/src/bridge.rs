// SPDX-License-Identifier: Apache-2.0
//! The session bridge every native session shares (E3.0c): one ordered event
//! queue per session, and the read gate that mirrors the engine's
//! `outputFlow` onto the diverted child's pumps (ADR 0223 §7 rules 3 and 4).
//!
//! **Ordering.** Every input — one output chunk's lines, one JavaScript binding
//! call, one timer — builds all of its events while it holds the session's own
//! state lock, then hands them to [`EventQueue::publish`] in one call. `publish`
//! appends them under one lock, so two inputs never interleave and each input's
//! events appear in the order its state changed. A frame's `seq` is assigned
//! here, at push: it is the frame's position on the queue.
//!
//! **The gate.** [`ReadGate::answer`] reads the state and answers the chunk in
//! one critical section, and [`ReadGate::set_paused`] moves the state and
//! resumes the pumps in the same one. A resume can't land between the check and
//! the pause: either the pause comes first and the resume undoes it, or the
//! resume comes first and the chunk is answered `taken(true)`.

use crate::frame::FrameDirection;
use ace_supervisor::divert::OutputControl;
use ace_supervisor::spawn::{Delivered, OutputStream};
use serde::ser::{Serialize, SerializeSeq, Serializer};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::Notify;

/// `SteerTargetLost` on the wire: the turn the input was meant to join ended.
pub const STEER_TARGET_LOST: &str = "ACE_STEER_TARGET_LOST";
/// `InputRejected` on the wire: the provider refused before taking any input.
pub const INPUT_REJECTED: &str = "ACE_INPUT_REJECTED";

/// One event on a session's ordered queue. `json` fields are already JSON text
/// (redacted where the payload is provider data); the binding encodes the batch
/// without re-encoding them.
pub enum SessionEvent {
    /// `text` is the redacted JSON text of the frame's data; seq is assigned at push.
    Frame {
        seq: u64,
        dir: FrameDirection,
        channel: String,
        text: String,
    },
    /// One context callback, by name (`onSessionIdentity`, ...), JSON array of arguments.
    Callback {
        name: &'static str,
        json: String,
    },
    /// Settles the facade's promise `id`.
    Settle {
        id: u64,
        result: Result<String, SessionErrorWire>,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// The session cannot go on: the facade closes it, unexpected.
    Fatal {
        message: String,
    },
    /// Last event: the child's pipes are closed and every frame they produced is before it.
    Drained,
}

/// A failure as it crosses to the facade: a fixed code and the message.
pub struct SessionErrorWire {
    pub code: &'static str,
    pub message: String,
}

/// `[[kind, ...fields], ...]`, the shape encapsulated once so a kind's fields
/// are written in one place. A settle is `["settle", id, true, json, null]` or
/// `["settle", id, false, message, code]`, so the facade never guesses.
impl Serialize for SessionEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut event = serializer.serialize_seq(None)?;
        match self {
            SessionEvent::Frame {
                seq,
                dir,
                channel,
                text,
            } => {
                event.serialize_element("frame")?;
                event.serialize_element(seq)?;
                event.serialize_element(dir)?;
                event.serialize_element(channel)?;
                event.serialize_element(text)?;
            }
            SessionEvent::Callback { name, json } => {
                event.serialize_element("callback")?;
                event.serialize_element(name)?;
                event.serialize_element(json)?;
            }
            SessionEvent::Settle { id, result } => {
                event.serialize_element("settle")?;
                event.serialize_element(id)?;
                match result {
                    Ok(json) => {
                        event.serialize_element(&true)?;
                        event.serialize_element(json)?;
                        event.serialize_element(&Option::<&str>::None)?;
                    }
                    Err(error) => {
                        event.serialize_element(&false)?;
                        event.serialize_element(&error.message)?;
                        event.serialize_element(error.code)?;
                    }
                }
            }
            SessionEvent::ArmTimer { key, ms } => {
                event.serialize_element("armTimer")?;
                event.serialize_element(key)?;
                event.serialize_element(ms)?;
            }
            SessionEvent::CancelTimer { key } => {
                event.serialize_element("cancelTimer")?;
                event.serialize_element(key)?;
            }
            SessionEvent::Fatal { message } => {
                event.serialize_element("fatal")?;
                event.serialize_element(message)?;
            }
            SessionEvent::Drained => event.serialize_element("drained")?,
        }
        event.end()
    }
}

/// One session's ordered queue. Clone it freely: every clone shares the queue.
#[derive(Clone, Default)]
pub struct EventQueue {
    state: Arc<Mutex<QueueState>>,
    wake: Arc<Notify>,
    /// Set when an event arrives after `Drained`, so the drop is logged once.
    logged: Arc<AtomicBool>,
}

#[derive(Default)]
struct QueueState {
    events: VecDeque<SessionEvent>,
    next_seq: u64,
    drained: bool,
}

impl EventQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Pushes every event of one input under one lock, in order. Frames get their seq here.
    /// After `Drained` it drops the events and logs once; it never panics.
    pub fn publish(&self, events: Vec<SessionEvent>) {
        let mut state = self.lock();
        let mut dropped = false;
        for event in events {
            if state.drained {
                dropped = true;
                break;
            }
            let next_seq = &mut state.next_seq;
            let event = numbered(event, next_seq);
            state.drained = matches!(event, SessionEvent::Drained);
            state.events.push_back(event);
        }
        let pushed = state.events.iter().next().is_some();
        drop(state);
        if dropped {
            self.log_drop_once();
        }
        // Woken after the push, under no lock: a waiter that finds nothing sleeps
        // on a permit this call has already left, so no wakeup is lost.
        if pushed {
            self.wake.notify_one();
        }
    }

    /// Takes at most `max_frames` frames, or the events up to `max_bytes` of frame
    /// text, from the front. Other events (callbacks, settles, timers) travel with
    /// them and don't count against the frame bounds.
    pub fn take_batch(&self, max_frames: usize, max_bytes: usize) -> Vec<SessionEvent> {
        let mut state = self.lock();
        let mut batch = Vec::new();
        let mut frames = 0_usize;
        let mut bytes = 0_usize;
        while let Some(event) = state.events.front() {
            if let SessionEvent::Frame { text, .. } = event {
                frames += 1;
                bytes += text.len();
            }
            let last = matches!(event, SessionEvent::Drained)
                || frames >= max_frames
                || bytes >= max_bytes;
            match state.events.pop_front() {
                Some(event) => batch.push(event),
                None => break,
            }
            if last {
                break;
            }
        }
        batch
    }

    /// Resolves once the queue holds an event. The permit `publish` leaves behind
    /// covers a push between the check and the wait.
    pub async fn wait(&self) {
        loop {
            if self.has_events() {
                return;
            }
            self.wake.notified().await;
        }
    }

    fn has_events(&self) -> bool {
        self.lock().events.iter().next().is_some()
    }

    /// The mutex is only ever held for value moves, so poisoning would mean a panic
    /// elsewhere; recover it, because a session must still deliver what it read.
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn log_drop_once(&self) {
        if !self.logged.swap(true, Ordering::SeqCst) {
            eprintln!("native session event after drained: dropped");
        }
    }
}

/// Numbers a frame at push; every other event passes unchanged.
fn numbered(event: SessionEvent, next_seq: &mut u64) -> SessionEvent {
    match event {
        SessionEvent::Frame {
            dir, channel, text, ..
        } => {
            let seq = *next_seq;
            *next_seq = next_seq.saturating_add(1);
            SessionEvent::Frame {
                seq,
                dir,
                channel,
                text,
            }
        }
        other => other,
    }
}

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
}

impl ReadGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// The diverted child's pumps, once the spawn has made them.
    pub fn attach(&self, output: OutputControl) {
        self.lock().output = Some(output);
    }

    /// Answers one delivered chunk under the gate's lock: `delivered.taken(false)` for Paused
    /// and Failed, `taken(true)` for Open and Draining. Never read the state and answer later.
    pub fn answer(&self, delivered: Delivered) {
        let inner = self.lock();
        let more = !matches!(inner.state, GateState::Paused | GateState::Failed);
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
                resume_both(&inner);
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
            resume_both(&inner);
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
