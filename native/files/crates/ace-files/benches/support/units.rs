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

/// The `percent`-th sample of a run, in milliseconds, by nearest rank: the smallest sample that at
/// least `percent`% of the run is at or below.
///
/// Panics on an empty run, because a percentile of no samples is not a number, and on a percentage
/// outside 1..=100.
pub fn percentile(samples: &[Duration], percent: usize) -> f64 {
    assert!(
        !samples.is_empty(),
        "a percentile needs at least one sample"
    );
    assert!(
        (1..=100).contains(&percent),
        "a percentile is a percentage, not {percent}"
    );
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let rank = (sorted.len() * percent).div_ceil(100);
    millis(sorted[rank - 1])
}
