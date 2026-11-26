// SPDX-License-Identifier: Apache-2.0
//! Test-only helpers shared by the record tests.

/// A temp home's suffix: a per-process counter, because two parallel tests can read the same
/// clock value and then share (and corrupt) one database file.
pub(crate) fn next_home() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
