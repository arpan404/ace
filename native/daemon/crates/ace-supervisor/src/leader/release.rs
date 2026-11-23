// SPDX-License-Identifier: Apache-2.0
//! Releasing a leader, the only way its hold ends: exited, unheld, and its
//! group confirmed empty by two consecutive empty scans while still held.
//! At the hold limit (the shell gave the group up long enough ago) a group
//! still occupied is killed by number, still held, and release waits for it
//! to empty. Then the reap, retried until it succeeds.

use super::{Leader, ReleaseStep};

impl Leader {
    /// One release step; `limit_reached` when the shell gave the group up
    /// at least the hold limit ago.
    pub(crate) fn step(&self, limit_reached: bool) -> ReleaseStep {
        let (released, disowned) = match self.state.lock() {
            Ok(state) if state.released => (true, state.disowned),
            Ok(state) if !state.exited || state.holds > 0 => return ReleaseStep::Held,
            Ok(state) => (false, state.disowned),
            Err(_) => return ReleaseStep::Held,
        };
        if !released {
            if cfg!(unix) {
                if !self.scanned_empty_twice() {
                    #[cfg(unix)]
                    if limit_reached {
                        // Still held: the number is still this group's.
                        let _ = self.signal_group(crate::signal::SignalName::Kill);
                    }
                    return ReleaseStep::Held;
                }
            } else if !disowned {
                // Windows: no group; the handle closes once the shell is done.
                return ReleaseStep::Held;
            }
            let _ = limit_reached;
            match self.state.lock() {
                Ok(mut state) if state.exited && state.holds == 0 => {
                    state.released = true;
                    state.confirmed_empty = true;
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
