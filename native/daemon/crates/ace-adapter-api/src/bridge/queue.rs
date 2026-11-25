// SPDX-License-Identifier: Apache-2.0
//! The ordered event queue (E3.0c): one per session, FIFO, bounded in bytes and
//! events, and paced through the read gate so a stalled JS thread never grows it
//! without end (ADR 0223 §7 rule 3).

use super::gate::ReadGate;
use crate::frame::FrameDirection;
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
    /// A port the facade must run and answer (`stop`, `launch`): the session's
    /// async I/O that only the shell owns, asked in the session's own order.
    Port {
        name: &'static str,
        json: String,
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
            SessionEvent::Port { name, json } => {
                event.serialize_element("port")?;
                event.serialize_element(name)?;
                event.serialize_element(json)?;
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

/// The queue's bound: 4 MiB of event text or 4,096 events. Past it the child's
/// pumps pause through the read gate, so a stalled JS thread can't make the
/// queue grow without end.
pub const QUEUE_BYTES: usize = 4 * 1024 * 1024;
pub const QUEUE_EVENTS: usize = 4096;

/// One session's ordered queue. Clone it freely: every clone shares the queue.
#[derive(Clone)]
pub struct EventQueue {
    state: Arc<Mutex<QueueState>>,
    wake: Arc<Notify>,
    /// Set when an event arrives after `Drained`, so the drop is logged once.
    logged: Arc<AtomicBool>,
}

struct QueueState {
    events: VecDeque<SessionEvent>,
    next_seq: u64,
    drained: bool,
    /// Event text held: what the bound measures.
    bytes: usize,
    /// The gate whose pumps stop while the queue is at its bound.
    pace: ReadGate,
}

impl EventQueue {
    /// The queue with the gate that paces the child's pumps. The session core
    /// makes both, so a full queue stops its own provider.
    pub fn new(pace: ReadGate) -> Self {
        EventQueue::starting_at(pace, 0)
    }

    /// The queue whose first frame is `first`: the Cursor session numbers its
    /// frames from 1, as `session.ts:76` does.
    pub fn starting_at(pace: ReadGate, first: u64) -> Self {
        Self {
            state: Arc::new(Mutex::new(QueueState {
                events: VecDeque::new(),
                next_seq: first,
                drained: false,
                bytes: 0,
                pace,
            })),
            wake: Arc::new(Notify::new()),
            logged: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Pushes every event of one input under one lock, in order. Frames get their seq here.
    /// After `Drained` it drops the events and logs once; it never panics.
    ///
    /// The bound paces the pumps only: a full queue pauses the child's output
    /// through the gate and never drops an event. Producers that are not pumps
    /// (timers, replies to the facade, the exit) may take it past the bound,
    /// because each is bounded by the work it answers for.
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
            state.bytes = state.bytes.saturating_add(event.bytes());
            state.events.push_back(event);
        }
        let pushed = state.events.iter().next().is_some();
        if state.at_bound() {
            // The pumps stop at their next delivered chunk (the gate answers it
            // `taken(false)`); nothing read is lost, it waits here instead.
            state.pace.overflow(true);
        }
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

    /// Reserves the next frame number without publishing a frame, under the queue's
    /// lock: what a session's fallback operation id takes (`session.ts:260`), so the
    /// frame it precedes is numbered exactly as `++seq` numbered it.
    pub fn reserve_seq(&self) -> u64 {
        let mut state = self.lock();
        let seq = state.next_seq;
        state.next_seq = state.next_seq.saturating_add(1);
        seq
    }

    /// Takes at most `max_frames` frames, or the frames up to `max_bytes` of frame
    /// text, from the front, checking each frame before it is taken: a batch never
    /// passes either bound, and a single frame bigger than the byte bound still
    /// goes alone. Other events (callbacks, settles, timers) travel with the frames
    /// and don't count against the frame bounds.
    pub fn take_batch(&self, max_frames: usize, max_bytes: usize) -> Vec<SessionEvent> {
        let mut state = self.lock();
        let mut batch = Vec::new();
        let mut frames = 0_usize;
        let mut bytes = 0_usize;
        while let Some(event) = state.events.front() {
            let frame = match event {
                SessionEvent::Frame { text, .. } => Some(text.len()),
                _ => None,
            };
            if let Some(size) = frame
                && !batch.is_empty()
                && (frames >= max_frames || bytes.saturating_add(size) > max_bytes)
            {
                break;
            }
            let drained = matches!(event, SessionEvent::Drained);
            let Some(event) = state.events.pop_front() else {
                break;
            };
            state.bytes = state.bytes.saturating_sub(event.bytes());
            if let Some(size) = frame {
                frames += 1;
                bytes = bytes.saturating_add(size);
            }
            batch.push(event);
            if drained {
                break;
            }
        }
        if !state.at_bound() {
            // The backlog that paused the pumps is posted: they read on, unless
            // the engine's own flow (Paused or Failed) is what holds them.
            state.pace.overflow(false);
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
            dir,
            channel,
            text,
            seq,
        } => {
            // A frame that already carries its number keeps it: `reserve_seq` took it
            // from this same counter, so the sequence stays contiguous. Zero means the
            // queue numbers it, as producers that never reserve do.
            if seq != 0 {
                return SessionEvent::Frame {
                    seq,
                    dir,
                    channel,
                    text,
                };
            }
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

impl QueueState {
    /// Whether the queue is at its bound: past it, the pumps pause.
    fn at_bound(&self) -> bool {
        self.bytes >= QUEUE_BYTES || self.events.len() >= QUEUE_EVENTS
    }
}

impl SessionEvent {
    /// The event's text, as the queue's bound counts it.
    fn bytes(&self) -> usize {
        match self {
            SessionEvent::Frame { channel, text, .. } => channel.len() + text.len(),
            SessionEvent::Callback { name, json } => name.len() + json.len(),
            SessionEvent::Settle { result, .. } => match result {
                Ok(json) => json.len(),
                Err(error) => error.code.len() + error.message.len(),
            },
            SessionEvent::ArmTimer { key, .. } => key.len(),
            SessionEvent::CancelTimer { key } => key.len(),
            SessionEvent::Port { name, json } => name.len() + json.len(),
            SessionEvent::Fatal { message } => message.len(),
            SessionEvent::Drained => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{EventQueue, ReadGate, SessionEvent};
    use crate::frame::FrameDirection;

    fn frame(text: &str) -> SessionEvent {
        SessionEvent::Frame {
            seq: 0,
            dir: FrameDirection::Recv,
            channel: "sdk".to_owned(),
            text: text.to_owned(),
        }
    }

    fn seqs(events: &[SessionEvent]) -> Vec<u64> {
        events
            .iter()
            .filter_map(|event| match event {
                SessionEvent::Frame { seq, .. } => Some(*seq),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_queue_starting_at_one_numbers_its_first_frame_one() {
        let queue = EventQueue::starting_at(ReadGate::new(), 1);
        queue.publish(vec![frame("a"), frame("b")]);
        assert_eq!(seqs(&queue.take_batch(16, 16_384)), vec![1, 2]);
    }

    #[test]
    fn a_reserved_number_is_skipped_by_the_frames_around_it() {
        let queue = EventQueue::starting_at(ReadGate::new(), 1);
        queue.publish(vec![frame("a")]);
        // The fallback operation id takes one, as `session.ts:260` does.
        assert_eq!(queue.reserve_seq(), 2);
        queue.publish(vec![frame("b")]);
        assert_eq!(seqs(&queue.take_batch(16, 16_384)), vec![1, 3]);
    }

    #[test]
    fn a_frame_that_reserved_its_own_number_keeps_it() {
        let queue = EventQueue::starting_at(ReadGate::new(), 1);
        let seq = queue.reserve_seq();
        queue.publish(vec![SessionEvent::Frame {
            seq,
            dir: FrameDirection::Recv,
            channel: "sdk".to_owned(),
            text: "a".to_owned(),
        }]);
        queue.publish(vec![frame("b")]);
        assert_eq!(seqs(&queue.take_batch(16, 16_384)), vec![1, 2]);
    }
}
