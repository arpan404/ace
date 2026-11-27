// SPDX-License-Identifier: Apache-2.0
//! The notification streams a lease may hold (`principal-bus.ts`, `legacy-sessions.ts`).
//!
//! A stream is a bounded queue of JSON-RPC notifications the listener writes as SSE frames. A
//! newer stream from a lease closes its oldest, so a reconnecting client is never refused; at
//! the server-wide cap a stream is refused instead. The queue is a channel, so a client that goes
//! away is noticed by the next send, and the writer's end is `None` once the sender is dropped.

use std::collections::{HashMap, VecDeque};
use std::fmt;

use ace_json::{Map, Value};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::credentials::LeaseId;
use crate::jsonrpc::Message;

/// The streams one endpoint holds for one kind of subscription.
#[derive(Default)]
pub struct Streams {
    leases: HashMap<LeaseId, VecDeque<u64>>,
    streams: HashMap<u64, UnboundedSender<Value>>,
    /// Legacy streams belong to one transport session, which ends them when it goes.
    sessions: HashMap<u64, String>,
    next: u64,
}

impl Streams {
    /// Opens one stream for `lease`. `None` only when the server-wide total is reached.
    pub fn open(
        &mut self,
        lease: LeaseId,
        per_lease: usize,
        total: usize,
    ) -> Option<(u64, UnboundedReceiver<Value>)> {
        let owned = self.leases.entry(lease).or_default();
        if owned.len() >= per_lease.max(1) {
            if let Some(oldest) = owned.pop_front() {
                self.streams.remove(&oldest);
                self.sessions.remove(&oldest);
            }
        } else if self.streams.len() >= total {
            return None;
        }
        self.next += 1;
        let id = self.next;
        let (sender, receiver) = unbounded_channel();
        owned.push_back(id);
        self.streams.insert(id, sender);
        Some((id, receiver))
    }

    /// Opens one stream that ends with `session` (a legacy GET).
    pub fn open_session(
        &mut self,
        lease: LeaseId,
        per_lease: usize,
        total: usize,
        session: &str,
    ) -> Option<(u64, UnboundedReceiver<Value>)> {
        let opened = self.open(lease, per_lease, total)?;
        self.sessions.insert(opened.0, session.to_owned());
        Some(opened)
    }

    /// Ends every stream of `session`, as closing its transport does.
    pub fn close_session(&mut self, session: &str) {
        let ids: Vec<u64> = self
            .sessions
            .iter()
            .filter(|(_, owned)| owned.as_str() == session)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.close(id);
        }
    }

    /// Ends one stream; false when it was already gone.
    pub fn close(&mut self, id: u64) -> bool {
        self.sessions.remove(&id);
        if self.streams.remove(&id).is_none() {
            return false;
        }
        for owned in self.leases.values_mut() {
            owned.retain(|held| *held != id);
        }
        self.leases.retain(|_, owned| !owned.is_empty());
        true
    }

    /// Queues `notifications/tools/list_changed` for every stream of `lease`.
    pub fn tools_changed(&mut self, lease: LeaseId) {
        let Some(owned) = self.leases.get(&lease).cloned() else {
            return;
        };
        let notification = Message::notification(
            "notifications/tools/list_changed",
            Value::Object(Map::new()),
        );
        let mut gone = Vec::new();
        for id in owned {
            let Some(sender) = self.streams.get(&id) else {
                continue;
            };
            if sender.send(notification.clone()).is_err() {
                gone.push(id);
            }
        }
        for id in gone {
            self.close(id);
        }
    }

    pub fn held(&self, lease: LeaseId) -> usize {
        self.leases.get(&lease).map_or(0, VecDeque::len)
    }

    pub fn total(&self) -> usize {
        self.streams.len()
    }

    /// Ends every stream of a lease that ended.
    pub fn close_lease(&mut self, lease: LeaseId) {
        if let Some(owned) = self.leases.remove(&lease) {
            for id in owned {
                self.streams.remove(&id);
                self.sessions.remove(&id);
            }
        }
    }
}

/// One open stream, as the listener holds it.
pub struct NotificationStream {
    id: u64,
    frames: UnboundedReceiver<Value>,
    /// Ends the stream when the listener goes away: a legacy GET also ends its session, as
    /// `legacy-sessions.ts:47` closes a disconnected transport.
    closed: Option<Box<dyn FnOnce() + Send>>,
}

impl fmt::Debug for NotificationStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationStream")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl NotificationStream {
    pub fn new(
        id: u64,
        frames: UnboundedReceiver<Value>,
        closed: impl FnOnce() + Send + 'static,
    ) -> NotificationStream {
        NotificationStream {
            id,
            frames,
            closed: Some(Box::new(closed)),
        }
    }

    /// The stream's identity, for a listener that also ends it by hand.
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The next notification, or `None` when the server ended the stream.
    pub async fn recv(&mut self) -> Option<Value> {
        self.frames.recv().await
    }
}

impl Drop for NotificationStream {
    fn drop(&mut self) {
        if let Some(closed) = self.closed.take() {
            closed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_are_bounded_per_lease_and_in_all_and_a_closed_one_stops() {
        let mut streams = Streams::default();
        let (first, mut first_frames) = streams.open(LeaseId(1), 2, 3).expect("first");
        let (second, mut second_frames) = streams.open(LeaseId(1), 2, 3).expect("second");
        // A newer stream from the same lease closes its oldest rather than being refused.
        let (third, mut third_frames) = streams
            .open(LeaseId(1), 2, 3)
            .expect("the lease's third replaces its oldest");
        assert_ne!(third, first);
        assert_eq!(streams.held(LeaseId(1)), 2);
        assert_eq!(
            first_frames.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected),
            "the replaced stream's sender was kept"
        );
        assert!(streams.open(LeaseId(2), 2, 3).is_some());
        // The server-wide cap refuses a stream from a lease with no room of its own.
        assert!(
            streams.open(LeaseId(3), 2, 3).is_none(),
            "a fourth stream in all"
        );
        streams.tools_changed(LeaseId(1));
        let frame = second_frames.try_recv().expect("a frame");
        assert_eq!(
            frame.get("method").and_then(Value::as_str),
            Some("notifications/tools/list_changed")
        );
        assert!(third_frames.try_recv().is_ok());
        assert!(streams.close(second));
        assert_eq!(streams.held(LeaseId(1)), 1);
        assert!(streams.open(LeaseId(3), 2, 3).is_some());
        assert!(!streams.close(second));
    }

    #[test]
    fn a_stream_whose_reader_vanished_is_dropped_by_the_next_send() {
        let mut streams = Streams::default();
        let (id, frames) = streams.open(LeaseId(1), 2, 3).expect("stream");
        drop(frames);
        streams.tools_changed(LeaseId(1));
        assert_eq!(streams.total(), 0, "a dead stream still holds the cap");
        assert!(!streams.close(id));
    }

    #[test]
    fn ending_a_lease_ends_its_streams_and_runs_its_cleanup_once() {
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = std::sync::Arc::clone(&closed);
        let mut streams = Streams::default();
        let (id, frames) = streams.open(LeaseId(1), 2, 3).expect("stream");
        let handle = NotificationStream::new(id, frames, move || {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        streams.close_lease(LeaseId(1));
        assert_eq!(streams.total(), 0);
        drop(handle);
        assert_eq!(closed.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
