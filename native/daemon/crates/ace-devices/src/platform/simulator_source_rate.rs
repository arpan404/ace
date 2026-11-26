// SPDX-License-Identifier: Apache-2.0
//! `simulator-source-rate.ts`: serve-sim's H.264 rate as it actually arrives. serve-sim picks
//! its own rate from the screen's size (6 to 30 Mbit/s by its documentation) and spends it only
//! while the screen changes, so the rate that matters for a viewer's link is the busiest recent
//! second, not the average. Pure: the clock is passed in.

use std::collections::VecDeque;

/// The window the peak covers when the caller names none, in milliseconds.
pub const DEFAULT_WINDOW_MS: i64 = 10_000;

/// The bytes that arrived in one whole second of the clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Second {
    start: i64,
    bytes: u64,
}

/// The busiest second in the window, as access units arrive.
#[derive(Debug, Clone)]
pub struct SimulatorSourceRate {
    seconds: VecDeque<Second>,
    window_ms: i64,
}

impl SimulatorSourceRate {
    pub fn new(window_ms: i64) -> Self {
        Self {
            seconds: VecDeque::new(),
            window_ms,
        }
    }

    /// One access unit arrived. True when it opened a new second: time to look at the rate
    /// again.
    pub fn record(&mut self, now_ms: i64, bytes: u64) -> bool {
        let start = now_ms.div_euclid(1000) * 1000;
        if let Some(current) = self.seconds.back_mut()
            && current.start == start
        {
            current.bytes += bytes;
            return false;
        }
        // Whether a second was already recorded, as the TypeScript answers `current !== undefined`.
        let opened = !self.seconds.is_empty();
        self.seconds.push_back(Second { start, bytes });
        while self
            .seconds
            .front()
            .is_some_and(|second| second.start <= start - self.window_ms)
        {
            self.seconds.pop_front();
        }
        opened
    }

    /// The busiest second in the window, in bit/s; 0 before anything arrived.
    pub fn peak(&self, now_ms: i64) -> u64 {
        self.seconds
            .iter()
            .filter(|second| second.start > now_ms - self.window_ms)
            .map(|second| second.bytes * 8)
            .max()
            .unwrap_or(0)
    }
}

impl Default for SimulatorSourceRate {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_accumulates_its_bytes_and_the_next_one_opens_the_rate_again() {
        let mut rate = SimulatorSourceRate::default();
        assert!(!rate.record(1_000, 1_000));
        assert!(!rate.record(1_999, 2_000));
        assert_eq!(rate.peak(1_999), 24_000);
        assert!(rate.record(2_000, 500));
        assert_eq!(rate.peak(2_000), 24_000);
    }

    #[test]
    fn the_peak_covers_only_the_busiest_second_inside_the_window() {
        let mut rate = SimulatorSourceRate::new(3_000);
        assert_eq!(rate.peak(0), 0);
        rate.record(1_000, 10);
        rate.record(2_000, 30);
        rate.record(4_000, 20);
        assert_eq!(rate.peak(4_000), 240);
        // The 2,000 second has left the 3,000 ms window; the 4,000 second remains.
        assert_eq!(rate.peak(5_000), 160);
    }
}
