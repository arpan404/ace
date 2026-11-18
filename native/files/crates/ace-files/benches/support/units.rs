// SPDX-License-Identifier: Apache-2.0

//! Turning durations and counts into the numbers a person reads.

use std::time::Duration;

/// A duration in milliseconds.
pub fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

/// A byte count in megabytes, as a display size.
pub fn megabytes(bytes: u64) -> f64 {
    bytes as f64 / 1_000_000.0
}

/// A count with thousands separated, so a million reads as a million.
pub fn thousands(count: usize) -> String {
    let digits = count.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (position, digit) in digits.chars().enumerate() {
        if position > 0 && (digits.len() - position).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// The `percent`-th sample of a run, in milliseconds.
pub fn percentile(samples: &[Duration], percent: usize) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let last = sorted.len().saturating_sub(1);
    millis(sorted[(sorted.len() * percent / 100).min(last)])
}
