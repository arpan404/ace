// SPDX-License-Identifier: Apache-2.0
//! A spawned leader, held so its pid, and on POSIX its process group id,
//! cannot be reused while anything may still signal the group.
//!
//! POSIX: the exit is observed without reaping (`waitid(WNOWAIT)`), and the
//! zombie is reaped only once no live process is left in its group. Until
//! then the kernel cannot hand the group id to anyone else, so every group
//! signal sent through this handle reaches only the tree ace created; once
//! released, the handle refuses to signal at all. Only the leader is waited
//! for: adopted descendants are the reaper's (`reaper.rs`), never this
//! wait's. Windows: the process handle pins the pid until the shell
//! disposes the child after its exit.

#[cfg(unix)]
use crate::errors::SupervisorError;
use crate::signal::SignalName;
use crate::spawn::RawExit;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// The leader of one supervised tree.
pub struct Leader {
    pid: u32,
    state: Mutex<LeaderState>,
}

struct LeaderState {
    /// The child until it is released: reaped (POSIX) or closed (Windows).
    child: Option<std::process::Child>,
    /// Set once the wait saw the exit; only then may the child be released.
    exited: bool,
    /// Windows: the shell is done with the tree; release once it exited.
    disposed: bool,
}

/// What a group signal through the handle did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupSignal {
    Sent,
    /// The kernel says no process is left in the group.
    Gone,
    /// The leader was released with its group empty: nothing is sent, since
    /// the group id may belong to someone else now.
    Released,
}

/// The leaders of this process's unreleased supervised groups, by pid (the
/// group id on POSIX). One per process, like the kernel's pid space it
/// mirrors; entries leave on release.
fn registry() -> &'static Mutex<HashMap<u32, Weak<Leader>>> {
    static LEADERS: OnceLock<Mutex<HashMap<u32, Weak<Leader>>>> = OnceLock::new();
    LEADERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The unreleased leader of group `group`, if ace's supervisor spawned it.
pub fn group_leader(group: u32) -> Option<Arc<Leader>> {
    registry().lock().ok()?.get(&group).and_then(Weak::upgrade)
}

impl Leader {
    pub(crate) fn new(child: std::process::Child) -> Arc<Self> {
        let leader = Arc::new(Self {
            pid: child.id(),
            state: Mutex::new(LeaderState {
                child: Some(child),
                exited: false,
                disposed: false,
            }),
        });
        if let Ok(mut leaders) = registry().lock() {
            leaders.insert(leader.pid, Arc::downgrade(&leader));
        }
        leader
    }

    /// The leader's pid.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Signals the leader itself while its pid is still its own (alive, or
    /// exited but unreaped). False once released: nothing is sent.
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
            rustix::process::kill_process(target, posix_signal(signal)).is_ok()
        }
        #[cfg(not(unix))]
        {
            // Windows has no signals: any stop terminates, as node's kill does.
            let _ = signal;
            child.kill().is_ok()
        }
    }

    /// Signals the whole group while the unreaped leader keeps its id
    /// ace's. The lock is held across the signal, so release cannot slip in
    /// between the check and the send.
    #[cfg(unix)]
    pub fn signal_group(&self, signal: SignalName) -> Result<GroupSignal, SupervisorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| SupervisorError::Operation("supervisor leader lock failed".to_owned()))?;
        if state.child.is_none() {
            return Ok(GroupSignal::Released);
        }
        let Some(target) = i32::try_from(self.pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return Err(SupervisorError::InvalidInput(format!(
                "bad group {}",
                self.pid
            )));
        };
        match rustix::process::kill_process_group(target, posix_signal(signal)) {
            Ok(()) => Ok(GroupSignal::Sent),
            Err(rustix::io::Errno::SRCH) => Ok(GroupSignal::Gone),
            // Darwin refuses a group holding only zombies; nothing runs there.
            #[cfg(target_os = "macos")]
            Err(rustix::io::Errno::PERM) => Ok(GroupSignal::Gone),
            Err(error) => Err(SupervisorError::Operation(format!(
                "signal of group {} failed: {error}",
                self.pid
            ))),
        }
    }

    /// Whether nothing of the group runs: released, or exited with no live
    /// member left. The zombie leader itself does not count.
    pub fn group_gone(&self) -> bool {
        let exited = match self.state.lock() {
            Ok(state) => {
                if state.child.is_none() {
                    return true;
                }
                state.exited
            }
            Err(_) => return false,
        };
        exited && !crate::system::group_has_live_members(self.pid, self.pid)
    }

    /// POSIX: releases the leader once it exited and its group holds no
    /// live process; true when released. Windows trees have no group.
    #[cfg(unix)]
    pub(crate) fn release_if_group_empty(&self) -> bool {
        match self.state.lock() {
            Ok(state) if state.child.is_none() => return true,
            Ok(state) if !state.exited => return false,
            Ok(_) => {}
            Err(_) => return false,
        }
        if crate::system::group_has_live_members(self.pid, self.pid) {
            return false;
        }
        self.release();
        true
    }

    /// Windows: the shell is done with the tree; the handle closes once the
    /// leader has exited (now, or when the wait sees it).
    pub fn dispose(&self) {
        let exited = match self.state.lock() {
            Ok(mut state) => {
                state.disposed = true;
                state.exited
            }
            Err(_) => false,
        };
        if cfg!(windows) && exited {
            self.release();
        }
    }

    /// Reaps (POSIX) or closes (Windows) the exited leader; never before
    /// the wait saw its exit.
    fn release(&self) {
        let child = match self.state.lock() {
            Ok(mut state) if state.exited => state.child.take(),
            _ => None,
        };
        if let Some(mut child) = child {
            // POSIX: collects the zombie. Windows: the drop closes the handle.
            let _ = child.try_wait();
            self.forget();
        }
    }

    fn forget(&self) {
        if let Ok(mut leaders) = registry().lock()
            && leaders
                .get(&self.pid)
                .is_some_and(|known| std::ptr::eq(known.as_ptr(), self))
        {
            leaders.remove(&self.pid);
        }
    }

    /// Blocks until the leader exits and returns how it ended, leaving it
    /// unreaped. If the kernel cannot be asked (the pid is not, or no
    /// longer, this process's child), nothing proves the pid is pinned, so
    /// the leader is released at once and the exit is unknown.
    #[cfg(unix)]
    pub(crate) fn wait_exit(&self) -> RawExit {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let unknown = RawExit {
            code: None,
            signal: None,
        };
        let Some(target) = i32::try_from(self.pid).ok().and_then(Pid::from_raw) else {
            self.unpin();
            return unknown;
        };
        loop {
            match waitid(
                WaitId::Pid(target),
                WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
            ) {
                Ok(Some(status)) => {
                    self.mark_exited();
                    return RawExit {
                        code: status.exit_status(),
                        signal: status.terminating_signal().map(signal_name),
                    };
                }
                // Without WNOHANG the kernel only returns once it has a
                // status; a spurious empty return or an interrupt waits again.
                Ok(None) | Err(rustix::io::Errno::INTR) => continue,
                Err(_) => {
                    self.unpin();
                    return unknown;
                }
            }
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
        let disposed = self.mark_exited();
        if disposed {
            self.release();
        }
        RawExit { code, signal: None }
    }

    /// Records the exit; returns whether the shell already disposed.
    fn mark_exited(&self) -> bool {
        match self.state.lock() {
            Ok(mut state) => {
                state.exited = true;
                state.disposed
            }
            Err(_) => false,
        }
    }

    /// The pid can no longer be proven pinned: drop the child unreaped and
    /// refuse every later signal.
    #[cfg(unix)]
    fn unpin(&self) {
        let child = match self.state.lock() {
            Ok(mut state) => {
                state.exited = true;
                state.child.take()
            }
            Err(_) => None,
        };
        drop(child);
        self.forget();
    }
}

#[cfg(unix)]
fn posix_signal(signal: SignalName) -> rustix::process::Signal {
    match signal {
        SignalName::Term => rustix::process::Signal::TERM,
        SignalName::Kill => rustix::process::Signal::KILL,
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
