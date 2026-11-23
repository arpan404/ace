// SPDX-License-Identifier: Apache-2.0
//! The production side of the crate's I/O seams: the real kernel behind
//! signals, tree walks and the inventory. Inventory group kills are not
//! sent from here: they are handed back to the shell, whose `killGroup`
//! checks kept processes, other homes and a stop's caller first.

use crate::errors::SupervisorError;
use crate::signal::{PidFdTable, SignalIo, SignalName};
use crate::tree::{LiveIdentity, TreeIo};
use crate::{identity, inventory, reaper};
use std::collections::BTreeSet;
use std::sync::Mutex;

/// Signals by pid through the kernel, with Linux pidfds.
pub struct SystemSignalIo;

impl SignalIo for SystemSignalIo {
    fn start(&self, pid: u32) -> Option<String> {
        identity::process_identity(pid)
            .unwrap_or(None)
            .map(|identity| identity.start)
    }

    #[cfg(unix)]
    fn kill(&self, pid: u32, signal: SignalName) -> bool {
        let Some(target) = i32::try_from(pid)
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

    /// Member signals are POSIX; Windows trees stop through the job and
    /// `wintree.rs`, so nothing is signalled here.
    #[cfg(not(unix))]
    fn kill(&self, _pid: u32, _signal: SignalName) -> bool {
        false
    }

    fn pidfds(&self) -> Option<&dyn PidFdTable> {
        #[cfg(target_os = "linux")]
        {
            static PIDFDS: crate::signal::SystemPidFds = crate::signal::SystemPidFds;
            Some(&PIDFDS)
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }
}

/// Trees by parent pid: one `/proc` walk on Linux, libproc on macOS.
pub struct SystemTree {
    #[cfg(target_os = "linux")]
    walk: Mutex<crate::listing::LinuxWalk<crate::listing::SystemProcFs>>,
}

impl SystemTree {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            walk: Mutex::new(crate::listing::LinuxWalk::new(
                crate::listing::LinuxListing::new(crate::listing::SystemProcFs),
            )),
        }
    }
}

impl Default for SystemTree {
    fn default() -> Self {
        Self::new()
    }
}

impl TreeIo for SystemTree {
    fn platform(&self) -> &str {
        if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else {
            "other"
        }
    }

    fn children(&self, pid: u32) -> Vec<u32> {
        #[cfg(target_os = "linux")]
        {
            self.walk
                .lock()
                .map(|walk| walk.children(pid))
                .unwrap_or_default()
        }
        #[cfg(target_os = "macos")]
        {
            crate::listing::children_of(pid)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = pid;
            Vec::new()
        }
    }

    fn identity(&self, pid: u32) -> Option<LiveIdentity> {
        #[cfg(target_os = "linux")]
        let info = self.walk.lock().ok()?.info(pid)?;
        #[cfg(target_os = "macos")]
        let info = crate::listing::darwin_info(pid)?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            if info.zombie {
                return None;
            }
            Some(LiveIdentity {
                start: info.start,
                parent: info.parent,
                group: info.group,
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = pid;
            None
        }
    }

    fn kill(&self, pid: u32, signal: SignalName) -> bool {
        SystemSignalIo.kill(pid, signal)
    }

    fn pidfds(&self) -> Option<&dyn PidFdTable> {
        SystemSignalIo.pidfds()
    }

    fn wait_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// The inventory's kernel, clock and owner. A recovery's verified group
/// kills are collected for the shell to send through its guard.
pub struct SystemInventoryRuntime {
    owner: u32,
    kills: Mutex<Vec<(u32, String)>>,
}

impl SystemInventoryRuntime {
    pub fn new(owner: u32) -> Self {
        Self {
            owner,
            kills: Mutex::new(Vec::new()),
        }
    }

    /// The groups a recovery verified (with their leaders' starts) that the
    /// shell must now end.
    pub fn take_kills(&self) -> Vec<(u32, String)> {
        self.kills
            .lock()
            .map(|mut kills| std::mem::take(&mut *kills))
            .unwrap_or_default()
    }
}

impl inventory::InventoryRuntime for SystemInventoryRuntime {
    fn identity(&self, pid: u32) -> Result<Option<identity::ProcessIdentity>, SupervisorError> {
        identity::process_identity(pid)
    }

    fn child_exited(&self, pid: u32) -> bool {
        reaper::child_has_exited(pid)
    }

    fn alive(&self, group: u32) -> Result<bool, inventory::ProbeRefused> {
        match reaper::process_group_alive(group) {
            Ok(alive) => Ok(alive),
            Err(SupervisorError::Unavailable(_)) => Err(inventory::ProbeRefused::Refused),
            Err(error) => Err(inventory::ProbeRefused::Failed(error.to_string())),
        }
    }

    fn kill(&self, group: u32, start: &str) {
        if let Ok(mut kills) = self.kills.lock() {
            kills.push((group, start.to_owned()));
        }
    }

    fn owner_pid(&self) -> u32 {
        self.owner
    }

    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}

/// The live (non-zombie) members of process group `group` other than
/// `except`, by pid and start; `None` when some candidate could not be read
/// (it may be a member), so a group is never taken for empty on missing
/// evidence. A process that vanished is gone, not unreadable. Linux reads
/// each `/proc/<pid>/stat` and filters by group; macOS lists the group.
pub fn group_live_members(group: u32, except: u32) -> Option<BTreeSet<(u32, String)>> {
    let (live, complete) = scan_group(group, except);
    complete.then_some(live)
}

/// One scan of `group`: the members read, and whether every candidate was.
fn scan_group(group: u32, except: u32) -> (BTreeSet<(u32, String)>, bool) {
    let mut live = BTreeSet::new();
    let complete = scan_group_into(group, except, &mut live).is_some();
    (live, complete)
}

fn scan_group_into(group: u32, except: u32, live: &mut BTreeSet<(u32, String)>) -> Option<()> {
    #[cfg(target_os = "linux")]
    {
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let boot = boot.trim();
        let mut complete = true;
        for entry in std::fs::read_dir("/proc").ok()? {
            let entry = entry.ok()?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if pid == except {
                continue;
            }
            let text = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(text) => text,
                // Exited between the listing and the read: gone.
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error()) =>
                {
                    continue;
                }
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            match crate::listing::parse_linux_stat(&text) {
                Ok(stat) if stat.group == group && stat.state != 'Z' => {
                    live.insert((pid, format!("{boot}:{}", stat.ticks)));
                }
                Ok(_) => {}
                Err(_) => complete = false,
            }
        }
        complete.then_some(())
    }
    #[cfg(target_os = "macos")]
    {
        use libproc::processes::{ProcFilter, pids_by_type};
        let mut complete = true;
        for pid in pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group }).ok()? {
            if pid == except {
                continue;
            }
            match crate::listing::darwin_info(pid) {
                Some(info) if info.group == group && !info.zombie => {
                    live.insert((pid, info.start));
                }
                Some(_) => {}
                // Unreadable: gone only if the kernel says so.
                None if matches!(reaper::process_alive(pid), Ok(false)) => {}
                None => complete = false,
            }
        }
        complete.then_some(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (group, except, live);
        Some(())
    }
}

/// The group's live members and the leader's tree, by pid and start: what
/// a stop may signal one by one once the group number may no longer be.
pub fn capture_group(group: u32) -> BTreeSet<(u32, String)> {
    let (mut found, _) = scan_group(group, 0);
    let tree = crate::tree::capture_tree(&[group], &SystemTree::new(), crate::tree::CAPTURE_LIMIT);
    for member in tree.members {
        found.insert((member.pid, member.start));
    }
    found
}

/// Recorded members still running (same pid and start), plus the children
/// their parent links prove they started since.
pub fn live_with_children(known: &BTreeSet<(u32, String)>) -> Vec<crate::signal::TreeRef> {
    use crate::signal::TreeRef;
    use crate::tree::{CAPTURE_LIMIT, capture_tree, live_members};
    let io = SystemTree::new();
    let recorded: Vec<TreeRef> = known
        .iter()
        .map(|(pid, start)| TreeRef {
            pid: *pid,
            start: start.clone(),
        })
        .collect();
    let alive = live_members(&recorded, &io);
    let roots: Vec<u32> = alive.iter().map(|member| member.pid).collect();
    let mut all: BTreeSet<(u32, String)> = alive
        .into_iter()
        .map(|member| (member.pid, member.start))
        .collect();
    for member in capture_tree(&roots, &io, CAPTURE_LIMIT).members {
        all.insert((member.pid, member.start));
    }
    let candidates: Vec<TreeRef> = all
        .into_iter()
        .map(|(pid, start)| TreeRef { pid, start })
        .collect();
    live_members(&candidates, &io)
}

/// The members a stop may signal one by one in a group this supervisor
/// does not hold: the group and the leader's tree, read while its leader is
/// verified alive with `start` (leading `group`) both before and after the
/// read; if the pin changed in between, the read may be another group's and
/// is discarded. Otherwise none, since the group id may be someone else's.
pub fn verified_group_members(group: u32, start: &str) -> Vec<crate::signal::TreeRef> {
    let pinned = || {
        identity::process_identity(group)
            .ok()
            .flatten()
            .is_some_and(|leader| leader.start == start && leader.group == group)
    };
    if !pinned() {
        return Vec::new();
    }
    let found = capture_group(group);
    if !pinned() {
        return Vec::new();
    }
    found
        .into_iter()
        .map(|(pid, start)| crate::signal::TreeRef { pid, start })
        .collect()
}
