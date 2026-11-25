// SPDX-License-Identifier: Apache-2.0
//! The host's storage acknowledgements (`host.ts:146`–`:189`). One host request may carry a
//! whole batch, so it is answered `{ committed: true }` only once every frame it carries was
//! stored. The first refusal, in arrival order, is the reply's error, and a frame the facade
//! reports twice is answered once: an answered batch is gone from the book.
//!
//! A notification's frames carry no request id (`host.ts:181`–`:188`): a refusal there stops the
//! host instead of answering, and a commit only retires its entry.

use ace_supervisor::jsonrpc::RpcId;

/// One answered outcome of [`AckBook::committed`] or [`AckBook::refused`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ack {
    /// Every frame of this request was stored: answer `{ committed: true }`.
    Committed(RpcId),
    /// The request's first refusal: answer the host with this reason.
    Refused { id: RpcId, reason: String },
    /// A refused frame belonged to a notification, so the host stops with this reason.
    Stop(String),
}

/// One request (or notification) still waiting on its frames.
#[derive(Debug)]
struct Pending {
    /// `None` for a notification's frames.
    id: Option<RpcId>,
    first: u64,
    count: u64,
    remaining: u64,
}

/// The frames each host input is still waiting on, in arrival order.
#[derive(Debug, Default)]
pub struct AckBook {
    pending: Vec<Pending>,
}

impl AckBook {
    pub fn new() -> AckBook {
        AckBook::default()
    }

    /// One request or notification whose frames start at `first`, `count` of them.
    pub fn track(&mut self, id: Option<RpcId>, first: u64, count: u64) {
        if count == 0 {
            return;
        }
        self.pending.push(Pending {
            id,
            first,
            count,
            remaining: count,
        });
    }

    /// The frame at `seq` was stored. `None` once that outcome was already answered.
    pub fn committed(&mut self, seq: u64) -> Option<Ack> {
        let at = self.position(seq)?;
        let pending = self.pending.get_mut(at)?;
        pending.remaining = pending.remaining.saturating_sub(1);
        if pending.remaining > 0 {
            return None;
        }
        let pending = self.pending.remove(at);
        pending.id.map(Ack::Committed)
    }

    /// The frame at `seq` could not be stored. `None` once that outcome was already answered.
    pub fn refused(&mut self, seq: u64, reason: &str) -> Option<Ack> {
        let at = self.position(seq)?;
        let pending = self.pending.remove(at);
        Some(match pending.id {
            Some(id) => Ack::Refused {
                id,
                reason: reason.to_owned(),
            },
            None => Ack::Stop(reason.to_owned()),
        })
    }

    fn position(&self, seq: u64) -> Option<usize> {
        self.pending
            .iter()
            .position(|pending| seq >= pending.first && seq - pending.first < pending.count)
    }
}

#[cfg(test)]
mod tests {
    use ace_supervisor::jsonrpc::RpcId;

    use super::{Ack, AckBook};

    fn id() -> RpcId {
        RpcId::Number(1.0)
    }

    #[test]
    fn a_request_is_answered_only_after_its_last_frame() {
        let mut book = AckBook::new();
        book.track(Some(id()), 1, 3);
        assert_eq!(book.committed(1), None);
        assert_eq!(book.committed(2), None);
        assert_eq!(book.committed(3), Some(Ack::Committed(id())));
        // A second report for an answered frame is not answered again.
        assert_eq!(book.committed(3), None);
    }

    #[test]
    fn the_first_refusal_in_arrival_order_is_the_reply() {
        let mut book = AckBook::new();
        book.track(Some(id()), 1, 3);
        assert_eq!(
            book.refused(2, "ace could not store a Cursor SDK frame: disk full"),
            Some(Ack::Refused {
                id: id(),
                reason: "ace could not store a Cursor SDK frame: disk full".into(),
            })
        );
        // Its siblings are retired with it: an arrived-later failure changes nothing.
        assert_eq!(book.refused(1, "another"), None);
        assert_eq!(book.committed(3), None);
    }

    #[test]
    fn a_notification_that_fails_stops_the_host_and_never_answers() {
        let mut book = AckBook::new();
        book.track(None, 7, 2);
        assert_eq!(book.committed(7), None);
        assert_eq!(
            book.refused(8, "ace could not store a Cursor SDK frame: full"),
            Some(Ack::Stop(
                "ace could not store a Cursor SDK frame: full".into()
            ))
        );
    }

    #[test]
    fn each_request_is_tracked_on_its_own_frames() {
        let mut book = AckBook::new();
        book.track(Some(id()), 1, 1);
        book.track(Some(RpcId::Number(2.0)), 2, 2);
        assert_eq!(book.committed(1), Some(Ack::Committed(id())));
        assert_eq!(book.committed(2), None);
        assert_eq!(book.committed(3), Some(Ack::Committed(RpcId::Number(2.0))));
    }
}
