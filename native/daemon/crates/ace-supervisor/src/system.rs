// SPDX-License-Identifier: Apache-2.0
//! The production side of the crate's I/O seams: the real kernel behind
//! signals, tree walks and the inventory. Inventory group kills are not
//! sent from here: they are handed back to the shell, whose `killGroup`
//! checks kept processes, other homes and a stop's caller first.

use crate::errors::SupervisorError;
use crate::signal::{PidFdTable, SignalIo, SignalName};
use crate::tree::{LiveIdentity, TreeIo};
use crate::{identity, inventory, reaper};
use std::collections::{BTreeSet, HashMap};
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

    fn alive(&self, pid: u32) -> Result<bool, inventory::ProbeRefused> {
        match reaper::process_alive(pid) {
            Ok(alive) => Ok(alive),
            Err(SupervisorError::Unavailable(_)) => Err(inventory::ProbeRefused::Refused),
            Err(error) => Err(inventory::ProbeRefused::Failed(error.to_string())),
        }
    }

    fn group_snapshot(&self) -> GroupSnapshot {
        // A /proc that hides processes can never prove a group empty: every
        // snapshot stays incomplete, so recovery never removes a row here.
        #[cfg(target_os = "linux")]
        {
            if proc_hides_pids() {
                return GroupSnapshot {
                    groups: HashMap::new(),
                    complete: false,
                };
            }
        }
        take_group_snapshot(0)
    }

    fn leader_alive(&self, pid: u32, start: &str) -> Result<bool, inventory::ProbeRefused> {
        match identity::process_identity(pid) {
            Ok(found) => Ok(found.is_some_and(|leader| leader.start == start)),
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

/// Whether /proc is mounted with a hiding hidepid option (1, 2, 4,
/// invisible, noaccess or ptraceable), read from /proc/self/mountinfo. Such
/// a mount hides live members from every /proc walk, so no scan on this
/// system can prove a group empty. Re-read on every call, so a remount
/// that starts hiding processes is seen: the read is cheap and bounded,
/// and its callers are per recovery pass or per release confirmation.
#[cfg(target_os = "linux")]
pub fn proc_hides_pids() -> bool {
    // A mount table that cannot be read or parsed proves nothing, so the
    // answer is the conservative one: assume members may be hidden.
    let Ok(text) = std::fs::read_to_string("/proc/self/mountinfo") else {
        return true;
    };
    let mut saw_proc = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(' ').collect();
        // mount id, parent, major:minor, root, mount point, options
        if fields.len() < 6 {
            return true;
        }
        if fields[4] != "/proc" {
            continue;
        }
        saw_proc = true;
        // Mount options ride on field 5; the super options are last, past
        // the "-" separator. Either may carry hidepid.
        let options = fields[5];
        let super_options = fields.last().copied().unwrap_or("");
        for set in [options, super_options] {
            for option in set.split(',') {
                if let Some(value) = option.strip_prefix("hidepid=")
                    && matches!(
                        value,
                        "1" | "2" | "4" | "invisible" | "noaccess" | "ptraceable"
                    )
                {
                    return true;
                }
            }
        }
    }
    // No /proc entry at all: an unreadable table, not a visible one.
    !saw_proc
}

/// Whether /proc hides processes. Only Linux can, so everywhere else no.
#[cfg(not(target_os = "linux"))]
pub fn proc_hides_pids() -> bool {
    false
}

/// One process-table snapshot for a recovery or retry pass: the live
/// (non-zombie) members by group id, and whether every candidate was read.
/// A snapshot is answered per row, never re-listed per row, so a recover()
/// or retryRemovals pass costs table walks, not one per row. An unreadable
/// pid, a getpgid permission error on macOS, or a hiding /proc mount on
/// Linux, makes the snapshot incomplete, and no row is removed from an
/// incomplete snapshot.
#[derive(Debug, Clone, Default)]
pub struct GroupSnapshot {
    pub groups: HashMap<u32, BTreeSet<(u32, String)>>,
    pub complete: bool,
}

/// Three states for a recorded group against one snapshot: unknown when the
/// snapshot is incomplete (keep the row), empty or not.
pub fn group_empty_state(snapshot: &GroupSnapshot, group: u32) -> Option<bool> {
    if !snapshot.complete {
        return None;
    }
    Some(
        snapshot
            .groups
            .get(&group)
            .map(|members| members.is_empty())
            .unwrap_or(true),
    )
}

/// Every pid with room to spare: `proc_listallpids` sizes its answer,
/// then fills it, so a table that grows in between silently truncates to
/// the sized buffer. Size with headroom, and if the fill reaches the
/// buffer, grow and retry at most 3 times; a still-full buffer proves
/// nothing, so the caller marks its snapshot incomplete.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn all_pids_with_headroom() -> Option<Vec<u32>> {
    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut u32, buffersize: i32) -> i32;
    }
    let mut capacity = {
        // SAFETY: a null buffer only asks for the pid count.
        let sized = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
        // `proc_listallpids` answers the number of pids, not bytes; a zero
        // or negative answer is an error, and a snapshot from it would be
        // incomplete.
        let count = usize::try_from(sized).ok().filter(|count| *count > 0)?;
        // Room for a table that grows between the sizing and the fill.
        count.saturating_add(count / 4).saturating_add(16)
    };
    for _ in 0..3 {
        let mut pids = vec![0u32; capacity];
        let Ok(wide) = i32::try_from(capacity.checked_mul(4)?) else {
            return None;
        };
        // SAFETY: `pids` holds `capacity` u32s; the kernel fills at most
        // `wide` bytes of it, or returns an error.
        let filled = unsafe { proc_listallpids(pids.as_mut_ptr(), wide) };
        // The return value is the number of pids written.
        let Ok(count) = usize::try_from(filled) else {
            return None;
        };
        if count == 0 {
            return None;
        }
        if count < capacity {
            pids.truncate(count);
            return Some(pids);
        }
        // The buffer may have truncated the table: grow and retry.
        capacity = capacity.checked_mul(2)?;
    }
    None
}

/// One system-wide walk answering every recorded group at once.
pub fn take_group_snapshot(except: u32) -> GroupSnapshot {
    let mut groups: HashMap<u32, BTreeSet<(u32, String)>> = HashMap::new();
    let mut complete = true;
    #[cfg(target_os = "linux")]
    {
        let boot = match std::fs::read_to_string("/proc/sys/kernel/random/boot_id") {
            Ok(text) => {
                let trimmed = text.trim().to_owned();
                if trimmed.is_empty() {
                    return GroupSnapshot {
                        groups,
                        complete: false,
                    };
                }
                trimmed
            }
            Err(_) => {
                return GroupSnapshot {
                    groups,
                    complete: false,
                };
            }
        };
        let dir = match std::fs::read_dir("/proc") {
            Ok(dir) => dir,
            Err(_) => {
                return GroupSnapshot {
                    groups,
                    complete: false,
                };
            }
        };
        for entry in dir {
            let Ok(entry) = entry else {
                complete = false;
                continue;
            };
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
                Ok(stat) if stat.state != 'Z' => {
                    groups
                        .entry(stat.group)
                        .or_default()
                        .insert((pid, format!("{boot}:{}", stat.ticks)));
                }
                Ok(_) => {}
                Err(_) => {
                    complete = false;
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let candidates = match all_pids_with_headroom() {
            Some(pids) => pids,
            None => {
                return GroupSnapshot {
                    groups,
                    complete: false,
                };
            }
        };
        for pid in candidates {
            if pid == except {
                continue;
            }
            match crate::listing::darwin_info(pid) {
                Some(info) if !info.zombie => {
                    groups
                        .entry(info.group)
                        .or_default()
                        .insert((pid, info.start));
                }
                Some(_) => {}
                // Unreadable (another user's): place it by getpgid so only
                // its own group sees a member; a pid gone meanwhile is gone,
                // and an unplaceable read (permission error) fails the whole
                // snapshot, so no row is removed from it.
                None => {
                    let placed = i32::try_from(pid)
                        .ok()
                        .and_then(rustix::process::Pid::from_raw)
                        .map(|target| rustix::process::getpgid(Some(target)));
                    match placed {
                        Some(Ok(found)) => {
                            if let Ok(number) = u32::try_from(found.as_raw_nonzero().get()) {
                                groups
                                    .entry(number)
                                    .or_default()
                                    .insert((pid, String::new()));
                            } else {
                                complete = false;
                            }
                        }
                        Some(Err(rustix::io::Errno::SRCH)) => {}
                        _ => {
                            complete = false;
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = except;
    }
    GroupSnapshot { groups, complete }
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
        // libproc reads a zero-length answer (an empty group) as an error
        // whenever errno is left over from an earlier call, so an error here
        // proves nothing: list every pid instead (never empty) and keep only
        // the group's, as `darwin_info` below checks each one's group anyway.
        let candidates = match pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group }) {
            Ok(pids) => pids,
            Err(_) => pids_by_type(ProcFilter::All).ok()?,
        };
        for pid in candidates {
            if pid == except {
                continue;
            }
            match crate::listing::darwin_info(pid) {
                Some(info) if info.group == group && !info.zombie => {
                    live.insert((pid, info.start));
                }
                Some(_) => {}
                // Unreadable (another user's): its group says whether it is a
                // member at all; only an unreadable member leaves the read
                // incomplete, and a pid gone meanwhile is simply gone.
                None => match i32::try_from(pid)
                    .ok()
                    .and_then(rustix::process::Pid::from_raw)
                    .map(|target| rustix::process::getpgid(Some(target)))
                {
                    Some(Ok(found))
                        if u32::try_from(found.as_raw_nonzero().get()).ok() != Some(group) => {}
                    Some(Err(rustix::io::Errno::SRCH)) => {}
                    _ => complete = false,
                },
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

/// Whether `pid` is a zombie (`Some(true)`), alive (`Some(false)`), or gone
/// (`None`), read from the kernel's process state without waiting on it.
#[cfg(unix)]
pub fn process_zombie(pid: u32) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        // Only a vanished pid is gone; any other failure reads as present
        // (alive), so the caller looks again rather than dropping it.
        let text = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(text) => text,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error()) =>
            {
                return None;
            }
            Err(_) => return Some(false),
        };
        Some(
            crate::listing::parse_linux_stat(&text)
                .map(|stat| stat.state == 'Z')
                .unwrap_or(false),
        )
    }
    #[cfg(target_os = "macos")]
    {
        match crate::listing::darwin_info(pid) {
            Some(info) => Some(info.zombie),
            None if matches!(reaper::process_alive(pid), Ok(false)) => None,
            None => Some(false),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// Linux: the wait status a zombie leaves in `/proc/<pid>/stat` (field 52,
/// `exit_code`), read without reaping it. The kernel writes `0` there when
/// the reader may not see it, which cannot be told from a real exit 0, so a
/// zero (like an unreadable or unparsable field) is unknown: `None`.
#[cfg(target_os = "linux")]
pub fn zombie_wait_status(pid: u32) -> Option<i32> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &text[text.rfind(')')? + 2..];
    // Fields after the command start at field 3 (state); field 52 is the 50th.
    after
        .split_whitespace()
        .nth(49)?
        .parse::<i32>()
        .ok()
        .filter(|status| *status != 0)
}
