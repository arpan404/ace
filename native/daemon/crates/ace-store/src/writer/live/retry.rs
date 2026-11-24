// SPDX-License-Identifier: Apache-2.0
//! The retry rules for a pinned live-write batch that failed to commit (task 5.4a). Ports
//! `apps/daemon/src/live-write-retry.ts`: every failed attempt waits twice as long as the one
//! before, from 100 ms to a 5 s cap, and a batch is quarantined after six attempts that were
//! neither contention nor a full disk. Pure: the buffer owns the timer, the stream owns the
//! decision.

/// The policy the TypeScript's `liveWriteRetry` states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retry {
    /// The first failure's delay.
    pub base_ms: u64,
    /// The longest delay, whatever the failure count.
    pub cap_ms: u64,
    /// Failures after this many quarantine the batch, in the stream's recovery.
    pub quarantine_after: u32,
}

/// `liveWriteRetry`: 100 ms doubling to a 5 s cap, six failures before quarantine.
pub const RETRY: Retry = Retry {
    base_ms: 100,
    cap_ms: 5_000,
    quarantine_after: 6,
};

/// Delay before the attempt that follows the `failures`-th consecutive failure (1-based).
/// Zero failures, which no caller records, is the first attempt's delay, as the TypeScript's
/// `Math.max(0, failures - 1)` is.
pub fn retry_delay(failures: u32) -> u64 {
    let step = failures.saturating_sub(1).min(16);
    RETRY.cap_ms.min(RETRY.base_ms.saturating_mul(1u64 << step))
}

#[cfg(test)]
mod tests {
    use super::{RETRY, retry_delay};

    #[test]
    fn delays_double_from_the_base_and_stop_at_the_cap() {
        for (failures, expected) in [
            (0, 100),
            (1, 100),
            (2, 200),
            (3, 400),
            (4, 800),
            (5, 1_600),
            (6, 3_200),
            (7, 5_000),
            (100, 5_000),
        ] {
            assert_eq!(retry_delay(failures), expected, "failures {failures}");
        }
        assert_eq!(RETRY.quarantine_after, 6);
    }
}
