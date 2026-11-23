// SPDX-License-Identifier: Apache-2.0
//! What the kernel says about processes, read in ways whose cost follows
//! what is asked. Ports `process-listing.ts`: one kernel read per process
//! for start, parent, group and state, so a parent link and a start time
//! always describe the same process, even when its pid is reused around
//! the read.

use crate::errors::SupervisorError;

/// One process, from one kernel read. `start` is the same string `identity` gives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub start: String,
    pub parent: u32,
    pub group: u32,
    pub zombie: bool,
}

/// The kernel's unique id and its starting parent's, where kept (macOS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ancestry {
    pub unique: String,
    pub parent_unique: String,
}

/// The kernel listing seam, with injected fakes for tests.
pub trait KernelListing {
    /// The platform: `linux`, `darwin`, `win32`, or another.
    fn platform(&self) -> &str;
    /// Every process this user can see.
    fn all(&self) -> Vec<u32>;
    /// One kernel read of a process. `None` once it is gone.
    fn info(&self, pid: u32) -> Option<ProcessInfo>;
    /// Its start environment, or `None` when hidden or gone.
    fn environment(&self, pid: u32) -> Option<Vec<String>>;
    /// Its arguments, argv[0] first.
    fn arguments(&self, pid: u32) -> Option<Vec<String>>;
    /// Every process in group `group`, whatever its parent or session now.
    fn group_members(&self, group: u32) -> Vec<u32>;
    /// Whether the platform keeps lineage by unique id.
    fn has_lineage(&self) -> bool {
        false
    }
    /// The kernel's unique id and its starting parent's, where kept.
    fn ancestry(&self, _pid: u32) -> Option<Ancestry> {
        None
    }
}

/// `/proc/<pid>/task/<tid>/children`: space-separated pids.
pub fn parse_child_list(text: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    for word in text.split_whitespace() {
        let Ok(pid) = word.parse::<u32>() else {
            continue;
        };
        if pid > 0 {
            pids.push(pid);
        }
    }
    pids
}

/// NUL-separated strings: `/proc/<pid>/environ` and `/proc/<pid>/cmdline`.
pub fn parse_nul_list(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split('\0')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

/// macOS KERN_PROCARGS2: argc, the executable path, NUL padding, argc
/// argument strings, then the environment strings, ended by an empty string.
pub fn parse_proc_args2(bytes: &[u8]) -> (Vec<String>, Vec<String>) {
    if bytes.len() < 4 {
        return (Vec::new(), Vec::new());
    }
    let argc = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    // The executable path follows argc; the argument strings start after it.
    let Some(nul) = bytes
        .iter()
        .skip(4)
        .position(|byte| *byte == 0)
        .map(|offset| offset + 4)
    else {
        return (Vec::new(), Vec::new());
    };
    let mut at = nul;
    while at < bytes.len() && bytes[at] == 0 {
        at += 1;
    }
    let mut argv = Vec::new();
    let mut index = 0;
    while index < argc && at < bytes.len() {
        let end = bytes[at..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| at + offset)
            .unwrap_or(bytes.len());
        argv.push(String::from_utf8_lossy(&bytes[at..end]).into_owned());
        at = end + 1;
        index += 1;
    }
    let mut env = Vec::new();
    while at < bytes.len() {
        let end = bytes[at..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| at + offset)
            .unwrap_or(bytes.len());
        let value = String::from_utf8_lossy(&bytes[at..end]).into_owned();
        at = end + 1;
        if value.is_empty() {
            break;
        }
        env.push(value);
    }
    (argv, env)
}

/// `/proc/<pid>/stat` past the command: state, parent, group and start ticks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxStat {
    pub state: char,
    pub ppid: u32,
    pub group: u32,
    pub ticks: String,
}

/// Parses `/proc/<pid>/stat` past the command name, which may hold spaces.
pub fn parse_linux_stat(text: &str) -> Result<LinuxStat, SupervisorError> {
    let end = text
        .rfind(')')
        .ok_or_else(|| SupervisorError::InvalidInput("invalid kernel process stat".to_owned()))?;
    if end < 1 {
        return Err(SupervisorError::InvalidInput(
            "invalid kernel process stat".to_owned(),
        ));
    }
    let fields: Vec<&str> = text[end + 1..].split_whitespace().collect();
    let field = |index: usize| {
        fields
            .get(index)
            .copied()
            .ok_or_else(|| SupervisorError::InvalidInput("invalid kernel process stat".to_owned()))
    };
    let state = field(0)?
        .chars()
        .next()
        .ok_or_else(|| SupervisorError::InvalidInput("invalid kernel process stat".to_owned()))?;
    let ppid = field(1).and_then(|value| {
        value
            .parse::<u32>()
            .map_err(|_| SupervisorError::InvalidInput("invalid kernel process stat".to_owned()))
    })?;
    let group = field(2).and_then(|value| {
        value
            .parse::<u32>()
            .map_err(|_| SupervisorError::InvalidInput("invalid kernel process stat".to_owned()))
    })?;
    let ticks = field(19)?.to_owned();
    if ticks.is_empty() || !ticks.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(SupervisorError::InvalidInput(
            "invalid kernel process stat".to_owned(),
        ));
    }
    Ok(LinuxStat {
        state,
        ppid,
        group,
        ticks,
    })
}

/// `pid` and every ancestor up to init: the processes a sweep never signals.
pub fn lineage<L: KernelListing>(pid: u32, listing: &L) -> std::collections::HashSet<u32> {
    let mut found = std::collections::HashSet::new();
    let mut next = if pid > 1 { Some(pid) } else { None };
    while let Some(current) = next {
        if !found.insert(current) {
            break;
        }
        next = listing
            .info(current)
            .map(|info| info.parent)
            .filter(|parent| *parent > 1);
    }
    found
}

/// `/proc/<pid>/cgroup` on the unified hierarchy: the `0::` line's path.
pub fn parse_cgroup_path(content: &str) -> Option<String> {
    let path = content
        .lines()
        .find(|line| line.starts_with("0::"))?
        .get(3..)?
        .trim();
    if path.starts_with('/') {
        Some(path.to_owned())
    } else {
        None
    }
}

mod linux;
pub use linux::*;

#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "macos")]
pub use darwin::{DarwinListing, children_of, darwin_info};

/// macOS unique ids: PROC_PIDUNIQIDENTIFIERINFO through libproc.
/// libproc names no struct for flavor 17 and the workspace denies unsafe,
/// so the kernel read stays on the TypeScript listing (which keeps the
/// bun:ffi flavor-17 reader); the journal stores either backend's rows.
#[cfg(target_os = "macos")]
pub fn darwin_ancestry(_pid: u32) -> Option<Ancestry> {
    None
}

/// Windows: a process's identity is its creation time. There are no groups
/// and no reparenting; the inventory records each tree's members instead.
pub struct WindowsListing<F> {
    identify: F,
}

impl<F> WindowsListing<F> {
    /// Lists through `identify`, which proves absence with `None`.
    pub fn new(identify: F) -> Self {
        Self { identify }
    }
}

impl<F: Fn(u32) -> Option<String>> KernelListing for WindowsListing<F> {
    fn platform(&self) -> &str {
        "win32"
    }

    fn all(&self) -> Vec<u32> {
        Vec::new()
    }

    fn info(&self, pid: u32) -> Option<ProcessInfo> {
        (self.identify)(pid).map(|start| ProcessInfo {
            start,
            parent: 0,
            group: pid,
            zombie: false,
        })
    }

    fn environment(&self, _pid: u32) -> Option<Vec<String>> {
        None
    }

    fn arguments(&self, _pid: u32) -> Option<Vec<String>> {
        None
    }

    fn group_members(&self, _group: u32) -> Vec<u32> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests;
