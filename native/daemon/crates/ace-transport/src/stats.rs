// SPDX-License-Identifier: Apache-2.0
//! What a listener handled since it bound (T1b.1b): the counters the binding
//! reads for the evidence file, per listener and per port. Counting observes;
//! it decides nothing, and every counter is a relaxed atomic, so a read races
//! the work it describes without consequence.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// One listener's counters, shared by its accept loop, its exchanges, its TLS
/// handshakes and its upgrade handler.
#[derive(Debug, Default)]
pub struct Stats {
    connections: AtomicU64,
    exchanges: AtomicU64,
    upgrades: AtomicU64,
    trusted_handshakes: AtomicU64,
    post_quantum_handshakes: AtomicU64,
    deflated_out: AtomicU64,
    inflated_in: AtomicU64,
}

/// A [`Stats`] snapshot, as the binding reports it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub connections: u64,
    pub exchanges: u64,
    pub upgrades: u64,
    pub trusted_handshakes: u64,
    pub post_quantum_handshakes: u64,
    pub deflated_out: u64,
    pub inflated_in: u64,
}

impl Stats {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A TCP connection the listener accepted and serves.
    pub fn connection(&self) {
        let _ = self.connections.fetch_add(1, Ordering::Relaxed);
    }

    /// One HTTP request the listener's exchanges answered.
    pub fn exchange(&self) {
        let _ = self.exchanges.fetch_add(1, Ordering::Relaxed);
    }

    /// One upgrade whose `101` flushed, so a socket exists behind it.
    pub fn upgrade(&self) {
        let _ = self.upgrades.fetch_add(1, Ordering::Relaxed);
    }

    /// A handshake served the trusted certificate rather than the pinned one.
    pub fn trusted_handshake(&self) {
        let _ = self.trusted_handshakes.fetch_add(1, Ordering::Relaxed);
    }

    /// A handshake negotiated `X25519MLKEM768`.
    pub fn post_quantum_handshake(&self) {
        let _ = self.post_quantum_handshakes.fetch_add(1, Ordering::Relaxed);
    }

    /// One outbound message that was compressed.
    pub fn deflated_out(&self) {
        let _ = self.deflated_out.fetch_add(1, Ordering::Relaxed);
    }

    /// One inbound message that was inflated.
    pub fn inflated_in(&self) {
        let _ = self.inflated_in.fetch_add(1, Ordering::Relaxed);
    }

    pub fn counts(&self) -> Counts {
        Counts {
            connections: self.connections.load(Ordering::Relaxed),
            exchanges: self.exchanges.load(Ordering::Relaxed),
            upgrades: self.upgrades.load(Ordering::Relaxed),
            trusted_handshakes: self.trusted_handshakes.load(Ordering::Relaxed),
            post_quantum_handshakes: self.post_quantum_handshakes.load(Ordering::Relaxed),
            deflated_out: self.deflated_out.load(Ordering::Relaxed),
            inflated_in: self.inflated_in.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Stats;

    #[test]
    fn each_counter_reports_only_what_it_was_told() {
        let stats = Stats::new();
        stats.connection();
        stats.connection();
        stats.exchange();
        stats.upgrade();
        stats.trusted_handshake();
        stats.post_quantum_handshake();
        stats.deflated_out();
        stats.inflated_in();

        let counts = stats.counts();
        assert_eq!(counts.connections, 2);
        assert_eq!(counts.exchanges, 1);
        assert_eq!(counts.upgrades, 1);
        assert_eq!(counts.trusted_handshakes, 1);
        assert_eq!(counts.post_quantum_handshakes, 1);
        assert_eq!(counts.deflated_out, 1);
        assert_eq!(counts.inflated_in, 1);
    }
}
