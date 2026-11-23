// SPDX-License-Identifier: Apache-2.0
//! Linux listing from `/proc`: the process table, one walk's cached child
//! lists, and cgroup membership. The filesystem is injected (`ProcFs`).

use super::{
    KernelListing, LinuxStat, ProcessInfo, parse_cgroup_path, parse_child_list, parse_linux_stat,
    parse_nul_list,
};

/// What Linux's listing reads, so tests can stand in for /proc.
pub trait ProcFs {
    /// Directory entries, or `None` when the directory cannot be read.
    fn list(&self, path: &str) -> Option<Vec<String>>;
    /// Up to `limit` bytes, or `None` when the file cannot be read.
    fn read(&self, path: &str, limit: usize) -> Option<Vec<u8>>;
}

/// Linux's listing over `proc` (the real /proc unless a test stands in).
pub struct LinuxListing<P> {
    pub(super) procfs: P,
    boot: std::sync::OnceLock<Option<String>>,
}

impl<P> LinuxListing<P> {
    /// Reads from `proc` instead of the real /proc.
    pub fn new(procfs: P) -> Self {
        Self {
            procfs,
            boot: std::sync::OnceLock::new(),
        }
    }
}

impl<P: ProcFs> LinuxListing<P> {
    fn boot_id(&self) -> Option<&str> {
        self.boot
            .get_or_init(|| {
                self.procfs
                    .read("/proc/sys/kernel/random/boot_id", 64)
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .map(|text| text.trim().to_owned())
            })
            .as_deref()
    }

    fn pids(&self) -> Vec<u32> {
        self.procfs
            .list("/proc")
            .unwrap_or_default()
            .into_iter()
            .filter_map(|name| name.parse::<u32>().ok().filter(|pid| *pid > 0))
            .collect()
    }

    fn stat(&self, pid: u32) -> Option<LinuxStat> {
        let bytes = self.procfs.read(&format!("/proc/{pid}/stat"), 4_096)?;
        let text = String::from_utf8(bytes).ok()?;
        parse_linux_stat(&text).ok()
    }
}

impl<P: ProcFs + Send + Sync> KernelListing for LinuxListing<P> {
    fn platform(&self) -> &str {
        "linux"
    }

    fn all(&self) -> Vec<u32> {
        self.pids()
    }

    fn info(&self, pid: u32) -> Option<ProcessInfo> {
        let stat = self.stat(pid)?;
        let boot = self.boot_id()?;
        Some(ProcessInfo {
            start: format!("{boot}:{}", stat.ticks),
            parent: stat.ppid,
            group: stat.group,
            zombie: stat.state == 'Z',
        })
    }

    fn group_members(&self, group: u32) -> Vec<u32> {
        self.pids()
            .into_iter()
            .filter(|pid| self.stat(*pid).map(|stat| stat.group) == Some(group))
            .collect()
    }

    fn environment(&self, pid: u32) -> Option<Vec<String>> {
        let bytes = self
            .procfs
            .read(&format!("/proc/{pid}/environ"), 1_048_576)?;
        Some(parse_nul_list(&bytes))
    }

    fn arguments(&self, pid: u32) -> Option<Vec<String>> {
        let bytes = self.procfs.read(&format!("/proc/{pid}/cmdline"), 65_536)?;
        Some(parse_nul_list(&bytes))
    }
}

/// A children reader for one walk. Where the kernel keeps a per-task child
/// list it is used; otherwise the table is read once and shared by the walk.
pub struct LinuxWalk<P> {
    listing: LinuxListing<P>,
    per_task: std::cell::Cell<Option<bool>>,
    table: std::cell::RefCell<Option<std::collections::HashMap<u32, Vec<u32>>>>,
}

impl<P: ProcFs> LinuxWalk<P> {
    /// Starts a walk over `listing`, reading the table lazily.
    pub fn new(listing: LinuxListing<P>) -> Self {
        Self {
            listing,
            per_task: std::cell::Cell::new(None),
            table: std::cell::RefCell::new(None),
        }
    }

    /// The listing this walk reads.
    pub fn listing(&self) -> &LinuxListing<P> {
        &self.listing
    }

    /// One kernel read through the walk's listing.
    pub fn info(&self, pid: u32) -> Option<ProcessInfo>
    where
        P: ProcFs + Send + Sync,
    {
        use crate::listing::KernelListing as _;
        self.listing.info(pid)
    }

    /// The children of `pid` for this walk.
    pub fn children(&self, pid: u32) -> Vec<u32> {
        if self.per_task.get() == Some(false) {
            return self.cached_children(pid);
        }
        let tasks = self.listing.procfs.list(&format!("/proc/{pid}/task"));
        let Some(tasks) = tasks else {
            return Vec::new();
        };
        let mut children = Vec::new();
        let mut listed = false;
        for task in tasks {
            let Some(bytes) = self
                .listing
                .procfs
                .read(&format!("/proc/{pid}/task/{task}/children"), 65_536)
            else {
                continue;
            };
            listed = true;
            children.extend(parse_child_list(&String::from_utf8_lossy(&bytes)));
        }
        if listed {
            self.per_task.set(Some(true));
            return children;
        }
        self.per_task.set(Some(false));
        self.cached_children(pid)
    }

    fn cached_children(&self, pid: u32) -> Vec<u32> {
        let mut table = self.table.borrow_mut();
        if table.is_none() {
            let mut built: std::collections::HashMap<u32, Vec<u32>> =
                std::collections::HashMap::new();
            for child in self.listing.pids() {
                if let Some(stat) = self.listing.stat(child) {
                    built.entry(stat.ppid).or_default().push(child);
                }
            }
            *table = Some(built);
        }
        table
            .as_ref()
            .map(|built| built.get(&pid).cloned().unwrap_or_default())
            .unwrap_or_default()
    }
}

/// The real /proc.
pub struct SystemProcFs;

impl ProcFs for SystemProcFs {
    fn list(&self, path: &str) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(path).ok()?;
        let mut names = Vec::new();
        for entry in entries {
            names.push(entry.ok()?.file_name().to_string_lossy().into_owned());
        }
        Some(names)
    }

    fn read(&self, path: &str, limit: usize) -> Option<Vec<u8>> {
        let bytes = std::fs::read(path).ok()?;
        Some(bytes.into_iter().take(limit).collect())
    }
}

/// `pid`'s cgroup on the unified hierarchy, read from cgroup v2.
pub fn cgroup_of<P: ProcFs>(pid: &str, procfs: &P) -> Option<(String, String)> {
    let bytes = procfs.read(&format!("/proc/{pid}/cgroup"), 65_536)?;
    let content = String::from_utf8(bytes).ok()?;
    let path = parse_cgroup_path(&content)?;
    let unit = path.rsplit('/').next().unwrap_or("").to_owned();
    Some((path, unit))
}

/// Every process in cgroup `path`: what a service manager's unit holds.
pub fn cgroup_members<P: ProcFs>(path: &str, procfs: &P) -> Vec<u32> {
    if !path.starts_with('/') || path.contains("..") {
        return Vec::new();
    }
    let bytes = procfs
        .read(&format!("/sys/fs/cgroup{path}/cgroup.procs"), 1_048_576)
        .unwrap_or_default();
    parse_child_list(&String::from_utf8_lossy(&bytes))
}
