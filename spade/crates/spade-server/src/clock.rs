//! What the engine cannot control, passed in so tests can substitute it.

use std::sync::atomic::{AtomicU64, Ordering};

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;

    /// Milliseconds from an arbitrary fixed point that never runs backwards, for budgets and
    /// waits. Defaults to [`Clock::now_ms`], so a test clock that steps keeps working; the
    /// machine's own is read from a monotonic instant.
    fn monotonic_ms(&self) -> i64 {
        self.now_ms()
    }
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

    fn monotonic_ms(&self) -> i64 {
        static BASE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let base = BASE.get_or_init(std::time::Instant::now);
        i64::try_from(base.elapsed().as_millis()).unwrap_or(i64::MAX)
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
