// SPDX-License-Identifier: Apache-2.0
//! A spawned leader, held so its pid, and on POSIX its process group id,
//! cannot be reused while ace may still signal the group.
//!
//! The invariant: a process group's number is signalled only while ace
//! holds its leader unreaped. The unreaped leader (alive, or a zombie whose
//! exit was read with `waitid(WNOWAIT)`) pins the group id, so no other
//! group can take it. The leader is reaped (released) only once its group is
//! confirmed empty: two consecutive empty scans while it is still held. When
//! the shell has given the group up and the hold limit passes with the
//! group still occupied, the group is killed by number (still held, so
//! safe) and the reap waits until it is empty. After release nothing is
//! left to signal by group, and nothing is: there is no member list, no
//! probe, no later capture. Descendants that left the group (setsid or
//! setpgid) are not the group's: as orphans they reparent to ace (the
//! subreaper) and are stopped one by one by verified identity.
//!
//! Only the leader is waited for: adopted descendants are the reaper's
//! (`reaper.rs`). Windows has no groups: the process handle pins the pid
//! until the shell disposes the child after its exit.

#[cfg(unix)]
use crate::errors::SupervisorError;
use crate::signal::SignalName;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// The leader of one supervised tree.
pub struct Leader {
    pid: u32,
    /// The kernel start time read at spawn; the registry key with `pid`.
    start: Option<String>,
    state: Mutex<LeaderState>,
    /// Wakes the release loop: a stop is polling, or the shell gave up.
    pub(crate) wake: tokio::sync::Notify,
}

#[derive(Default)]
struct LeaderState {
    /// The child until it is reaped (POSIX) or closed (Windows).
    child: Option<std::process::Child>,
    /// The wait saw the exit; only then may the child be released.
    exited: bool,
    /// The group number is never signalled again: confirmed empty while
    /// held, or the pin was lost (the leader reaped by something else).
    released: bool,
    /// The group was confirmed empty while held: the only "gone".
    confirmed_empty: bool,
    /// Stops in progress; release waits for them.
    holds: usize,
    /// The shell gave the group up: the hold limit runs from here.
    disowned: bool,
    /// The previous scan's live members, to see two identical empty scans.
    last_scan: Option<BTreeSet<(u32, String)>>,
}

/// What a group signal through the handle did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupSignal {
    Sent,
    /// The kernel says no process is left in the group.
    Gone,
    /// The group was confirmed empty and its leader reaped: nothing is
    /// sent, since its number may belong to someone else now.
    Released,
}

/// What one release step left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReleaseStep {
    /// Still held: not exited, a stop holds it, or the group lives.
    Held,
    /// Released, but the reap has not succeeded yet: retry.
    Reaping,
    /// Released and reaped (or closed): nothing more to do.
    Done,
}

/// Supervised leaders in this process, by kernel identity (pid and start),
/// so a caller holding a stale pid never binds to a later child that reused
/// it. The release loop holds each leader until it is reaped, so an entry
/// lasts at least as long as the zombie it names; it leaves when the leader
/// drops. One per process, like the pid space it mirrors.
type Registry = Mutex<HashMap<(u32, String), Weak<Leader>>>;

fn registry() -> &'static Registry {
    static LEADERS: OnceLock<Registry> = OnceLock::new();
    LEADERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The leader with this identity, if this supervisor spawned it.
pub fn group_leader(pid: u32, start: &str) -> Option<Arc<Leader>> {
    registry()
        .lock()
        .ok()?
        .get(&(pid, start.to_owned()))
        .and_then(Weak::upgrade)
}

impl Leader {
    pub(crate) fn new(child: std::process::Child) -> Arc<Self> {
        let pid = child.id();
        let start = crate::identity::process_identity(pid)
            .ok()
            .flatten()
            .map(|identity| identity.start);
        let leader = Arc::new(Self {
            pid,
            start,
            state: Mutex::new(LeaderState {
                child: Some(child),
                ..LeaderState::default()
            }),
            wake: tokio::sync::Notify::new(),
        });
        if let (Some(start), Ok(mut leaders)) = (&leader.start, registry().lock()) {
            leaders.insert((pid, start.clone()), Arc::downgrade(&leader));
        }
        leader
    }

    /// The leader's pid.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// The leader's kernel start, read at spawn.
    pub fn start(&self) -> Option<&str> {
        self.start.as_deref()
    }

    /// Signals the leader itself while its pid is still its own (alive, or
    /// exited but unreaped). False once reaped: nothing is sent.
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

    /// Starts a stop: true while ace holds the leader unreaped, which then
    /// stays so until `unhold`. False once released: the group is empty.
    pub fn hold(&self) -> bool {
        match self.state.lock() {
            Ok(mut state) if !state.released && state.child.is_some() => {
                state.holds += 1;
                true
            }
            _ => false,
        }
    }

    /// Ends a stop started with `hold`.
    pub fn unhold(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.holds = state.holds.saturating_sub(1);
        }
        self.wake.notify_one();
    }

    /// Signals the group by number. Only while held: the lock is held
    /// across the signal, so release cannot slip in.
    #[cfg(unix)]
    pub fn signal_group(&self, signal: SignalName) -> Result<GroupSignal, SupervisorError> {
        let state = self
            .state
            .lock()
            .map_err(|_| SupervisorError::Operation("supervisor leader lock failed".to_owned()))?;
        if state.released || state.child.is_none() {
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

    /// Whether nothing of the group runs: only once it was confirmed empty
    /// while held (and so released). Reads state only, never walks
    /// anything; it wakes the release loop to scan now.
    pub fn group_gone(&self) -> bool {
        let empty = self.state.lock().is_ok_and(|state| state.confirmed_empty);
        if !empty {
            self.wake.notify_one();
        }
        empty
    }

    /// The shell gave the group up (through this child's own handle, never
    /// by number): the hold limit starts. Release still waits for the group
    /// to be confirmed empty.
    pub fn disown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.disowned = true;
        }
        self.wake.notify_one();
    }

    /// Whether the shell gave the group up.
    #[cfg(unix)]
    pub(crate) fn disowned(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.disowned)
    }

    /// Windows: the shell disposed the child; its handle may close once the
    /// leader exited.
    pub fn dispose(&self) {
        if cfg!(windows) {
            self.disown();
            let _ = self.step(false);
        }
    }

    fn forget(&self) {
        let Some(start) = &self.start else { return };
        if let Ok(mut leaders) = registry().lock() {
            let key = (self.pid, start.clone());
            if leaders
                .get(&key)
                .is_some_and(|known| std::ptr::eq(known.as_ptr(), self))
            {
                leaders.remove(&key);
            }
        }
    }

    pub(super) fn mark_exited(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.exited = true;
        }
    }
}

impl Drop for Leader {
    fn drop(&mut self) {
        self.forget();
    }
}

mod release;
mod wait;

#[cfg(unix)]
fn posix_signal(signal: SignalName) -> rustix::process::Signal {
    match signal {
        SignalName::Term => rustix::process::Signal::TERM,
        SignalName::Kill => rustix::process::Signal::KILL,
    }
}
