// SPDX-License-Identifier: Apache-2.0
//! What one stdin owns (`rpc-owner.ts:14`): the id reservations, the bounded write queue,
//! the one active write, and each peer's incoming-request slots.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::budget::StreamError;
use crate::jsonrpc::{RpcId, RpcIds, WriterQueue};

use super::{DEFAULT_MAX_QUEUED_BYTES, MAX_EXPLICIT_IDS};

/// What one stdin owns (`rpc-owner.ts:14`): the id reservations, the bounded
/// write queue and every peer's incoming slots. Write acknowledgement belongs
/// to the queue, not to a peer: whichever peer the I/O shell calls, it releases
/// the one active ticket and the queue hands out the next line.
#[derive(Clone)]
pub struct PeerOwner {
    ids: Arc<Mutex<RpcIds>>,
    inner: Arc<Mutex<OwnerInner>>,
    next_peer: Arc<AtomicU64>,
}

struct OwnerInner {
    writer: WriterQueue,
    /// Live tickets: queued ones carry their wire, active ones only their peer.
    tickets: HashMap<u64, Ticket>,
    /// Each peer's open incoming-request slots, released when its reply lands.
    peers: HashMap<u64, PeerSlots>,
}

struct Ticket {
    peer: u64,
    wire: Option<Vec<u8>>,
}

#[derive(Default)]
struct PeerSlots {
    incoming: usize,
    replies: HashSet<u64>,
    retired: bool,
}

impl PeerOwner {
    /// The first peer on a pipe fixes the queue's byte cap; later peers reuse it.
    pub fn new(max_queued_bytes: usize) -> PeerOwner {
        PeerOwner {
            ids: Arc::new(Mutex::new(RpcIds::new(MAX_EXPLICIT_IDS))),
            inner: Arc::new(Mutex::new(OwnerInner {
                writer: WriterQueue::new(max_queued_bytes),
                tickets: HashMap::new(),
                peers: HashMap::new(),
            })),
            next_peer: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(super) fn join(&self) -> u64 {
        let peer = self.next_peer.fetch_add(1, Ordering::Relaxed);
        self.lock().peers.insert(peer, PeerSlots::default());
        peer
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, OwnerInner> {
        match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub(super) fn reserve(&self, id: Option<RpcId>) -> Result<RpcId, StreamError> {
        let mut ids = match self.ids.lock() {
            Ok(ids) => ids,
            Err(poisoned) => poisoned.into_inner(),
        };
        ids.reserve(id)
    }

    pub(super) fn enqueue(&self, peer: u64, wire: Vec<u8>) -> Result<u64, StreamError> {
        let mut inner = self.lock();
        let ticket = inner.writer.enqueue(wire.len())?;
        inner.tickets.insert(
            ticket,
            Ticket {
                peer,
                wire: Some(wire),
            },
        );
        Ok(ticket)
    }

    /// A reply publishes its slot before any peer can claim the write: both
    /// happen under this one lock, so the gap cannot leak the slot.
    pub(super) fn enqueue_reply(&self, peer: u64, wire: Vec<u8>) -> Result<u64, StreamError> {
        let mut inner = self.lock();
        let ticket = inner.writer.enqueue(wire.len())?;
        inner.tickets.insert(
            ticket,
            Ticket {
                peer,
                wire: Some(wire),
            },
        );
        if let Some(slots) = inner.peers.get_mut(&peer) {
            slots.replies.insert(ticket);
        }
        Ok(ticket)
    }

    /// The next queued line, whichever peer enqueued it: the pipe is shared, so
    /// any peer may hand its bytes to stdin.
    pub(super) fn claim(&self) -> Option<(u64, Vec<u8>)> {
        let mut inner = self.lock();
        let ticket = inner.writer.claim()?;
        let wire = inner.tickets.get_mut(&ticket)?.wire.take()?;
        Some((ticket, wire))
    }

    /// The active write's callback. A queued or unknown ticket is refused, so
    /// its payload stays for its turn; an active one releases its peer's reply
    /// slot.
    pub(super) fn written(&self, ticket: u64) -> bool {
        let mut inner = self.lock();
        if inner.writer.active() != Some(ticket) {
            return false;
        }
        inner.writer.written(ticket);
        if let Some(entry) = inner.tickets.remove(&ticket) {
            let mut finished = false;
            if let Some(slots) = inner.peers.get_mut(&entry.peer) {
                if slots.replies.remove(&ticket) {
                    slots.incoming = slots.incoming.saturating_sub(1);
                }
                finished = slots.retired && slots.replies.is_empty();
            }
            if finished {
                inner.peers.remove(&entry.peer);
            }
        }
        true
    }

    /// Cancel one of this peer's queued writes; an active one stays charged.
    pub(super) fn cancel(&self, peer: u64, ticket: u64) -> bool {
        let mut inner = self.lock();
        if inner.tickets.get(&ticket).map(|entry| entry.peer) != Some(peer) {
            return false;
        }
        if inner.writer.cancel(ticket) {
            inner.tickets.remove(&ticket);
            true
        } else {
            false
        }
    }

    /// Drop this peer's queued writes and leave the shared queue open. A
    /// cancelled reply releases the slot its send would have settled.
    pub(super) fn cancel_owner(&self, peer: u64) {
        let mut inner = self.lock();
        let mine: Vec<u64> = inner
            .tickets
            .iter()
            .filter(|(_, entry)| entry.peer == peer)
            .map(|(ticket, _)| *ticket)
            .collect();
        for ticket in mine {
            if inner.writer.cancel(ticket) {
                inner.tickets.remove(&ticket);
                if let Some(slots) = inner.peers.get_mut(&peer)
                    && slots.replies.remove(&ticket)
                {
                    slots.incoming = slots.incoming.saturating_sub(1);
                }
            }
        }
    }

    pub(super) fn incoming(&self, peer: u64) -> usize {
        self.lock()
            .peers
            .get(&peer)
            .map_or(0, |slots| slots.incoming)
    }

    pub(super) fn receive(&self, peer: u64) {
        if let Some(slots) = self.lock().peers.get_mut(&peer) {
            slots.incoming += 1;
        }
    }

    pub(super) fn release_request(&self, peer: u64) {
        if let Some(slots) = self.lock().peers.get_mut(&peer) {
            slots.incoming = slots.incoming.saturating_sub(1);
        }
    }

    /// Mark a stopped peer retired. Its queued writes were cancelled and its
    /// pending calls settled; an in-flight reply keeps the record until
    /// `written` releases its slot, then the record goes too.
    pub(super) fn retire(&self, peer: u64) {
        let mut inner = self.lock();
        let Some(slots) = inner.peers.get_mut(&peer) else {
            return;
        };
        slots.retired = true;
        if slots.replies.is_empty() {
            inner.peers.remove(&peer);
        }
    }

    #[cfg(test)]
    pub(super) fn peer_records(&self) -> usize {
        self.lock().peers.len()
    }
}

impl Default for PeerOwner {
    fn default() -> PeerOwner {
        PeerOwner::new(DEFAULT_MAX_QUEUED_BYTES)
    }
}
