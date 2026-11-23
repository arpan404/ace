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

/// What Linux's listing reads, so tests can stand in for /proc.
pub trait ProcFs {
    /// Directory entries, or `None` when the directory cannot be read.
    fn list(&self, path: &str) -> Option<Vec<String>>;
    /// Up to `limit` bytes, or `None` when the file cannot be read.
    fn read(&self, path: &str, limit: usize) -> Option<Vec<u8>>;
}

/// Linux's listing over `proc` (the real /proc unless a test stands in).
pub struct LinuxListing<P> {
    procfs: P,
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

#[cfg(target_os = "macos")]
mod darwin {
    use super::{KernelListing, ProcessInfo};
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::pidinfo;
    use libproc::processes::{ProcFilter, pids_by_type};

    /// SZOMB in <sys/proc.h>.
    const ZOMBIE: u32 = 5;

    fn bsd(pid: u32) -> Option<BSDInfo> {
        let info: BSDInfo = pidinfo(pid as i32, 0).ok()?;
        if info.pbi_pid != pid {
            return None;
        }
        Some(info)
    }

    /// One kernel read of a macOS process: start, parent, group, state.
    pub fn darwin_info(pid: u32) -> Option<ProcessInfo> {
        let info = bsd(pid)?;
        Some(ProcessInfo {
            start: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
            parent: info.pbi_ppid,
            group: info.pbi_pgid,
            zombie: info.pbi_status == ZOMBIE,
        })
    }

    /// The macOS listing: libproc for structure, sysinfo for environments.
    pub struct DarwinListing;

    impl KernelListing for DarwinListing {
        fn platform(&self) -> &str {
            "darwin"
        }

        fn all(&self) -> Vec<u32> {
            pids_by_type(ProcFilter::All).unwrap_or_default()
        }

        fn info(&self, pid: u32) -> Option<ProcessInfo> {
            darwin_info(pid)
        }

        fn group_members(&self, group: u32) -> Vec<u32> {
            pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group }).unwrap_or_default()
        }

        fn environment(&self, pid: u32) -> Option<Vec<String>> {
            environment_of(pid)
        }

        fn arguments(&self, pid: u32) -> Option<Vec<String>> {
            arguments_of(pid)
        }

        fn has_lineage(&self) -> bool {
            false
        }
    }

    /// One sysinfo snapshot restricted to `pid`: its environment, if visible.
    fn snapshot(pid: u32) -> Option<(Vec<String>, Vec<String>)> {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new().ok()?;
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
            true,
            ProcessRefreshKind::everything(),
        );
        let process = system.process(Pid::from_u32(pid))?;
        let environ = process
            .environ()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        let cmd = process
            .cmd()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        Some((environ, cmd))
    }

    fn environment_of(pid: u32) -> Option<Vec<String>> {
        snapshot(pid).map(|(environ, _)| environ)
    }

    fn arguments_of(pid: u32) -> Option<Vec<String>> {
        snapshot(pid).map(|(_, cmd)| cmd)
    }

    /// The children of `pid`, read from the kernel's parent index.
    pub fn children_of(pid: u32) -> Vec<u32> {
        pids_by_type(ProcFilter::ByParentProcess { ppid: pid }).unwrap_or_default()
    }
}

#[cfg(target_os = "macos")]
pub use darwin::{DarwinListing, children_of};

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
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Fake {
        files: HashMap<String, Vec<u8>>,
        dirs: HashMap<String, Vec<String>>,
        table_reads: std::cell::Cell<usize>,
    }

    impl ProcFs for Fake {
        fn list(&self, path: &str) -> Option<Vec<String>> {
            if path == "/proc" {
                self.table_reads.set(self.table_reads.get() + 1);
            }
            if let Some(dirs) = self.dirs.get(path) {
                return Some(dirs.clone());
            }
            // A task directory exists for every known pid, but no kernel
            // in this test keeps per-task child lists.
            let task = path.strip_prefix("/proc/")?.strip_suffix("/task")?;
            if task.parse::<u32>().is_ok() && self.files.contains_key(&format!("/proc/{task}/stat"))
            {
                return Some(vec![task.to_owned()]);
            }
            None
        }

        fn read(&self, path: &str, _limit: usize) -> Option<Vec<u8>> {
            self.files.get(path).cloned()
        }
    }

    /// A /proc stat line for `pid` under `parent`, starting at tick `<pid>0`.
    fn fake_stat(pid: u32, parent: u32) -> String {
        format!(
            "{pid} (p) S {parent} {pid} {} {pid}0 0",
            ["0"].repeat(17).join(" ")
        )
    }

    /// A /proc with `parents` (pid to parent) and no per-task child lists.
    fn machine(parents: &[(u32, u32)]) -> LinuxListing<Fake> {
        let mut files = HashMap::new();
        files.insert(
            "/proc/sys/kernel/random/boot_id".to_owned(),
            b"0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10\n".to_vec(),
        );
        let mut names = Vec::new();
        for (pid, parent) in parents {
            files.insert(
                format!("/proc/{pid}/stat"),
                fake_stat(*pid, *parent).into_bytes(),
            );
            names.push(pid.to_string());
        }
        LinuxListing::new(Fake {
            files,
            dirs: [("/proc".to_owned(), names)].into_iter().collect(),
            table_reads: std::cell::Cell::new(0),
        })
    }

    /// Counts how often the walk read the process table.
    fn table_reads(walk: &LinuxWalk<Fake>) -> usize {
        walk.listing().procfs.table_reads.get()
    }

    #[test]
    fn child_lists_hold_space_separated_pids() {
        assert_eq!(parse_child_list("12 13  x 14\n"), vec![12, 13, 14]);
    }

    #[test]
    fn nul_lists_split_and_drop_empties() {
        assert_eq!(parse_nul_list(b"A=1\0B=2\0\0"), vec!["A=1", "B=2"]);
    }

    #[test]
    fn proc_args2_splits_argv_from_environment() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2i32.to_le_bytes());
        bytes.extend_from_slice(
            b"/usr/local/bin/codex\0\0\0\0codex\0app-server\0A=1\0ACE_PROCESS_OWNER=x\0\0junk",
        );
        assert_eq!(
            parse_proc_args2(&bytes),
            (
                vec!["codex".to_owned(), "app-server".to_owned()],
                vec!["A=1".to_owned(), "ACE_PROCESS_OWNER=x".to_owned()],
            )
        );
        // A platform binary: arguments, no environment.
        let mut short = Vec::new();
        short.extend_from_slice(&2i32.to_le_bytes());
        short.extend_from_slice(b"/bin/sleep\0/bin/sleep\x0030\0");
        assert!(parse_proc_args2(&short).1.is_empty());
        assert_eq!(parse_proc_args2(&[0, 0]), (Vec::new(), Vec::new()));
    }

    #[test]
    fn linux_stat_parses_state_parent_group_and_ticks() {
        let fields: Vec<String> = (0..19).map(|index| index.to_string()).collect();
        let text = format!("42 (a (weird) name) Z 7 42 {} 99 1", fields.join(" "));
        assert_eq!(
            parse_linux_stat(&text),
            Ok(LinuxStat {
                state: 'Z',
                ppid: 7,
                group: 42,
                ticks: "16".to_owned(),
            })
        );
        assert!(parse_linux_stat("42 (short) S 1").is_err());
    }

    #[test]
    fn cgroup_paths_keep_only_unified_hierarchy_entries() {
        assert_eq!(
            parse_cgroup_path("0::/user.slice/user@1000.service/app.slice/ace-next.service\n"),
            Some("/user.slice/user@1000.service/app.slice/ace-next.service".to_owned())
        );
        assert_eq!(parse_cgroup_path("12:pids:/legacy\n"), None);
    }

    #[test]
    fn linux_walk_without_child_lists_reads_the_table_once() {
        let mut parents: Vec<(u32, u32)> = vec![(100, 1)];
        for pid in 101..=160 {
            parents.push((pid, pid - 1));
        }
        for pid in 900..1000 {
            parents.push((pid, 1));
        }
        let listing = machine(&parents);
        let walk = LinuxWalk::new(listing);
        let mut found = Vec::new();
        let mut queue = vec![100u32];
        while let Some(next) = queue.pop() {
            for child in walk.children(next) {
                found.push(child);
                queue.push(child);
            }
        }
        found.sort_unstable();
        assert_eq!(found, (101..=160).collect::<Vec<_>>());
        assert_eq!(table_reads(&walk), 1);
    }

    #[test]
    fn windows_identity_is_creation_time() {
        let listing =
            WindowsListing::new(|pid| (pid == 42).then(|| "133700000000000000".to_owned()));
        assert_eq!(
            listing.info(42),
            Some(ProcessInfo {
                start: "133700000000000000".to_owned(),
                parent: 0,
                group: 42,
                zombie: false,
            })
        );
        assert_eq!(listing.info(43), None);
    }
}
