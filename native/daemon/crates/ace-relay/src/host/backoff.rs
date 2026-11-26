// SPDX-License-Identifier: Apache-2.0
//! The interval between registrations (`host.ts:421`): jittered around the current value,
//! doubling up to the maximum and reset by a registration.

/// The retry interval between registrations (`host.ts:421`): jittered around the current value,
/// doubling up to the maximum, reset by a registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    current: i64,
    initial: i64,
    max: i64,
}

impl Backoff {
    pub fn new(initial: i64, max: i64) -> Self {
        Self {
            current: initial,
            initial,
            max,
        }
    }

    /// The wait before the next attempt: `round(current * (0.5 + random * 0.5))`, then the current
    /// value doubles up to `max`.
    pub fn next(&mut self, random: f64) -> i64 {
        let wait = (self.current as f64 * (0.5 + random.clamp(0.0, 1.0) * 0.5)).round() as i64;
        self.current = (self.current * 2).min(self.max);
        wait
    }

    pub fn reset(&mut self) {
        self.current = self.initial;
    }

    pub fn current(&self) -> i64 {
        self.current
    }
}
