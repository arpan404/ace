// SPDX-License-Identifier: Apache-2.0
//! The relay streams' sockets, one entry per stream from its dial on. The dial task puts the
//! socket it made into the entry's slot in the same step that spawns its tasks (no await in
//! between), so a close finds every task that could own the socket: before the dial ends, while
//! its `Dialed` event waits in the queue, after the main loop took it.
use super::relay::{DIAL_DEADLINE, Opened, RelayEvent, Socket, open, spawn, spawn_tls};
use crate::engine::relay::{CloseMode, Pool};
use media_wire::control::Id;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

type Slot = Arc<Mutex<Option<Socket>>>;

struct Entry {
    dial: JoinHandle<()>,
    slot: Slot,
}

pub struct RelaySockets {
    events: mpsc::Sender<RelayEvent>,
    streams: HashMap<String, Entry>,
    pool: Pool,
}

fn store(slot: &Slot, socket: Socket) {
    // A poisoned slot drops the socket, which aborts its tasks.
    if let Ok(mut held) = slot.lock() {
        *held = Some(socket);
    }
}

impl RelaySockets {
    pub fn new(events: mpsc::Sender<RelayEvent>, pool: Pool) -> Self {
        Self {
            events,
            streams: HashMap::new(),
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
                Ok(Ok(Opened::Plain(read, write, leftover))) => {
                    store(
                        &held,
                        spawn(id.clone(), read, write, leftover, events.clone(), pool),
                    );
                    RelayEvent::Dialed { stream: id }
                }
                Ok(Ok(Opened::Tls(tls, leftover))) => {
                    store(
                        &held,
                        spawn_tls(id.clone(), tls, leftover, events.clone(), pool),
                    );
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
    /// task that owned the socket have ended, so an answer saying the socket is shut (`revoked`,
    /// `closed`) can wait for it. None when the stream has no socket here.
    pub fn close(&mut self, stream: &str, mode: CloseMode) -> Option<JoinHandle<()>> {
        let entry = self.streams.remove(stream)?;
        Some(tokio::spawn(async move {
            // A dial that ended has put its socket in the slot; one cut short leaves it there, or
            // drops what it held (with a reset).
            entry.dial.abort();
            let _ = entry.dial.await;
            let socket = entry.slot.lock().ok().and_then(|mut held| held.take());
            if let Some(socket) = socket {
                socket.shut(mode).await;
            }
        }))
    }
}
