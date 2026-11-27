// SPDX-License-Identifier: Apache-2.0
//! The daemon's clock, with one test-only seam: when `ACE_TEST_CLOCK_FILE` is
//! set, `now` is `ACE_TEST_CLOCK_BASE_MS` plus the number the file holds, so a
//! program test can advance time (ticket expiry, rate windows) without waiting.
//! Unset, it is the system clock.

use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()`: milliseconds since the epoch.
pub fn now_ms() -> u64 {
    let Some(path) = crate::testing::var("ACE_TEST_CLOCK_FILE").map(std::path::PathBuf::from)
    else {
        return system_now();
    };
    let base = crate::testing::var("ACE_TEST_CLOCK_BASE_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let offset = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(0);
    base + offset
}

/// The system clock, for values that outlive a test's fake time.
pub fn system_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
