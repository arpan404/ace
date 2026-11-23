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
    /// The recorded members' state now; fails when no snapshot can be taken.
    fn state(&self, recorded: &[WindowsRecord]) -> Result<WindowsTreeState, SupervisorError>;
    /// Ends one member; returns what it did.
    fn terminate(&self, member: &WindowsRecord) -> Result<WindowsTerminate, SupervisorError>;
}

#[cfg(windows)]
mod system;
#[cfg(windows)]
pub use system::SystemWindowsTree;

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
mod tests;
