// SPDX-License-Identifier: Apache-2.0
//! Process trees by parent pid, for stops that must reach every process a
//! child started. Ports `process-tree.ts`: a capture takes each child's start
//! from the same kernel read as its parent link, and every signal is checked
//! against that start on its own, just before it is sent.

use crate::errors::SupervisorError;
use crate::signal::{PidFdTable, SignalIo, SignalName, SignalOutcome, TreeRef, signal_member};

/// The most members one capture walks; past it the stop must not report done.
pub const CAPTURE_LIMIT: usize = 16_384;
const TABLE_LIMIT: usize = 4_194_304;

/// A running process, from one kernel read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveIdentity {
    pub start: String,
    pub parent: u32,
    pub group: u32,
}

/// A captured process: the member, the parent it had then, its group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedMember {
    pub pid: u32,
    pub start: String,
    pub parent: u32,
    pub group: u32,
}

impl CapturedMember {
    /// The member as a signal target.
    pub fn as_ref(&self) -> TreeRef {
        TreeRef {
            pid: self.pid,
            start: self.start.clone(),
        }
    }
}

/// The tree seam over a listing, with injected fakes for tests.
pub trait TreeIo {
    /// The platform: trees are walked on darwin and linux only.
    fn platform(&self) -> &str;
    /// A children reader for one walk.
    fn children(&self, pid: u32) -> Vec<u32>;
    /// A running process's identity; `None` once it is gone, zombies included.
    fn identity(&self, pid: u32) -> Option<LiveIdentity>;
    /// kill(2) by pid; false when the kill threw, which reads as gone.
    fn kill(&self, pid: u32, signal: SignalName) -> bool;
    /// Linux pidfds, where available.
    fn pidfds(&self) -> Option<&dyn PidFdTable>;
    /// Sleeps between liveness polls; tests substitute a no-op.
    fn wait_ms(&self, ms: u64);
}

/// Whether this platform finds trees by parent pid.
pub fn captures_trees(platform: &str) -> bool {
    platform == "darwin" || platform == "linux"
}

/// `ps -A -o pid=,ppid=`: each process's parent. Malformed rows are skipped.
pub fn parse_process_parents(text: &str) -> Vec<(u32, u32)> {
    if text.len() > TABLE_LIMIT {
        return Vec::new();
    }
    let mut parents = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        if pid > 0 {
            parents.push((pid, ppid));
        }
    }
    parents
}

/// Every process below `roots` in the parent table, roots excluded, parents
/// before children.
pub fn descendants_of(parents: &[(u32, u32)], roots: &[u32]) -> Vec<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, parent) in parents {
        if pid == parent {
            continue;
        }
        children.entry(*parent).or_default().push(*pid);
    }
    let mut seen: std::collections::HashSet<u32> = roots.iter().copied().collect();
    let mut found = Vec::new();
    let mut queue: std::collections::VecDeque<u32> = roots.to_vec().into();
    while let Some(next) = queue.pop_front() {
        if let Some(members) = children.get(&next) {
            for child in members.clone() {
                if seen.insert(child) {
                    found.push(child);
                    queue.push_back(child);
                }
            }
        }
    }
    found
}

/// A capture: what it found, and whether it stopped at its limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capture {
    pub members: Vec<CapturedMember>,
    pub truncated: bool,
}

/// Reads one identity; unreadable (another user's) is never ours to signal.
fn read_identity(io: &dyn TreeIo, pid: u32) -> Option<LiveIdentity> {
    io.identity(pid)
}

/// Every live process below `roots` with its start identity, parents before
/// children. A child is kept only when its own parent link names the parent
/// being walked, and only while that parent is still the walked process.
pub fn capture_tree(roots: &[u32], io: &dyn TreeIo, limit: usize) -> Capture {
    if roots.is_empty() || !captures_trees(io.platform()) {
        return Capture {
            members: Vec::new(),
            truncated: false,
        };
    }
    let mut members = Vec::new();
    let mut seen: std::collections::HashSet<u32> = roots.iter().copied().collect();
    let mut queue: std::collections::VecDeque<TreeRef> = roots
        .iter()
        .filter_map(|pid| {
            read_identity(io, *pid).map(|identity| TreeRef {
                pid: *pid,
                start: identity.start,
            })
        })
        .collect();
    while let Some(parent) = queue.pop_front() {
        let mut found = Vec::new();
        for pid in io.children(parent.pid) {
            if seen.contains(&pid) {
                continue;
            }
            let Some(identity) = read_identity(io, pid) else {
                continue;
            };
            if identity.parent != parent.pid {
                continue;
            }
            found.push(CapturedMember {
                pid,
                start: identity.start,
                parent: parent.pid,
                group: identity.group,
            });
        }
        // The list named whoever holds the parent's pid: only ours if it still does.
        if read_identity(io, parent.pid)
            .as_ref()
            .map(|identity| &identity.start)
            != Some(&parent.start)
        {
            continue;
        }
        for member in found {
            if members.len() >= limit {
                return Capture {
                    members,
                    truncated: true,
                };
            }
            seen.insert(member.pid);
            queue.push_back(TreeRef {
                pid: member.pid,
                start: member.start.clone(),
            });
            members.push(member);
        }
    }
    Capture {
        members,
        truncated: false,
    }
}

/// The live identity of a process as a stop target, once it is gone `None`.
pub fn member_of(pid: u32, io: &dyn TreeIo) -> Option<TreeRef> {
    read_identity(io, pid).map(|identity| TreeRef {
        pid,
        start: identity.start,
    })
}

/// The captured members that are still the same running process.
pub fn live_members(members: &[TreeRef], io: &dyn TreeIo) -> Vec<TreeRef> {
    members
        .iter()
        .filter(|member| {
            read_identity(io, member.pid)
                .as_ref()
                .map(|identity| &identity.start)
                == Some(&member.start)
        })
        .cloned()
        .collect()
}

struct TreeSignalIo<'a> {
    io: &'a dyn TreeIo,
}

impl SignalIo for TreeSignalIo<'_> {
    fn start(&self, pid: u32) -> Option<String> {
        read_identity(self.io, pid).map(|identity| identity.start)
    }

    fn kill(&self, pid: u32, signal: SignalName) -> bool {
        self.io.kill(pid, signal)
    }

    fn pidfds(&self) -> Option<&dyn PidFdTable> {
        self.io.pidfds()
    }
}

/// Signals one member, checked on its own just before the signal goes.
pub fn signal_tree_member(member: &TreeRef, signal: SignalName, io: &dyn TreeIo) -> SignalOutcome {
    signal_member(member, signal, &TreeSignalIo { io })
}

/// Parses `SIGTERM` and `SIGKILL` for the stop path.
pub fn stop_signal(name: &str) -> Result<SignalName, SupervisorError> {
    SignalName::parse(name)
}

/// Stops the captured members still running: SIGTERM, then SIGKILL after
/// `grace_ms`. `deadline` bounds it all: past it, no round starts and no wait
/// continues. Resolves with the members still running.
pub fn stop_members(
    members: &[TreeRef],
    grace_ms: u64,
    io: &dyn TreeIo,
    deadline: Option<std::time::Instant>,
) -> Vec<TreeRef> {
    let signal = |name: SignalName| {
        for member in members {
            signal_tree_member(member, name, io);
        }
    };
    let late = || deadline.is_some_and(|end| std::time::Instant::now() >= end);
    let settle = |milliseconds: u64| {
        let mut waited = 0;
        while waited < milliseconds && !late() && !live_members(members, io).is_empty() {
            io.wait_ms(25);
            waited += 25;
        }
    };
    if live_members(members, io).is_empty() || late() {
        return live_members(members, io);
    }
    signal(SignalName::Term);
    settle(grace_ms);
    if late() {
        return live_members(members, io);
    }
    signal(SignalName::Kill);
    settle(1_000);
    live_members(members, io)
}

#[cfg(test)]
mod tests;
