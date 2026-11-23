// SPDX-License-Identifier: Apache-2.0
//! Releasing a leader, the only way its hold ends: exited, unheld, and its
//! group confirmed empty by two consecutive empty scans while still held.
//! Then the reap, retried until it succeeds. Nothing here signals: the hold
//! limit's kill is the release loop's escalation, through the shell's guard.

use super::{Leader, ReleaseStep};

impl Leader {
    /// One release step.
    pub(crate) fn step(&self) -> ReleaseStep {
        let (released, disowned) = match self.state.lock() {
            Ok(state) if state.released => (true, state.disowned),
            Ok(state) if !state.exited || state.holds > 0 => return ReleaseStep::Held,
            Ok(state) => (false, state.disowned),
            Err(_) => return ReleaseStep::Held,
        };
        if !released {
            if cfg!(unix) {
                if !self.scanned_empty_twice() {
                    return ReleaseStep::Held;
                }
            } else if !disowned {
                // Windows: no group; the handle closes once the shell is done.
                return ReleaseStep::Held;
            }
            match self.state.lock() {
                Ok(mut state) if state.exited && state.holds == 0 => {
                    state.released = true;
                    // hidepid hides only other users' processes; ace's own
                    // descendants stay visible because they keep the
                    // daemon's uid (unless they change uid), so this series
                    // still reaps as before. The scans skip a stat file that
                    // cannot be read when the `/proc/<pid>` directory itself
                    // belongs to another uid (hidepid=1 still allows that
                    // stat), so only an unreadable own-uid pid can make a
                    // scan incomplete. A member that did change uid could
                    // be missed, though, so the result is never reported as
                    // "empty" and no journal row is deleted from a scan that
                    // could be blind. Re-read per release, so a remount is
                    // seen.
                    state.confirmed_empty = !crate::system::proc_hides_pids();
                }
                _ => return ReleaseStep::Held,
            }
        }
        if self.reap() {
            ReleaseStep::Done
        } else {
            ReleaseStep::Reaping
        }
    }

    /// The pin and the latch read in one lock: `(pin_held, group_gone)`.
    /// The pin is what makes the latched "empty" meaningful, so a caller
    /// must never pair a result read under one lock with a pin read under
    /// another; the release worker may reap in between. Once the pin is
    /// gone, only a fresh snapshot can say anything about the group.
    pub fn pin_and_gone(&self) -> (bool, bool) {
        self.state.lock().map_or((false, false), |state| {
            (state.child.is_some(), state.confirmed_empty)
        })
    }

    /// POSIX: one scan of the group; true when it and the scan before both
    /// read every candidate and found the same, empty, set of live members.
    fn scanned_empty_twice(&self) -> bool {
        let scan = crate::system::group_live_members(self.pid, self.pid);
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let stable = matches!((&scan, &state.last_scan), (Some(now), Some(before)) if now.is_empty() && now == before);
        state.last_scan = scan;
        stable
    }

    /// Reaps (POSIX) or closes (Windows) the released leader; true once
    /// done. A reap that fails keeps the handle for the next try.
    fn reap(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(child) = state.child.as_mut() else {
            return true;
        };
        // POSIX: collects the zombie. Windows: reads the stored code.
        match child.try_wait() {
            Ok(Some(_)) => {
                // Windows: the drop closes the handle.
                state.child = None;
                true
            }
            Ok(None) | Err(_) => false,
        }
    }
}
