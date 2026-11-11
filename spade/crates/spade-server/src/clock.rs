//! What the engine cannot control, passed in so tests can substitute it.

use std::sync::atomic::{AtomicU64, Ordering};

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
}

pub trait Ids: Send + Sync {
    /// A new unique id with `prefix`, for example `c_…` or `r_…`.
    fn next(&self, prefix: &str) -> String;
}

/// The machine's clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

/// Time-ordered random ids (UUID v7).
pub struct SystemIds;

impl Ids for SystemIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}_{}", uuid::Uuid::now_v7().simple())
    }
}

/// Sequential ids, for tests that compare them.
#[derive(Default)]
pub struct CountingIds(AtomicU64);

impl Ids for CountingIds {
    fn next(&self, prefix: &str) -> String {
        format!("{prefix}_{}", self.0.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

/// The local clock's offset from UTC in seconds, read once at startup.
pub fn local_offset_seconds() -> i32 {
    chrono::Local::now().offset().local_minus_utc()
}
