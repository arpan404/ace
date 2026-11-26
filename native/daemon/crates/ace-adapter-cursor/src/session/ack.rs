// SPDX-License-Identifier: Apache-2.0
//! The host's storage acknowledgements (`host.ts:146`-`:189`). One host request may carry a
//! whole batch, so it is answered `{ committed: true }` only once every frame it carries was
//! stored. The first refusal, in arrival order, is the reply's error. A frame's first report is
//! its outcome: a repeated report (committed twice, or refused after a commit) is ignored, and an
//! answered batch is gone from the book.
//!
//! A notification's frames carry no request id (`host.ts:181`-`:188`): a refusal there stops the
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
    /// The frames already reported for, so a repeated or reordered report counts once: the
    /// caller can race two outcomes for one frame, and a duplicate must not answer early.
    reported: std::collections::HashSet<u64>,
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
            reported: std::collections::HashSet::new(),
        });
    }

    /// The frame at `seq` was stored. `None` once that outcome was already answered, and
    /// `None` while another distinct frame of the same input is still waiting.
    pub fn committed(&mut self, seq: u64) -> Option<Ack> {
        let at = self.position(seq)?;
        let pending = self.pending.get_mut(at)?;
        if !pending.reported.insert(seq) {
            return None;
        }
        pending.remaining = pending.remaining.saturating_sub(1);
        if pending.remaining > 0 {
            return None;
        }
        let pending = self.pending.remove(at);
        pending.id.map(Ack::Committed)
    }

    /// The frame at `seq` could not be stored. `None` once that outcome was already answered:
    /// the first report for a frame is its outcome, and a later one (even a refusal after a
    /// commit) is not a second answer.
    pub fn refused(&mut self, seq: u64, reason: &str) -> Option<Ack> {
        let at = self.position(seq)?;
        if !self.pending.get_mut(at)?.reported.insert(seq) {
            return None;
        }
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
    fn a_repeated_report_for_one_frame_does_not_answer_the_batch_early() {
        let mut book = AckBook::new();
        book.track(Some(id()), 1, 2);
        assert_eq!(book.committed(1), None);
        // The same frame reported again: one frame stored, the other still waiting.
        assert_eq!(book.committed(1), None);
        assert_eq!(book.committed(2), Some(Ack::Committed(id())));
    }

    #[test]
    fn acks_that_arrive_out_of_order_answer_once_every_distinct_frame_is_in() {
        let mut book = AckBook::new();
        book.track(Some(id()), 1, 2);
        assert_eq!(book.committed(2), None);
        assert_eq!(book.committed(1), Some(Ack::Committed(id())));
    }

    #[test]
    fn a_refusal_after_a_commit_for_the_same_frame_is_not_a_second_answer() {
        let mut book = AckBook::new();
        book.track(Some(id()), 1, 2);
        assert_eq!(book.committed(1), None);
        assert_eq!(book.refused(1, "late"), None);
        assert_eq!(book.committed(2), Some(Ack::Committed(id())));
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
