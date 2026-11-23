// SPDX-License-Identifier: Apache-2.0
//! Bounded backoff for the process inventory's own writes, which run on timers
//! and exit paths where a throw would end the daemon. Ports
//! `inventory-retry.ts`: pure apart from the injected clock.

/// Delay before the next attempt after `failures` consecutive failures.
pub fn inventory_retry_ms(failures: u32, base_ms: u64, cap_ms: u64) -> u64 {
    let shift = failures.saturating_sub(1).min(16);
    base_ms.saturating_mul(1 << shift).min(cap_ms)
}

/// The inventory's own backoff: 1 s after the first failure, doubling to 30 s.
pub fn inventory_backoff_ms(failures: u32) -> u64 {
    inventory_retry_ms(failures, 1_000, 30_000)
}

/// A recorder tick's state: when the next attempt may run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardedTick {
    failures: u32,
    retry_at_ms: i64,
}

impl GuardedTick {
    /// A tick that has never failed runs at once.
    pub fn new() -> Self {
        Self {
            failures: 0,
            retry_at_ms: i64::MIN,
        }
    }

    /// Whether the tick may attempt now.
    pub fn ready(&self, now_ms: i64) -> bool {
        now_ms >= self.retry_at_ms
    }

    /// The step threw: back off and report.
    pub fn failed(&mut self, now_ms: i64) {
        self.failures = self.failures.saturating_add(1);
        self.retry_at_ms = now_ms.saturating_add(inventory_backoff_ms(self.failures) as i64);
    }

    /// The step ran: a success clears the backoff.
    pub fn settled(&mut self) {
        self.failures = 0;
        self.retry_at_ms = i64::MIN;
    }

    /// Queued failures in a row.
    pub fn failures(&self) -> u32 {
        self.failures
    }
}

impl Default for GuardedTick {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tick on a clock the test moves, around a step whose outcomes the test lists.
    struct Setup {
        outcomes: Vec<Result<bool, ()>>,
        tick: GuardedTick,
        now_ms: i64,
        calls: usize,
        reported: usize,
        stopped: bool,
    }

    impl Setup {
        fn new(outcomes: Vec<Result<bool, ()>>) -> Self {
            Self {
                outcomes,
                tick: GuardedTick::new(),
                now_ms: 0,
                calls: 0,
                reported: 0,
                stopped: false,
            }
        }

        fn at(&mut self, now_ms: i64) {
            self.now_ms = now_ms;
            if !self.tick.ready(now_ms) {
                return;
            }
            self.calls += 1;
            let outcome = if self.outcomes.is_empty() {
                Ok(true)
            } else {
                self.outcomes.remove(0)
            };
            match outcome {
                Err(()) => {
                    self.tick.failed(now_ms);
                    self.reported += 1;
                }
                Ok(more) => {
                    self.tick.settled();
                    if !more {
                        self.stopped = true;
                    }
                }
            }
        }
    }

    #[test]
    fn failing_tick_backs_off_and_records_again_once_it_can() {
        let mut state = Setup::new(vec![Err(()), Err(()), Ok(true)]);
        state.at(0);
        assert_eq!(state.calls, 1);
        assert_eq!(state.reported, 1);
        state.at(500);
        assert_eq!(state.calls, 1);
        state.at(1_000);
        assert_eq!(state.calls, 2);
        state.at(2_999);
        assert_eq!(state.calls, 2);
        state.at(3_000);
        assert_eq!(state.calls, 3);
        state.at(3_001);
        assert_eq!(state.calls, 4);
        assert!(!state.stopped);
    }

    #[test]
    fn backoff_stops_growing_at_thirty_seconds() {
        let mut state = Setup::new(vec![Err(()); 12]);
        let mut at = 0;
        for _ in 0..10 {
            state.at(at);
            at += 30_000;
        }
        assert_eq!(state.calls, 10);
    }

    #[test]
    fn recorder_with_nothing_left_stops() {
        let mut state = Setup::new(vec![Ok(false)]);
        state.at(0);
        assert!(state.stopped);
    }
}
