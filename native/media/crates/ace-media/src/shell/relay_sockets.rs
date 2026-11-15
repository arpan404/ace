// SPDX-License-Identifier: Apache-2.0
//! The relay streams' sockets, one entry per stream from its dial until its socket is gone.
//!
//! - **Dialing.** The dial task puts the socket it made into the entry's slot in the same step
//!   that spawns its tasks (no await in between), so a close finds every task that could own the
//!   socket: before the dial ends, while its `Dialed` event waits in the queue, after.
//! - **Closing.** A close keeps its entry, with a way to force it, until the socket is gone. A
//!   later close of the same stream joins that completion rather than answering at once, and a
//!   forced one (a revocation) escalates a graceful close in progress.
use super::relay::{DIAL_DEADLINE, Opened, RelayEvent, Socket, open, spawn, spawn_tls};
use crate::engine::relay::{CloseMode, Pool};
use media_wire::control::Id;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::JoinHandle;

type Slot = Arc<Mutex<Option<Socket>>>;

struct Entry {
    dial: JoinHandle<()>,
    slot: Slot,
}

/// A close in progress.
struct Closing {
    force: Arc<Notify>,
    done: watch::Receiver<bool>,
}

pub struct RelaySockets {
    events: mpsc::Sender<RelayEvent>,
    streams: HashMap<String, Entry>,
    closing: HashMap<String, Closing>,
    pool: Pool,
}

fn store(slot: &Slot, socket: Socket) {
    // A poisoned slot drops the socket, which aborts its tasks.
    if let Ok(mut held) = slot.lock() {
        *held = Some(socket);
    }
}

/// Ends once the close behind `done` has.
async fn finished(mut done: watch::Receiver<bool>) {
    while !*done.borrow_and_update() {
        if done.changed().await.is_err() {
            return;
        }
    }
}

impl RelaySockets {
    pub fn new(events: mpsc::Sender<RelayEvent>, pool: Pool) -> Self {
        Self {
            events,
            streams: HashMap::new(),
            closing: HashMap::new(),
            pool,
        }
    }

    pub fn dial(&mut self, stream: String, url: String) {
        let events = self.events.clone();
        let pool = self.pool.clone();
        let Ok(id) = Id::new(stream.clone()) else {
            return;
        };
        let slot: Slot = Arc::default();
        let held = slot.clone();
        let dial = tokio::spawn(async move {
            let opened = tokio::time::timeout(DIAL_DEADLINE, open(&url)).await;
            let event = match opened {
                Ok(Ok(Opened::Plain(read, write, leftover, handle))) => {
                    let socket = spawn(
                        id.clone(),
                        read,
                        write,
                        leftover,
                        handle,
                        events.clone(),
                        pool,
                    );
                    store(&held, socket);
                    RelayEvent::Dialed { stream: id }
                }
                Ok(Ok(Opened::Tls(tls, leftover, handle))) => {
                    let socket = spawn_tls(id.clone(), tls, leftover, handle, events.clone(), pool);
                    store(&held, socket);
                    RelayEvent::Dialed { stream: id }
                }
                // A certificate the trust store doesn't vouch for is never retried or waived:
                // the stream fails and the client stays on legacy delivery.
                Ok(Err(reason)) => RelayEvent::Ended { stream: id, reason },
                Err(_) => RelayEvent::Ended {
                    stream: id,
                    reason: "dial",
                },
            };
            let _ = events.send(event).await;
        });
        if let Some(old) = self.streams.insert(stream, Entry { dial, slot }) {
            old.dial.abort();
        }
    }

    /// Queues a sealed frame. False when the stream has no socket or is backed up.
    pub fn send(&mut self, stream: &str, frame: Vec<u8>) -> bool {
        let refused = match self.streams.get(stream).map(|entry| entry.slot.lock()) {
            Some(Ok(held)) => match held.as_ref() {
                Some(socket) => socket.send(frame).err(),
                None => Some(frame),
            },
            _ => Some(frame),
        };
        match refused {
            None => true,
            Some(frame) => {
                self.pool.give(frame);
                false
            }
        }
    }

    /// Shuts the stream's socket, `mode` deciding how. The handle ends once the dial and every
    /// task that owned the socket have ended and the socket is closed, so an answer saying the
    /// socket is shut (`revoked`, `closed`) can wait for it. A close already in progress is
    /// joined (and forced, for a forced close). None when the stream has no socket here.
    pub fn close(&mut self, stream: &str, mode: CloseMode) -> Option<JoinHandle<()>> {
        self.closing.retain(|_, closing| !*closing.done.borrow());
        if let Some(closing) = self.closing.get(stream) {
            if mode == CloseMode::Forced {
                closing.force.notify_one();
            }
            return Some(tokio::spawn(finished(closing.done.clone())));
        }
        let entry = self.streams.remove(stream)?;
        let force = Arc::new(Notify::new());
        let (done_tx, done) = watch::channel(false);
        let events = self.events.clone();
        let id = Id::new(stream.to_owned()).ok();
        let forcing = force.clone();
        tokio::spawn(async move {
            // A dial that ended has put its socket in the slot; one cut short leaves it there, or
            // drops what it held (with a reset).
            entry.dial.abort();
            let _ = entry.dial.await;
            let socket = entry.slot.lock().ok().and_then(|mut held| held.take());
            if let Some(socket) = socket {
                socket.shut(mode, forcing).await;
            }
            let _ = done_tx.send(true);
            if let Some(stream) = id {
                let _ = events.send(RelayEvent::Closed { stream }).await;
            }
        });
        let joined = tokio::spawn(finished(done.clone()));
        self.closing
            .insert(stream.to_owned(), Closing { force, done });
        Some(joined)
    }

    /// Ends once every close in progress has (shutdown waits for it, within its budget).
    pub fn settled(&mut self) -> impl Future<Output = ()> + use<> {
        self.closing.retain(|_, closing| !*closing.done.borrow());
        let pending: Vec<_> = self
            .closing
            .values()
            .map(|closing| closing.done.clone())
            .collect();
        async move {
            for done in pending {
                finished(done).await;
            }
        }
    }

    /// The token every task owning the stream's socket holds (tests).
    #[cfg(test)]
    pub fn alive(&self, stream: &str) -> Option<std::sync::Weak<()>> {
        let entry = self.streams.get(stream)?;
        let held = entry.slot.lock().ok()?;
        held.as_ref().map(Socket::alive)
    }

    /// Aborts the stream's writer alone, as a close that finished too early would (tests).
    #[cfg(test)]
    pub fn abort_writer(&self, stream: &str) {
        if let Some(Ok(held)) = self.streams.get(stream).map(|entry| entry.slot.lock())
            && let Some(socket) = held.as_ref()
        {
            socket.abort_writer();
        }
    }
}
