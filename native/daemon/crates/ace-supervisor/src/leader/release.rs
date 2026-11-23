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
                    // A /proc that hides processes can never prove a group
                    // empty: the leader is still reaped, as before, but the
                    // result is not reported as "empty" (a journal row is
                    // never deleted on a scan that could miss members).
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

    /// Whether the leader's pid is still pinned: its handle (POSIX: the
    /// unreaped child; Windows: the process handle) is still held. Once it
    /// is released, only a fresh snapshot can say anything about the group.
    pub fn pin_held(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.child.is_some())
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
