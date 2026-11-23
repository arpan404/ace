// SPDX-License-Identifier: Apache-2.0
//! A spawned leader, held so its pid cannot be reused while anything may
//! still signal it. POSIX: the exit is observed without reaping
//! (`waitid(WNOWAIT)`), so the zombie keeps the pid and the process group id
//! reserved until the shell's exit listeners have ended the group; only then
//! is it reaped. Only the leader is waited for: adopted descendants in its
//! group are the reaper's (`reaper.rs`), never this wait's. Windows: the
//! process handle pins the pid until it is closed the same way.

use crate::signal::SignalName;
use crate::spawn::RawExit;
use std::sync::Mutex;

/// The leader of one supervised tree.
pub struct Leader {
    pid: u32,
    state: Mutex<LeaderState>,
}

struct LeaderState {
    /// The child until it is reaped (POSIX) or its handle closed (Windows).
    child: Option<std::process::Child>,
    /// Set once the wait saw the exit; only then may the child be reaped.
    exited: bool,
}

impl Leader {
    pub(crate) fn new(child: std::process::Child) -> Self {
        Self {
            pid: child.id(),
            state: Mutex::new(LeaderState {
                child: Some(child),
                exited: false,
            }),
        }
    }

    /// The leader's pid.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Signals the leader itself while its pid is still its own (alive, or
    /// exited but not yet reaped). False once reaped: a later process may
    /// hold the pid, and nothing is sent.
    pub fn kill(&self, signal: SignalName) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let Some(child) = state.child.as_mut() else {
            return false;
        };
        #[cfg(unix)]
        {
            let _ = child;
            let Some(target) = i32::try_from(self.pid)
                .ok()
                .and_then(rustix::process::Pid::from_raw)
            else {
                return false;
            };
            let sig = match signal {
                SignalName::Term => rustix::process::Signal::TERM,
                SignalName::Kill => rustix::process::Signal::KILL,
            };
            rustix::process::kill_process(target, sig).is_ok()
        }
        #[cfg(not(unix))]
        {
            // Windows has no signals: any stop terminates, as node's kill does.
            let _ = signal;
            child.kill().is_ok()
        }
    }

    /// Reaps the leader once its exit was seen; before that, nothing.
    pub(crate) fn reap(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !state.exited {
            return;
        }
        if let Some(mut child) = state.child.take() {
            // POSIX: collects the zombie. Windows: reads the stored code;
            // the drop closes the handle.
            let _ = child.try_wait();
        }
    }

    /// Blocks until the leader exits and returns how it ended, leaving it
    /// unreaped.
    #[cfg(unix)]
    pub(crate) fn wait_exit(&self) -> RawExit {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let exit = match i32::try_from(self.pid).ok().and_then(Pid::from_raw) {
            Some(target) => loop {
                match waitid(
                    WaitId::Pid(target),
                    WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
                ) {
                    Ok(Some(status)) => {
                        break RawExit {
                            code: status.exit_status(),
                            signal: status.terminating_signal().map(signal_name),
                        };
                    }
                    Err(rustix::io::Errno::INTR) | Ok(None) => continue,
                    // Nothing left to wait for: the exit is unknown.
                    Err(_) => {
                        break RawExit {
                            code: None,
                            signal: None,
                        };
                    }
                }
            },
            None => RawExit {
                code: None,
                signal: None,
            },
        };
        self.mark_exited();
        exit
    }

    /// Blocks until the leader exits and returns its exit code, keeping
    /// its handle (and so its pid) until `reap`.
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
            // only dropped by `reap`, and `reap` does nothing until
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
        RawExit { code, signal: None }
    }

    fn mark_exited(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.exited = true;
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
