// SPDX-License-Identifier: Apache-2.0
//! `watchDeviceLease` (`packages/devices/src/lease-expiry.ts`): a held pointer
//! must be released even when no further command reads the expired lease.
//!
//! Sans-IO: the watcher asks for a timer and the service calls it back when the
//! timer fires, so the clock stays the caller's.

use super::ControllerLease;

/// The longest a watch waits before reading the lease again (`lease-expiry.ts:27`).
pub const MAX_WAIT_MS: f64 = 5_000.0;

/// What the watch asks for at one step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WatchStep {
    /// Arm the timer this many milliseconds from now.
    Arm(f64),
    /// The lease is gone: release the held pointer.
    Expired,
    /// A new control took over: the held pointer is no longer that control's.
    Renewed,
}

/// One device's lease watch.
#[derive(Debug, Default)]
pub struct LeaseWatch {
    active: bool,
    deadline: Option<f64>,
}

impl LeaseWatch {
    /// `watchDeviceLease(lease, runtime, expired, renewed)`: the effects it
    /// produces at once, or an inactive watch when nobody holds the device.
    pub fn start(lease: &mut ControllerLease, now: f64) -> (Self, Vec<WatchStep>) {
        let initial = lease.status(now);
        let mut watch = Self {
            active: initial.expires_at.is_some(),
            deadline: initial.expires_at,
        };
        if !watch.active {
            return (watch, Vec::new());
        }
        let steps = watch.check(lease, now);
        (watch, steps)
    }

    /// The timer fired: read the lease again, then arm the next wait.
    pub fn due(&mut self, lease: &mut ControllerLease, now: f64) -> Vec<WatchStep> {
        self.check(lease, now)
    }

    /// `cancel()`: the watch stops asking; the caller cancels its timer.
    pub fn cancel(&mut self) {
        self.active = false;
    }

    pub fn active(&self) -> bool {
        self.active
    }

    /// `check`: an expired lease ends the watch, a moved deadline is a new
    /// control, and the next read is never further out than five seconds.
    fn check(&mut self, lease: &mut ControllerLease, now: f64) -> Vec<WatchStep> {
        if !self.active {
            return Vec::new();
        }
        let status = lease.status(now);
        let Some(expires_at) = status.expires_at else {
            self.active = false;
            return vec![WatchStep::Expired];
        };
        let mut steps = Vec::new();
        if self.deadline != Some(expires_at) {
            self.deadline = Some(expires_at);
            steps.push(WatchStep::Renewed);
        }
        steps.push(WatchStep::Arm(MAX_WAIT_MS.min((expires_at - now).max(0.0))));
        steps
    }
}

#[cfg(test)]
mod tests;
