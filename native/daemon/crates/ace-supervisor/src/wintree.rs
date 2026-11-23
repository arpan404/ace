// SPDX-License-Identifier: Apache-2.0
//! Windows trees: no process group exists, so a process belongs to a
//! recorded tree only by proof. Ports the Windows half of
//! `process-identity.ts`: creation-time identity, member proof by ancestry,
//! and the stop that ends only proven members.

use crate::errors::SupervisorError;

/// A recorded tree member: pid, creation time, owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsRecord {
    pub pid: u32,
    pub start: String,
    pub uid: String,
}

/// What ending one member did: ended, or already gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsTerminate {
    Ended,
    Gone,
}

/// A recorded tree's live state and member termination, behind one trait
/// so tests inject a fake and production binds the kernel.
#[cfg(windows)]
pub trait WindowsTreeOps {
    /// The recorded members' state now.
    fn state(&self, recorded: &[WindowsRecord]) -> WindowsTreeState;
    /// Ends one member; returns what it did.
    fn terminate(&self, member: &WindowsRecord) -> Result<WindowsTerminate, SupervisorError>;
}

/// The real Windows tree runtime: one Toolhelp snapshot, then per-PID reads.
#[cfg(windows)]
pub struct SystemWindowsTree;

#[cfg(windows)]
impl SystemWindowsTree {
    /// Creates the runtime; binding kernel32 happens on first use.
    pub fn new() -> Self {
        Self
    }
}

#[cfg(windows)]
impl Default for SystemWindowsTree {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl WindowsTreeOps for SystemWindowsTree {
    fn state(&self, recorded: &[WindowsRecord]) -> WindowsTreeState {
        let snapshot = snapshot_processes().unwrap_or(WindowsSnapshot {
            taken: "0".to_owned(),
            processes: Vec::new(),
        });
        windows_tree_state(recorded, &snapshot, &|pid| identify_pid(pid))
    }

    fn terminate(&self, member: &WindowsRecord) -> Result<WindowsTerminate, SupervisorError> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, SYNCHRONIZE,
        };
        let handle = OpenProcess(
            (PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) as u32,
            0,
            member.pid,
        );
        if handle == 0 {
            return if GetLastError() == crate::identity::ERROR_INVALID_PARAMETER {
                Ok(WindowsTerminate::Gone)
            } else {
                Err(SupervisorError::Unavailable(
                    "kernel process identity unavailable".to_owned(),
                ))
            };
        }
        // Any open handle keeps an exited process openable.
        if WaitForSingleObject(handle, 0) == 0 {
            CloseHandle(handle);
            return Ok(WindowsTerminate::Gone);
        }
        let gone = || {
            CloseHandle(handle);
            WindowsTerminate::Gone
        };
        let mut creation = windows_sys::Win32::System::Threading::FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
            CloseHandle(handle);
            return Err(SupervisorError::Unavailable(
                "kernel process identity unavailable".to_owned(),
            ));
        }
        let start = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        if start.to_string() != member.start {
            return Ok(gone());
        }
        if TerminateProcess(handle, 1) != 0 {
            CloseHandle(handle);
            return Ok(WindowsTerminate::Ended);
        }
        // A process already exiting refuses termination; wait for it to finish.
        if WaitForSingleObject(handle, 2_000) == 0 {
            CloseHandle(handle);
            return Ok(WindowsTerminate::Gone);
        }
        CloseHandle(handle);
        Err(SupervisorError::Unavailable(
            "kernel process identity unavailable".to_owned(),
        ))
    }
}

#[cfg(windows)]
fn identify_pid(pid: u32) -> WindowsIdentified {
    use crate::identity::{WindowsApi, WindowsIdentityApi, read_windows_identity};
    let api = match WindowsApi::load() {
        Ok(api) => api,
        Err(_) => return WindowsIdentified::Unknown,
    };
    match read_windows_identity(pid, &api) {
        Ok(Some(identity)) => WindowsIdentified::Found {
            start: identity.start,
            uid: match identity.owner {
                crate::identity::ProcessOwner::Sid(sid) => sid,
                crate::identity::ProcessOwner::Uid(uid) => uid.to_string(),
            },
        },
        Ok(None) => WindowsIdentified::Gone,
        Err(_) => WindowsIdentified::Unknown,
    }
}

#[cfg(windows)]
fn snapshot_processes() -> Result<WindowsSnapshot, SupervisorError> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Time::GetSystemTimePreciseAsFileTime;
    use windows_sys::Win32::System::Threading::FILETIME;
    let unavailable = |what: &str| SupervisorError::Unavailable(format!("Windows tree {what} unavailable"));
    // The precise clock: the coarse one lags by a tick, and a child created
    // just before the snapshot would look created after it.
    let mut clock = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    GetSystemTimePreciseAsFileTime(&mut clock);
    let taken = (((clock.dwHighDateTime as u64) << 32) | clock.dwLowDateTime as u64).to_string();
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if snapshot == 0 || snapshot == INVALID_HANDLE_VALUE {
        return Err(unavailable("snapshot"));
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };
    let mut processes = Vec::new();
    let mut ok = Process32FirstW(snapshot, &mut entry);
    while ok != 0 {
        processes.push(WindowsLink {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
        });
        ok = Process32NextW(snapshot, &mut entry);
    }
    let last = GetLastError();
    CloseHandle(snapshot);
    if last != 18 {
        return Err(unavailable("snapshot"));
    }
    Ok(WindowsSnapshot { taken, processes })
}

/// A PID's creation time and owner: proven, gone, or unreadable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowsIdentified {
    /// Proven live: creation time and owner.
    Found { start: String, uid: String },
    /// Proven gone.
    Gone,
    /// Unreadable is not absent: a protected process stays unproven.
    Unknown,
}

/// One Toolhelp pass; `taken` is the system time read just before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsSnapshot {
    pub taken: String,
    pub processes: Vec<WindowsLink>,
}

/// One parent link from the snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsLink {
    pub pid: u32,
    pub parent: u32,
}

/// What a recorded tree holds now: live proven members, newly proven ones,
/// gone members, and live pids that cannot be proven either way.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WindowsTreeState {
    /// Proven members alive now. Only these may be ended.
    pub live: Vec<WindowsRecord>,
    /// Newly proven members, to record while ancestry still checks.
    pub discovered: Vec<WindowsRecord>,
    /// Recorded members that are gone, or whose pid names another process.
    pub gone: Vec<WindowsRecord>,
    /// Live pids that may belong to the tree but cannot be proven to.
    pub ambiguous: Vec<u32>,
}

fn after(a: &str, b: &str) -> bool {
    parse_filetime(a) > parse_filetime(b)
}

fn parse_filetime(value: &str) -> u128 {
    value.parse::<u128>().unwrap_or(u128::MAX)
}

/// The state of `recorded` against one snapshot and identity reader.
/// Children listed under a live proven parent and created after it, before
/// the snapshot, were made by that parent. A live holder of a reused pid
/// makes every child started after it ambiguous instead.
pub fn windows_tree_state(
    recorded: &[WindowsRecord],
    snapshot: &WindowsSnapshot,
    identify: &dyn Fn(u32) -> WindowsIdentified,
) -> WindowsTreeState {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for link in &snapshot.processes {
        if link.pid != link.parent {
            children.entry(link.parent).or_default().push(link.pid);
        }
    }
    let mut read: std::collections::HashMap<u32, WindowsIdentified> =
        std::collections::HashMap::new();
    let mut look = |pid: u32| -> WindowsIdentified {
        if let Some(found) = read.get(&pid) {
            return found.clone();
        }
        let found = identify(pid);
        read.insert(pid, found.clone());
        found
    };
    let mut state = WindowsTreeState::default();
    let mut seen: std::collections::HashSet<u32> =
        recorded.iter().map(|member| member.pid).collect();
    for member in recorded {
        match look(member.pid) {
            WindowsIdentified::Unknown => state.ambiguous.push(member.pid),
            WindowsIdentified::Found { start, uid }
                if start == member.start && uid == member.uid =>
            {
                state.live.push(member.clone())
            }
            _ => state.gone.push(member.clone()),
        }
    }
    // Grow the tree from live proven parents, before revisiting the gone.
    let mut index = 0;
    while index < state.live.len() {
        let parent = state.live[index].clone();
        index += 1;
        for pid in children.get(&parent.pid).cloned().unwrap_or_default() {
            if seen.contains(&pid) {
                continue;
            }
            let found = look(pid);
            if found == WindowsIdentified::Gone {
                continue;
            }
            seen.insert(pid);
            if found == WindowsIdentified::Unknown {
                state.ambiguous.push(pid);
                continue;
            }
            let WindowsIdentified::Found { start, uid } = found else {
                continue;
            };
            if uid != parent.uid || after(&parent.start, &start) {
                continue;
            }
            if after(&start, &snapshot.taken) {
                continue;
            }
            let member = WindowsRecord { pid, start, uid };
            state.live.push(member.clone());
            state.discovered.push(member);
        }
    }
    for member in state.gone.clone() {
        let holder = look(member.pid);
        for pid in children.get(&member.pid).cloned().unwrap_or_default() {
            if seen.contains(&pid) {
                continue;
            }
            let found = look(pid);
            if found == WindowsIdentified::Gone {
                continue;
            }
            if found != WindowsIdentified::Unknown {
                let WindowsIdentified::Found { start, uid } = found else {
                    continue;
                };
                // Started before the member: an earlier holder's child.
                if uid != member.uid || !after(&start, &member.start) {
                    continue;
                }
                // A live holder of the reused pid made every child started after it.
                if let WindowsIdentified::Found {
                    start: holder_start,
                    ..
                } = &holder
                    && !after(holder_start, &start)
                {
                    continue;
                }
            }
            seen.insert(pid);
            state.ambiguous.push(pid);
        }
    }
    state
}

/// Validates a token-user SID string: `S-` plus dot-separated numbers.
pub fn valid_sid(value: &str) -> bool {
    if value.len() > 256 || !value.starts_with("S-") {
        return false;
    }
    let mut parts = value[2..].split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty() || !first.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let mut count = 1;
    for part in parts {
        count += 1;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
    }
    count >= 2
}

/// Parses a Windows identity row: pid, creation FILETIME start, owner SID.
pub fn parse_windows_record(
    pid: u32,
    start: &str,
    uid: &str,
) -> Result<WindowsRecord, SupervisorError> {
    if pid == 0 {
        return Err(SupervisorError::InvalidInput("bad pid 0".to_owned()));
    }
    if start.is_empty() || start.len() > 128 {
        return Err(SupervisorError::InvalidInput(
            "bad Windows start time".to_owned(),
        ));
    }
    if !valid_sid(uid) {
        return Err(SupervisorError::InvalidInput(
            "bad Windows owner SID".to_owned(),
        ));
    }
    Ok(WindowsRecord {
        pid,
        start: start.to_owned(),
        uid: uid.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1-2-3-1001";
    const STRANGER: &str = "S-1-5-21-1-2-3-1002";

    fn snapshot(taken: u64, processes: &[(u32, u32)]) -> WindowsSnapshot {
        WindowsSnapshot {
            taken: taken.to_string(),
            processes: processes
                .iter()
                .map(|(pid, parent)| WindowsLink {
                    pid: *pid,
                    parent: *parent,
                })
                .collect(),
        }
    }

    /// Live processes by pid: creation time and owner. Anything else is gone.
    fn host(live: &[(u32, u64, Option<&str>)]) -> impl Fn(u32) -> WindowsIdentified {
        let table: std::collections::HashMap<u32, (u64, Option<String>)> = live
            .iter()
            .map(|(pid, start, uid)| (*pid, (*start, uid.map(str::to_owned))))
            .collect();
        move |pid| match table.get(&pid) {
            None => WindowsIdentified::Gone,
            Some((_, None)) => WindowsIdentified::Unknown,
            Some((start, Some(uid))) => WindowsIdentified::Found {
                start: start.to_string(),
                uid: uid.clone(),
            },
        }
    }

    fn record(pid: u32, start: u64) -> WindowsRecord {
        WindowsRecord {
            pid,
            start: start.to_string(),
            uid: SID.to_owned(),
        }
    }

    #[test]
    fn reused_leader_pid_child_is_neither_ended_nor_claimed() {
        // Leader 100 (started 10) died; a stranger reused 100, made child 200 at 30.
        let state = windows_tree_state(
            &[record(100, 10)],
            &snapshot(50, &[(200, 100)]),
            &host(&[(200, 30, Some(SID))]),
        );
        assert!(state.live.is_empty());
        assert!(state.discovered.is_empty());
        assert_eq!(state.ambiguous, vec![200]);
    }

    #[test]
    fn reuser_children_stay_strangers_and_earlier_orphans_unproven() {
        // Leader 100 (10) died; 150 was made at 20, before 100 was reused at 25.
        let state = windows_tree_state(
            &[record(100, 10)],
            &snapshot(50, &[(150, 100), (200, 100)]),
            &host(&[
                (100, 25, Some(SID)),
                (150, 20, Some(SID)),
                (200, 30, Some(SID)),
            ]),
        );
        assert!(state.live.is_empty());
        assert_eq!(state.ambiguous, vec![150]);
    }

    #[test]
    fn surviving_grandchild_keeps_the_tree_unresolved() {
        let state = windows_tree_state(
            &[record(100, 10), record(200, 15)],
            &snapshot(50, &[(300, 200)]),
            &host(&[(300, 20, Some(SID))]),
        );
        assert!(state.live.is_empty());
        assert_eq!(
            state
                .gone
                .iter()
                .map(|member| member.pid)
                .collect::<Vec<_>>(),
            vec![100, 200]
        );
        assert_eq!(state.ambiguous, vec![300]);
    }

    #[test]
    fn recorded_descendant_is_ended_after_its_parents_exit() {
        let state = windows_tree_state(
            &[record(100, 10), record(200, 15), record(300, 20)],
            &snapshot(50, &[(300, 200)]),
            &host(&[(300, 20, Some(SID))]),
        );
        assert_eq!(state.live, vec![record(300, 20)]);
        assert!(state.ambiguous.is_empty());
    }

    #[test]
    fn only_children_of_a_live_parent_before_the_snapshot_are_claimed() {
        let state = windows_tree_state(
            &[record(100, 10)],
            &snapshot(
                50,
                &[(200, 100), (300, 200), (400, 100), (500, 100), (600, 100)],
            ),
            &host(&[
                (100, 10, Some(SID)),
                (200, 20, Some(SID)),
                (300, 25, Some(SID)),
                (400, 5, Some(SID)),
                (500, 60, Some(SID)),
                (600, 30, Some(STRANGER)),
            ]),
        );
        assert_eq!(
            state
                .live
                .iter()
                .map(|member| member.pid)
                .collect::<Vec<_>>(),
            vec![100, 200, 300]
        );
        assert_eq!(state.discovered, vec![record(200, 20), record(300, 25)]);
        assert!(state.ambiguous.is_empty());
    }

    #[test]
    fn unreadable_member_is_neither_ended_nor_gone() {
        let state = windows_tree_state(
            &[record(100, 10)],
            &snapshot(50, &[]),
            &host(&[(100, 0, None)]),
        );
        assert!(state.live.is_empty());
        assert!(state.gone.is_empty());
        assert_eq!(state.ambiguous, vec![100]);
    }

    #[test]
    fn sids_validate_as_dotted_numbers() {
        assert!(valid_sid(SID));
        assert!(!valid_sid("not-a-sid"));
        assert!(!valid_sid("S-"));
        assert!(!valid_sid(&format!("S-1-{}", "1".repeat(300))));
    }
}
