// SPDX-License-Identifier: Apache-2.0
//! Releasing a leader: when it may go (exited, unheld, and its group empty
//! twice over, given up, or held to the bound), recording its members, the
//! reap (retried until it succeeds), and adopting members a scan missed.

use super::{Leader, ReleaseStep};

impl Leader {
    /// One release step: scan (POSIX), release when allowed, reap.
    pub(crate) fn step(&self) -> ReleaseStep {
        self.step_with(false)
    }

    /// The hold reached its bound: release now, members recorded first.
    pub(crate) fn step_bounded(&self) -> ReleaseStep {
        self.step_with(true)
    }

    fn step_with(&self, bounded: bool) -> ReleaseStep {
        let (released, disowned) = match self.state.lock() {
            Ok(state) if state.released => (true, state.disowned),
            Ok(state) if !state.exited || state.holds > 0 => return ReleaseStep::Held,
            Ok(state) => (false, state.disowned),
            Err(_) => return ReleaseStep::Held,
        };
        if !released {
            let empty = self.scanned_empty_twice();
            if !(disowned || bounded || empty) {
                return ReleaseStep::Held;
            }
            if cfg!(unix) {
                self.record();
            }
            match self.state.lock() {
                Ok(mut state) if state.exited && state.holds == 0 => state.released = true,
                _ => return ReleaseStep::Held,
            }
        }
        if !self.reap() {
            return ReleaseStep::Reaping;
        }
        #[cfg(unix)]
        self.adopt_missed();
        ReleaseStep::Done
    }

    /// POSIX: one scan of the group, kept for polls; true when it and the
    /// scan before both read every member and found the same, empty, set.
    /// Windows trees have no group and are released only by `dispose`.
    fn scanned_empty_twice(&self) -> bool {
        if cfg!(not(unix)) {
            return false;
        }
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

    /// POSIX, just after the reap: while the kernel still reports the group
    /// occupied, its id cannot have been reused, so any live member a scan
    /// missed (one forked just before its parent exited) is ace's: record it.
    #[cfg(unix)]
    fn adopt_missed(&self) {
        for _ in 0..8 {
            if !matches!(crate::reaper::process_group_alive(self.pid), Ok(true)) {
                return;
            }
            let found = crate::system::group_live_members(self.pid, 0).unwrap_or_default();
            if found.is_empty() {
                // Only zombies (or nothing readable) left in it.
                return;
            }
            if let Ok(mut state) = self.state.lock() {
                let before = state.known.len();
                state.known.extend(found);
                if state.known.len() == before {
                    return;
                }
            }
        }
    }
}
