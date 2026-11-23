// SPDX-License-Identifier: Apache-2.0
//! Linux child subreaper: the daemon adopts orphans so a shutdown finds
//! them, and reaps only zombies proven adopted. Ports `process-reaper.ts`
//! and `child-exit.ts`.

use crate::errors::SupervisorError;

/// One of the daemon's zombie children: its group and start, from one read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZombieChild {
    pub pid: u32,
    pub group: u32,
    pub start: String,
}

/// What a watch saw of a process before it could have been adopted.
pub trait AdoptionEvidence {
    /// This process's start and first parent, if the watch saw it.
    fn seen(&self, pid: u32) -> Option<(String, u32)>;
}

/// The zombie children the daemon may reap: the proven adopted ones, never
/// an owned group's leader. Evidence counts only for the same process: its
/// pid AND start time, so a later child that reused a watched pid is never
/// taken for the adopted one.
pub fn proven_adoptions<E: AdoptionEvidence>(
    zombies: &[ZombieChild],
    daemon_pid: u32,
    owned: &std::collections::HashSet<u32>,
    evidence: &E,
) -> Vec<u32> {
    zombies
        .iter()
        .filter(|zombie| {
            if owned.contains(&zombie.pid) {
                return false;
            }
            matches!(evidence.seen(zombie.pid), Some((start, parent)) if start == zombie.start && parent != daemon_pid)
        })
        .map(|zombie| zombie.pid)
        .collect()
}

/// Makes this process a child subreaper. False where the platform can't.
/// `PR_SET_CHILD_SUBREAPER` takes a nonzero flag to enable; rustix spells
/// that flag as a pid, and `None` (zero) would turn subreaping off.
#[cfg(target_os = "linux")]
pub fn become_subreaper() -> bool {
    rustix::process::set_child_subreaper(Some(rustix::process::Pid::INIT)).is_ok()
}

/// No subreaper off Linux.
#[cfg(not(target_os = "linux"))]
pub fn become_subreaper() -> bool {
    false
}

/// Proves a Darwin child has exited without reaping it: its pid stays
/// reserved and the runtime still receives the real wait status. Elsewhere
/// (or for a non-child) there is no such proof.
pub fn child_has_exited(pid: u32) -> bool {
    if cfg!(not(target_os = "macos")) || pid == 0 {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let Ok(raw) = i32::try_from(pid) else {
            return false;
        };
        let Some(target) = Pid::from_raw(raw) else {
            return false;
        };
        matches!(
            waitid(
                WaitId::Pid(target),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            ),
            Ok(Some(_))
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        false
    }
}

/// Reaps one proven-adopted zombie without blocking. True when reaped.
#[cfg(target_os = "linux")]
pub fn reap(pid: u32) -> bool {
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    let Some(target) = rustix::process::Pid::from_raw(raw) else {
        return false;
    };
    matches!(
        rustix::process::waitpid(Some(target), rustix::process::WaitOptions::NOHANG),
        Ok(Some(_))
    )
}

/// No reaping off Linux: only the subreaper adopts.
#[cfg(not(target_os = "linux"))]
pub fn reap(_pid: u32) -> bool {
    false
}

/// Whether `pid` answers a signal probe: false once the kernel says ESRCH.
/// Other refusals fail closed with an error.
#[cfg(unix)]
pub fn process_alive(pid: u32) -> Result<bool, SupervisorError> {
    let raw = i32::try_from(pid)
        .ok()
        .filter(|raw| *raw > 0)
        .ok_or_else(|| SupervisorError::InvalidInput(format!("bad pid {pid}")))?;
    let Some(target) = rustix::process::Pid::from_raw(raw) else {
        return Err(SupervisorError::InvalidInput(format!("bad pid {pid}")));
    };
    match rustix::process::test_kill_process(target) {
        Ok(()) => Ok(true),
        Err(error) if error == rustix::io::Errno::SRCH => Ok(false),
        Err(error) => Err(SupervisorError::Operation(format!(
            "signal probe of {pid} failed: {error}"
        ))),
    }
}

/// Whether group `group` answers a signal probe. ESRCH proves it gone;
/// EPERM proves nothing (macOS reports it while a group exits) and stays
/// an error for the caller to keep as evidence.
#[cfg(unix)]
pub fn process_group_alive(group: u32) -> Result<bool, SupervisorError> {
    // rustix negates the group itself; the id stays positive here.
    let raw = i32::try_from(group)
        .ok()
        .filter(|raw| *raw > 0)
        .ok_or_else(|| SupervisorError::InvalidInput(format!("bad group {group}")))?;
    let Some(target) = rustix::process::Pid::from_raw(raw) else {
        return Err(SupervisorError::InvalidInput(format!("bad group {group}")));
    };
    match rustix::process::test_kill_process_group(target) {
        Ok(()) => Ok(true),
        Err(error) if error == rustix::io::Errno::SRCH => Ok(false),
        Err(error) if error == rustix::io::Errno::PERM => Err(SupervisorError::Unavailable(
            format!("signal probe of group {group} refused"),
        )),
        Err(error) => Err(SupervisorError::Operation(format!(
            "signal probe of group {group} failed: {error}"
        ))),
    }
}

/// Whether `pid` names a live process, as `process.kill(pid, 0)` answers on
/// Windows: an invalid pid is gone, an exited one is gone, a refused open
/// fails closed.
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn process_alive(pid: u32) -> Result<bool, SupervisorError> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain values in, a handle or null out; a non-null handle is
    // closed exactly once below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // SAFETY: reads this thread's error slot right after the failed call.
        let error = unsafe { GetLastError() };
        return if error == ERROR_INVALID_PARAMETER {
            Ok(false)
        } else {
            Err(SupervisorError::Operation(format!(
                "signal probe of {pid} failed: {error}"
            )))
        };
    }
    let mut code = 0u32;
    // SAFETY: `handle` is live with query rights; `code` is an owned local.
    let read = unsafe { GetExitCodeProcess(handle, &mut code) };
    // SAFETY: `handle` came from OpenProcess above and is closed once.
    unsafe {
        CloseHandle(handle);
    }
    if read == 0 {
        return Err(SupervisorError::Operation(format!(
            "signal probe of {pid} failed"
        )));
    }
    Ok(code == STILL_ACTIVE as u32)
}

/// No process groups exist on Windows: no probe can answer.
#[cfg(not(unix))]
pub fn process_group_alive(group: u32) -> Result<bool, SupervisorError> {
    Err(SupervisorError::Unavailable(format!(
        "process group {group} has no meaning on Windows"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct MapEvidence {
        seen: HashMap<u32, (String, u32)>,
    }

    impl AdoptionEvidence for MapEvidence {
        fn seen(&self, pid: u32) -> Option<(String, u32)> {
            self.seen.get(&pid).cloned()
        }
    }

    #[test]
    fn only_zombies_proven_adopted_are_reaped() {
        let zombies = vec![
            // Seen earlier, with this start, as an app-server's child.
            ZombieChild {
                pid: 301,
                group: 301,
                start: "shell".to_owned(),
            },
            // In a sibling's group, with no evidence: a runtime child may join any group.
            ZombieChild {
                pid: 302,
                group: 200,
                start: "joined-a-sibling".to_owned(),
            },
            // The daemon's own detached spawn: its own group, never seen.
            ZombieChild {
                pid: 303,
                group: 303,
                start: "launcher".to_owned(),
            },
            // A plain spawn (git): the daemon's group.
            ZombieChild {
                pid: 304,
                group: 100,
                start: "git".to_owned(),
            },
            // The runtime's own child, on a pid the watch once saw under another parent.
            ZombieChild {
                pid: 305,
                group: 305,
                start: "bun-child".to_owned(),
            },
            // An owned group's leader: the runtime reaps it.
            ZombieChild {
                pid: 200,
                group: 200,
                start: "app-server".to_owned(),
            },
        ];
        let evidence = MapEvidence {
            seen: [
                (301, ("shell".to_owned(), 200)),
                (305, ("an-earlier-process".to_owned(), 200)),
                (200, ("app-server".to_owned(), 50)),
            ]
            .into_iter()
            .collect(),
        };
        assert_eq!(
            proven_adoptions(&zombies, 100, &HashSet::from([200]), &evidence),
            vec![301]
        );
    }

    #[test]
    fn non_children_have_no_exit_proof() {
        assert!(!child_has_exited(0));
        assert!(!child_has_exited(1));
    }
}
