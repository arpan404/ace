// SPDX-License-Identifier: Apache-2.0

//! Where "now" comes from.
//!
//! The lister only needs the time to decide whether a folder changed too recently to trust, so the
//! clock is a parameter: the daemon passes the real one and tests pass a clock they control.

use std::time::SystemTime;

/// The source of "now" for a lister.
pub trait Clock: Send + Sync {
    /// The current time.
    fn now(&self) -> SystemTime;
}

/// The clock the daemon uses.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}
