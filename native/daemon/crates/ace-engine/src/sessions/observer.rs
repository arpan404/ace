// SPDX-License-Identifier: Apache-2.0
//! The engine side of `SessionObserver` (`ace-adapter-api/src/session.rs`, E3-pi.3): one ordered
//! hand-off per session. The provider's producer thread pushes synchronously and returns; the
//! engine drains the queue on its own task, in the order the session produced it, and the terminal
//! exit is the barrier — everything before it is delivered, nothing after it is kept.

use ace_adapter_api::{SessionExit, SessionFrame, SessionObserver};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Poll, Waker};

/// The queue's bound: 4 MiB of event text or 4,096 events, the same figures the E3 bridge uses.
/// A full queue pauses the session's pumps through its own read gate; the inbox never drops an
/// event (only what arrives after the exit is dropped).
pub const QUEUE_BYTES: usize = 4 * 1024 * 1024;
pub const QUEUE_EVENTS: usize = 4096;

/// One thing a session hands the engine, in its own order.
pub enum Event {
    Frame(SessionFrame),
    /// The provider's own session id, once known and before any frame from it is echoed.
    Identity(String),
    /// The session cannot go on: the engine closes it, unexpectedly.
    Fatal(String),
    /// The terminal barrier: the child's pipes are closed and every frame they produced is before
    /// it.
    Exit(SessionExit),
}

impl Event {
    /// The text the queue's bound counts: a frame's channel and data.
    fn bytes(&self) -> usize {
        match self {
            Event::Frame(frame) => frame.channel.len() + frame.data.get().len(),
            Event::Identity(id) => id.len(),
            Event::Fatal(message) => message.len(),
            Event::Exit(_) => 0,
        }
    }
}

/// One session's ordered hand-off. Cloneable through `Arc`: the session keeps one handle for its
/// observer, the engine holds another for its drain task.
pub struct Inbox {
    state: Mutex<State>,
    waker: Mutex<Option<Waker>>,
}

struct State {
    events: VecDeque<Event>,
    drained: bool,
    bytes: usize,
    /// Set when an event arrives after the exit, so the drop is logged once.
    dropped: bool,
}

impl Default for Inbox {
    fn default() -> Inbox {
        Inbox {
            state: Mutex::new(State {
                events: VecDeque::new(),
                drained: false,
                bytes: 0,
                dropped: false,
            }),
            waker: Mutex::new(None),
        }
    }
}

impl Inbox {
    pub fn new() -> Arc<Inbox> {
        Arc::new(Inbox::default())
    }

    /// Pushes one event and wakes the drain. After the exit the event is dropped, once logged.
    pub fn push(&self, event: Event) {
        let mut state = self.lock();
        if state.drained {
            if !state.dropped {
                state.dropped = true;
                eprintln!("native session event after exit: dropped");
            }
            return;
        }
        state.drained = matches!(event, Event::Exit(_));
        state.bytes = state.bytes.saturating_add(event.bytes());
        state.events.push_back(event);
        drop(state);
        self.wake();
    }

    pub fn len(&self) -> usize {
        self.lock().events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().events.is_empty()
    }

    /// The text still queued, as the bound counts it.
    pub fn bytes(&self) -> usize {
        self.lock().bytes
    }

    /// A batch never crosses either frame bound; other events travel with it.
    pub fn take_batch(&self, max_frames: usize, max_bytes: usize) -> Vec<Event> {
        let mut state = self.lock();
        let mut batch = Vec::new();
        let mut frames: usize = 0;
        let mut bytes: usize = 0;
        while let Some(event) = state.events.front() {
            let size = match event {
                Event::Frame(frame) => Some(frame.channel.len() + frame.data.get().len()),
                _ => None,
            };
            if let Some(size) = size
                && !batch.is_empty()
                && (frames >= max_frames || bytes.saturating_add(size) > max_bytes)
            {
                break;
            }
            let drained = matches!(event, Event::Exit(_));
            let Some(event) = state.events.pop_front() else {
                break;
            };
            state.bytes = state.bytes.saturating_sub(event.bytes());
            if let Some(size) = size {
                frames += 1;
                bytes = bytes.saturating_add(size);
            }
            batch.push(event);
            if drained {
                break;
            }
        }
        batch
    }

    /// Resolves once the queue holds an event. A push between the check and the park leaves the
    /// waker stored, so no wake is lost.
    pub fn poll(&self) -> Poll<Vec<Event>> {
        let batch = self.take_batch(usize::MAX, QUEUE_BYTES);
        if batch.is_empty() && !self.lock().drained {
            Poll::Pending
        } else {
            Poll::Ready(batch)
        }
    }

    pub(crate) fn finish(&self) {
        self.lock().drained = true;
        self.wake();
    }

    /// Stores the drain task's waker; the next push wakes it.
    pub fn register(&self, waker: &Waker) {
        *self.waker.lock().unwrap_or_else(|error| error.into_inner()) = Some(waker.clone());
    }

    fn wake(&self) {
        let waker = self
            .waker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// The `SessionObserver` a session is handed: every call enqueues and returns.
pub struct QueueObserver {
    inbox: Arc<Inbox>,
}

impl QueueObserver {
    pub fn new(inbox: Arc<Inbox>) -> QueueObserver {
        QueueObserver { inbox }
    }
}

impl SessionObserver for QueueObserver {
    fn frame(&self, frame: SessionFrame) {
        self.inbox.push(Event::Frame(frame));
    }

    fn identity(&self, native_session_id: &str) {
        self.inbox
            .push(Event::Identity(native_session_id.to_owned()));
    }

    fn fatal(&self, message: &str) {
        self.inbox.push(Event::Fatal(message.to_owned()));
    }

    fn exit(&self, exit: SessionExit) {
        self.inbox.push(Event::Exit(exit));
    }
}

/// The engine's drain: where the session's events go, in order, on the engine's own task.
pub trait Sink {
    fn frame(&mut self, frame: SessionFrame);
    fn identity(&mut self, native_session_id: &str);
    fn fatal(&mut self, message: &str);
    fn exit(&mut self, exit: SessionExit);
}

/// Drains every queued event into `sink` in order, stopping at the exit. Returns how many events
/// it delivered.
pub fn drain(inbox: &Inbox, sink: &mut dyn Sink) -> usize {
    let mut delivered = 0;
    for event in inbox.take_batch(usize::MAX, QUEUE_BYTES) {
        match event {
            Event::Frame(frame) => sink.frame(frame),
            Event::Identity(id) => sink.identity(&id),
            Event::Fatal(message) => sink.fatal(&message),
            Event::Exit(exit) => {
                sink.exit(exit);
                delivered += 1;
                break;
            }
        }
        delivered += 1;
    }
    delivered
}

/// `thread.compact`'s admission: a provider without native compaction refuses it.
pub fn compact_supported(compaction: Option<bool>) -> bool {
    compaction == Some(true)
}

/// `thread_not_idle`: a provider compacts its own idle context, never in the middle of its turn.
pub fn compact_idle(state: &str) -> bool {
    !matches!(state, "working" | "starting" | "blocked" | "unresponsive")
}

#[cfg(test)]
mod tests;
