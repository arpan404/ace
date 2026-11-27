// SPDX-License-Identifier: Apache-2.0
//! Credit-based flow control for a relayed stream (`packages/secure-channel/src/flow-credit.ts`,
//! ADR 0110): each end sends at most a window of cost its peer has not consumed, so a relay that
//! cannot pause a socket never holds a fast sender's whole backlog for a slow reader.
//!
//! Wire: a credit is one encrypted fragment whose plaintext is the flag and a 4-byte big-endian
//! count of cost units consumed since the last credit. A side's first credit also says "my data
//! from here on is flow controlled", so the peer counts only what follows it.

/// A credit fragment's plaintext starts with this flag.
pub const CREDIT_FLAG: u8 = 7;
/// Unconsumed cost units a side may have in flight towards its peer.
pub const FLOW_WINDOW: usize = 1024 * 1024;
/// A fragment costs its plaintext length, at least this, so a window also bounds the fragment
/// count a reader queues.
const MIN_COST: usize = 4096;
/// Credit is returned once this much is consumed, so a reader that keeps up never stalls.
const CREDIT_STEP: usize = FLOW_WINDOW / 4;

/// What one fragment costs its reader's window.
pub fn fragment_cost(plain_len: usize) -> usize {
    plain_len.max(MIN_COST)
}

/// A credit fragment's plaintext.
pub fn credit_fragment(amount: usize) -> Vec<u8> {
    let mut plain = vec![CREDIT_FLAG, 0, 0, 0, 0];
    plain[1..].copy_from_slice(&(amount as u32).to_be_bytes());
    plain
}

/// The amount a credit fragment returns; malformed ones are refused.
pub fn read_credit(plain: &[u8]) -> Result<usize, &'static str> {
    if plain.len() != 5 || plain[0] != CREDIT_FLAG {
        return Err("Invalid credit fragment");
    }
    let amount = u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]) as usize;
    if amount > FLOW_WINDOW {
        return Err("Invalid credit fragment");
    }
    Ok(amount)
}

/// One side's credit accounting, both directions of the same stream.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlowCredit {
    limited: bool,
    window: usize,
    counting: bool,
    /// Data fragments queued for the reader, and how many of those predate the peer's start.
    queued: usize,
    uncounted: usize,
    /// Counted cost received and not yet credited back (queued, or consumed and owed).
    unacked: usize,
    owed: usize,
}

impl FlowCredit {
    /// Whether this side's sends are limited (it sent its start).
    pub fn limited(&self) -> bool {
        self.limited
    }

    /// Whether the peer's data is counted (its start arrived): its window bounds what it sends.
    pub fn counting(&self) -> bool {
        self.counting
    }

    /// Limit this side's sends from now on. The start fragment to send, the first time only.
    pub fn start(&mut self) -> Option<Vec<u8>> {
        if self.limited {
            return None;
        }
        self.limited = true;
        self.window = FLOW_WINDOW;
        Some(credit_fragment(0))
    }

    /// The peer returned `amount`. Its first credit starts counting what follows and turns this
    /// side's limit on too; the start fragment to send back, if this side had not started.
    pub fn credited(&mut self, amount: usize) -> Option<Vec<u8>> {
        if !self.counting {
            self.counting = true;
            self.uncounted = self.queued;
        }
        let reply = self.start();
        self.window += amount;
        reply
    }

    /// Whether a fragment of `cost` may be written now.
    pub fn allows(&self, cost: usize) -> bool {
        !self.limited || self.window >= cost
    }

    pub fn spend(&mut self, cost: usize) {
        if self.limited {
            self.window = self.window.saturating_sub(cost);
        }
    }

    /// A data fragment arrived. False when the peer overran the window it was given.
    pub fn received(&mut self, cost: usize) -> bool {
        self.queued += 1;
        if !self.counting {
            return true;
        }
        self.unacked = self.unacked.saturating_add(cost);
        self.unacked <= FLOW_WINDOW
    }

    /// The reader took a data fragment. A credit fragment to send, once enough is owed.
    pub fn consumed(&mut self, cost: usize) -> Option<Vec<u8>> {
        self.queued = self.queued.saturating_sub(1);
        if self.uncounted > 0 {
            self.uncounted -= 1;
            return None;
        }
        if !self.counting {
            return None;
        }
        self.owed = self.owed.saturating_add(cost);
        if self.owed < CREDIT_STEP {
            return None;
        }
        let credit = credit_fragment(self.owed);
        self.unacked = self.unacked.saturating_sub(self.owed);
        self.owed = 0;
        Some(credit)
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/secure-channel/src/flow-credit.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{FLOW_WINDOW, FlowCredit, credit_fragment, fragment_cost, read_credit};

    const FULL: usize = 65519;

    /// Two ends wired back to back: what one returns is what the other is credited.
    fn ends() -> (FlowCredit, FlowCredit) {
        let mut sender = FlowCredit::default();
        let mut receiver = FlowCredit::default();
        let start = sender.start().expect("a start credit");
        let reply = receiver.credited(read_credit(&start).unwrap());
        if let Some(reply) = reply {
            sender.credited(read_credit(&reply).unwrap());
        }
        (sender, receiver)
    }

    #[test]
    fn a_sender_stops_at_one_window_until_the_reader_consumes_and_credits_it_back() {
        let (mut sender, mut receiver) = ends();
        let mut sent = 0;
        while sender.allows(fragment_cost(FULL)) {
            sender.spend(fragment_cost(FULL));
            assert!(receiver.received(fragment_cost(FULL)));
            sent += 1;
        }
        assert!(sent * FULL <= FLOW_WINDOW);
        for _ in 0..sent {
            if let Some(credit) = receiver.consumed(fragment_cost(FULL)) {
                sender.credited(read_credit(&credit).unwrap());
            }
        }
        assert!(sender.allows(fragment_cost(FULL)));
    }

    #[test]
    fn a_peer_that_sends_past_its_window_is_caught() {
        let (_, mut receiver) = ends();
        let mut within = true;
        let mut total = 0;
        while within && total <= FLOW_WINDOW {
            within = receiver.received(fragment_cost(FULL));
            total += FULL;
        }
        assert!(!within);
    }

    #[test]
    fn tiny_fragments_cost_a_reader_per_frame_so_one_window_queues_at_most_256() {
        let (_, mut receiver) = ends();
        let mut queued = 0;
        while receiver.received(fragment_cost(10)) {
            queued += 1;
        }
        assert_eq!(queued, 256);
    }

    #[test]
    fn data_that_arrived_before_the_peers_start_is_never_credited() {
        let mut receiver = FlowCredit::default();
        receiver.received(fragment_cost(FULL));
        receiver.credited(0);
        for _ in 0..5 {
            receiver.received(fragment_cost(FULL));
        }
        // The uncounted fragment and four counted ones stay under the quarter-window step.
        for _ in 0..5 {
            assert!(receiver.consumed(fragment_cost(FULL)).is_none());
        }
        let credit = receiver.consumed(fragment_cost(FULL)).expect("a credit");
        assert_eq!(read_credit(&credit).unwrap(), 5 * FULL);
    }

    #[test]
    fn malformed_credit_fragments_are_refused() {
        assert_eq!(read_credit(&credit_fragment(4096)).unwrap(), 4096);
        for bad in [
            vec![7, 0, 0, 0],
            vec![6, 0, 0, 0, 1],
            credit_fragment(FLOW_WINDOW + 1),
        ] {
            assert!(read_credit(&bad).is_err(), "{bad:?}");
        }
    }
}
