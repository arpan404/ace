// SPDX-License-Identifier: Apache-2.0
//! A spawned leader, held so its pid, and on POSIX its process group id,
//! cannot be reused while ace may still signal the group.
//!
//! POSIX: the exit is observed without reaping (`waitid(WNOWAIT)`); the
//! zombie keeps the group id ace's. It is reaped (released) once the leader
//! exited, no stop holds it, and either two consecutive scans found the
//! same empty group or the shell gave the group up (`disown`). After that
//! the handle never signals the group again. Only the leader is waited for:
//! adopted descendants are the reaper's (`reaper.rs`). Windows: the process
//! handle pins the pid until the shell disposes the child after its exit.

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
}

#[derive(Default)]
struct LeaderState {
    /// The child until it is released: reaped (POSIX) or closed (Windows).
    child: Option<std::process::Child>,
    /// The wait saw the exit; only then may the child be released.
    exited: bool,
    /// Stops in progress; none may run against a released group.
    holds: usize,
    /// The shell gave the group up (POSIX) or disposed the child (Windows).
    disowned: bool,
    /// The previous scan's live members, to see two identical scans.
    last_scan: Option<BTreeSet<(u32, String)>>,
    /// Members and tree recorded while the leader pinned the group (at
    /// each group signal, and just before release): after release, stops
    /// reach only these, one by one, and the children they prove.
    known: BTreeSet<(u32, String)>,
}

/// What a group signal through the handle did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupSignal {
    Sent,
    /// The kernel says no process is left in the group.
    Gone,
    /// The leader was released: nothing is sent, since the group id may
    /// belong to someone else now.
    Released,
}

/// Supervised leaders in this process, by kernel identity (pid and start),
/// so a caller holding a stale pid never binds to a later child that reused
/// it. A released leader stays while its handle lives, so a stop still
/// reaches its recorded members; the entry leaves when it drops. One per
/// process, like the pid space it mirrors.
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

    /// Starts a stop: true while the group id is still ace's, and then the
    /// leader stays unreaped until `unhold`. False once released.
    pub fn hold(&self) -> bool {
        match self.state.lock() {
            Ok(mut state) if state.child.is_some() => {
                state.holds += 1;
                true
            }
            _ => false,
        }
    }

    /// Ends a stop started with `hold`; a group given up meanwhile is
    /// released now.
    pub fn unhold(&self) {
        let disowned = match self.state.lock() {
            Ok(mut state) => {
                state.holds = state.holds.saturating_sub(1);
                state.disowned
            }
            Err(_) => false,
        };
        if disowned {
            self.release_if_ready();
        }
    }

    /// Records the group's members and the leader's tree while the leader
    /// still pins the group id.
    fn record(&self) {
        let found = crate::system::capture_group(self.pid);
        if let Ok(mut state) = self.state.lock()
            && state.child.is_some()
        {
            state.known.extend(found);
        }
    }

    /// The members a stop may still signal one by one: recorded ones that
    /// run (same pid and start), and the children they prove.
    pub fn members(&self) -> Vec<crate::signal::TreeRef> {
        let known = match self.state.lock() {
            Ok(state) => state.known.clone(),
            Err(_) => return Vec::new(),
        };
        crate::system::live_with_children(&known)
    }

    /// Signals the whole group while the unreaped leader keeps its id
    /// ace's, recording its members first. The lock is held across the
    /// signal, so release cannot slip in. Once released: nothing is sent,
    /// and stops go member by member (`members`).
    #[cfg(unix)]
    pub fn signal_group(&self, signal: SignalName) -> Result<GroupSignal, SupervisorError> {
        self.record();
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

    /// Whether nothing of the group runs: once released, no recorded member
    /// (or child it proves) runs; before, a scan read every member and
    /// found none live. The zombie leader does not count; an unreadable
    /// member does.
    pub fn group_gone(&self) -> bool {
        let (released, exited) = match self.state.lock() {
            Ok(state) => (state.child.is_none(), state.exited),
            Err(_) => return false,
        };
        if released {
            return self.members_none();
        }
        exited
            && crate::system::group_live_members(self.pid, self.pid)
                .is_some_and(|live| live.is_empty())
    }

    fn members_none(&self) -> bool {
        self.members().is_empty()
    }

    /// The shell gave the group up: once the leader has exited and no stop
    /// holds it, it is released whatever the group holds; later stops find
    /// the group released and send nothing.
    pub fn disown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.disowned = true;
        }
        self.release_if_ready();
    }

    /// Windows: the shell disposed the child; same as giving the tree up.
    pub fn dispose(&self) {
        if cfg!(windows) {
            self.disown();
        }
    }

    /// Releases the leader when it may be: exited, no stop holding it, and
    /// disowned or (POSIX) two consecutive identical scans of an empty
    /// group. True once released.
    pub(crate) fn release_if_ready(&self) -> bool {
        let disowned = match self.state.lock() {
            Ok(state) if state.child.is_none() => return true,
            Ok(state) if !state.exited || state.holds > 0 => return false,
            Ok(state) => state.disowned,
            Err(_) => return false,
        };
        if !disowned && !self.scanned_empty_twice() {
            return false;
        }
        self.release();
        true
    }

    /// POSIX: one scan of the group; true when it and the scan before both
    /// read every member and found the same, empty, set. Windows trees have
    /// no group and are released only by `dispose`.
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

    /// Reaps (POSIX) or closes (Windows) the exited leader, unless a stop
    /// took a hold in the meantime; records the members first, while the
    /// group id is still pinned.
    fn release(&self) {
        if cfg!(unix) {
            self.record();
        }
        let child = match self.state.lock() {
            Ok(mut state) if state.exited && state.holds == 0 => state.child.take(),
            _ => None,
        };
        if let Some(mut child) = child {
            // POSIX: collects the zombie. Windows: the drop closes the handle.
            let _ = child.try_wait();
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

mod wait;

#[cfg(unix)]
fn posix_signal(signal: SignalName) -> rustix::process::Signal {
    match signal {
        SignalName::Term => rustix::process::Signal::TERM,
        SignalName::Kill => rustix::process::Signal::KILL,
    }
}
