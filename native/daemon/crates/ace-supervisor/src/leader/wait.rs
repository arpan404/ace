// SPDX-License-Identifier: Apache-2.0
//! Waiting for the leader's exit without giving up its pid: POSIX reads the
//! status with `waitid(WNOWAIT)` and leaves the zombie; Windows waits on the
//! process handle and keeps it.

use super::Leader;
use crate::spawn::RawExit;

impl Leader {
    /// Blocks until the leader exits and returns how it ended, leaving it
    /// unreaped. Each errno is handled: EINTR waits again; ECHILD means
    /// something else already reaped it (no pin, nothing to reap), so it is
    /// released at once; any other error falls back to a reaping wait,
    /// releasing it first so no group signal runs on an unpinned id.
    #[cfg(unix)]
    pub(crate) fn wait_exit(&self) -> RawExit {
        use rustix::io::Errno;
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let target = i32::try_from(self.pid).ok().and_then(Pid::from_raw);
        loop {
            let waited = match target {
                Some(target) => waitid(
                    WaitId::Pid(target),
                    WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
                ),
                None => Err(Errno::INVAL),
            };
            match waited {
                Ok(Some(status)) => {
                    self.mark_exited();
                    return RawExit {
                        code: status.exit_status(),
                        signal: status.terminating_signal().map(signal_name),
                    };
                }
                // Without WNOHANG the kernel returns only with a status.
                Ok(None) | Err(Errno::INTR) => continue,
                // Already reaped by something else: no pin and nothing to
                // reap, so the group number is never signalled again.
                Err(Errno::CHILD) => {
                    self.unpin();
                    if let Ok(mut state) = self.state.lock() {
                        state.child = None;
                    }
                    return RawExit {
                        code: None,
                        signal: None,
                    };
                }
                // Anything else: the pid is still this process's unreaped
                // child; watch its state without reaping it, so it stays
                // held and is released like any other leader.
                Err(_) => return self.poll_exit(),
            }
        }
    }

    /// Waits for the leader to become a zombie by reading its state, never
    /// reaping it: it stays held and its group is released by the same
    /// confirmed-empty rule. Its exit is then read without reaping: from
    /// `waitid(WNOWAIT | WNOHANG)`, else (Linux) the zombie's `/proc` wait
    /// status; only if neither answers is it unknown. A pid that vanished
    /// was reaped by something else: unpinned, like ECHILD.
    #[cfg(unix)]
    fn poll_exit(&self) -> RawExit {
        loop {
            match crate::system::process_zombie(self.pid) {
                Some(true) => {
                    self.mark_exited();
                    return self.read_exit();
                }
                Some(false) => std::thread::sleep(std::time::Duration::from_millis(50)),
                None => {
                    self.unpin();
                    if let Ok(mut state) = self.state.lock() {
                        state.child = None;
                    }
                    return RawExit {
                        code: None,
                        signal: None,
                    };
                }
            }
        }
    }

    /// The exited leader's status, read without reaping it.
    #[cfg(unix)]
    fn read_exit(&self) -> RawExit {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        if let Some(target) = i32::try_from(self.pid).ok().and_then(Pid::from_raw)
            && let Ok(Some(status)) = waitid(
                WaitId::Pid(target),
                WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG,
            )
        {
            return RawExit {
                code: status.exit_status(),
                signal: status.terminating_signal().map(signal_name),
            };
        }
        #[cfg(target_os = "linux")]
        if let Some(status) = crate::system::zombie_wait_status(self.pid) {
            let signal = status & 0x7f;
            return if signal == 0 {
                RawExit {
                    code: Some((status >> 8) & 0xff),
                    signal: None,
                }
            } else {
                RawExit {
                    code: None,
                    signal: Some(signal_name(signal)),
                }
            };
        }
        RawExit {
            code: None,
            signal: None,
        }
    }

    /// Blocks until the leader exits and returns its exit code, keeping
    /// its handle (and so its pid) until the shell disposes it.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    pub(crate) fn wait_exit(&self) -> RawExit {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::System::Threading::{INFINITE, WaitForSingleObject};
        let raw = match self.state.lock() {
            Ok(state) => state
                .child
                .as_ref()
                .map(|child| child.as_raw_handle() as usize),
            Err(_) => None,
        };
        if let Some(raw) = raw {
            // SAFETY: the handle belongs to the `Child` in `state`, which is
            // only dropped by `release`, and `release` does nothing until
            // `mark_exited` below has run, after this wait returns.
            unsafe {
                WaitForSingleObject(raw as windows_sys::Win32::Foundation::HANDLE, INFINITE);
            }
        }
        let code = self.state.lock().ok().and_then(|mut state| {
            state
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok().flatten())
                .and_then(|status| status.code())
        });
        self.mark_exited();
        self.step();
        RawExit { code, signal: None }
    }

    /// The pid can no longer be proven pinned: every later group signal is
    /// refused. A child that was already reaped elsewhere is dropped; one
    /// whose reap failed stays held.
    #[cfg(unix)]
    fn unpin(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.exited = true;
            state.released = true;
        }
    }
}

/// The name node gives a terminating signal.
#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => "SIGUNKNOWN",
    }
    .to_owned()
}
