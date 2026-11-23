// SPDX-License-Identifier: Apache-2.0
//! Ending processes in an exclusive private directory: a re-check of the
//! directory lease before signalling, then a wait for kernel termination.
//! Ports `directory-processes.ts`. Only for exclusive operation
//! directories, never a user workspace.

use crate::errors::SupervisorError;

/// The most processes one pass inspects, and the most one stop ends.
pub const DIRECTORY_SCAN_LIMIT: usize = 16_384;
pub const DIRECTORY_KILL_LIMIT: usize = 64;

/// What the sweep reads: one process's current directory, and whether it is gone.
pub trait DirectoryIo {
    /// Every candidate pid, in scan order.
    fn candidates(&self) -> Vec<u32>;
    /// The process's current directory, or `None` once it is gone.
    fn cwd(&self, pid: u32) -> Option<String>;
    /// Whether `pid` is a zombie (a zombie needs no signal).
    fn is_zombie(&self, pid: u32) -> bool;
    /// Ends the process; absence is not a failure.
    fn kill(&self, pid: u32);
}

/// Whether `cwd` sits inside one of `roots`: the lease the sweep re-checks.
pub fn within_lease(cwd: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| {
        if cwd == root {
            return true;
        }
        cwd.strip_prefix(root.as_str())
            .is_some_and(|rest| rest.starts_with('/') && !rest.contains(".."))
    })
}

/// Pids in `directories`, re-checked against `selected` before signalling.
pub fn directory_pids<I: DirectoryIo>(
    io: &I,
    directories: &[String],
    selected: Option<&[u32]>,
) -> Result<Vec<u32>, SupervisorError> {
    let roots: Vec<String> = directories.to_vec();
    if let Some(selected) = selected {
        return Ok(selected
            .iter()
            .copied()
            .filter(|pid| io.cwd(*pid).is_some_and(|cwd| within_lease(&cwd, &roots)))
            .collect());
    }
    let candidates = io.candidates();
    if candidates.len() > DIRECTORY_SCAN_LIMIT {
        return Err(SupervisorError::Limit(
            "Process inspection exceeds limit".to_owned(),
        ));
    }
    let mut found = Vec::new();
    for pid in candidates {
        if found.len() >= DIRECTORY_KILL_LIMIT {
            break;
        }
        if io.cwd(pid).is_some_and(|cwd| within_lease(&cwd, &roots)) {
            found.push(pid);
        }
    }
    Ok(found)
}

/// Ends everything in `directories`: re-checks the lease before signalling,
/// then waits for kernel termination. Never ends `self_pid`.
pub fn terminate_directory_processes<I: DirectoryIo>(    io: &I,
    directories: &[String],
    self_pid: u32,
    sleep_ms: &dyn Fn(u64),
) -> Result<(), SupervisorError> {
    for _ in 0..64 {
        let selected: Vec<u32> = directory_pids(io, directories, None)?
            .into_iter()
            .filter(|pid| *pid != self_pid)
            .collect();
        if selected.is_empty() {
            return Ok(());
        }
        let confirmed = directory_pids(io, directories, Some(&selected))?;
        for pid in &confirmed {
            io.kill(*pid);
        }
        if confirmed.is_empty() {
            return Ok(());
        }
        // Zombies report without waiting for the OS orphan reaper.
        for _ in 0..64 {
            if confirmed
                .iter()
                .all(|pid| io.is_zombie(*pid) || io.cwd(*pid).is_none())
            {
                break;
            }
            sleep_ms(0);
        }
        if confirmed
            .iter()
            .all(|pid| io.is_zombie(*pid) || io.cwd(*pid).is_none())
        {
            continue;
        }
        return Err(SupervisorError::Operation(
            "Owned processes did not terminate".to_owned(),
        ));
    }
    Err(SupervisorError::Limit("Owned process limit".to_owned()))
}

/// The real directory reader: /proc on Linux, lsof elsewhere.
pub struct SystemDirectoryIo {
    self_pid: u32,
}

impl SystemDirectoryIo {
    /// Reads as `self_pid`, which the sweep never ends.
    pub fn new(self_pid: u32) -> Self {
        Self { self_pid }
    }

    /// This process's pid, for the sweep's own exclusion.
    pub fn self_pid(&self) -> u32 {
        self.self_pid
    }
}

#[cfg(target_os = "linux")]
impl DirectoryIo for SystemDirectoryIo {
    fn candidates(&self) -> Vec<u32> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
            .filter(|pid| *pid > 0)
            .collect()
    }

    fn cwd(&self, pid: u32) -> Option<String> {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn is_zombie(&self, pid: u32) -> bool {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        crate::listing::parse_linux_stat(&text).map(|stat| stat.state == 'Z').unwrap_or(false)
    }

    fn kill(&self, pid: u32) {
        // The sweep signals by kill; absence is not a failure.
        use rustix::process::Pid;
        if let Ok(raw) = i32::try_from(pid)
            && let Some(target) = Pid::from_raw(raw)
        {
            let _ = rustix::process::kill_process(target, rustix::process::Signal::KILL);
        }
    }
}

/// macOS and others: lsof for the lease, libproc for zombies.
#[cfg(not(target_os = "linux"))]
impl DirectoryIo for SystemDirectoryIo {
    fn candidates(&self) -> Vec<u32> {
        // Without /proc there is no cheap table; the sweep below selects by
        // re-checking, so an empty candidate list only narrows the first pass.
        lsof_cwd_pids(None)
            .into_iter()
            .map(|(pid, _)| pid)
            .collect()
    }

    fn cwd(&self, pid: u32) -> Option<String> {
        lsof_cwd_pids(Some(pid)).first().and_then(|found| {
            if found.0 == pid {
                Some(found.1.clone())
            } else {
                None
            }
        })
    }

    fn is_zombie(&self, pid: u32) -> bool {
        #[cfg(target_os = "macos")]
        {
            crate::listing::darwin_info(pid).map(|info| info.zombie).unwrap_or(false)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = pid;
            false
        }
    }

    fn kill(&self, pid: u32) {
        #[cfg(unix)]
        {
            use rustix::process::Pid;
            if let Ok(raw) = i32::try_from(pid)
                && let Some(target) = Pid::from_raw(raw)
            {
                let _ = rustix::process::kill_process(target, rustix::process::Signal::KILL);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
    }
}

/// Pids holding a cwd, from lsof: `(pid, cwd)` pairs, at most 64.
#[cfg(not(target_os = "linux"))]
fn lsof_cwd_pids(selected: Option<u32>) -> Vec<(u32, String)> {
    let mut command = std::process::Command::new("/usr/sbin/lsof");
    command.args(["-n", "-P", "-a", "-d", "cwd", "-F0pn"]);
    if let Some(pid) = selected {
        command.args(["-p", &pid.to_string()]);
    }
    let output = command.output().ok();
    let Some(output) = output.filter(|output| output.status.success() || output.status.code() == Some(1)) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut found = Vec::new();
    let mut pid = 0u32;
    for record in text.split('\0') {
        let field = record.strip_prefix('\n').unwrap_or(record);
        if let Some(number) = field.strip_prefix('p') {
            if let Ok(parsed) = number.parse::<u32>() {
                pid = parsed;
            }
            continue;
        }
        if let Some(cwd) = field.strip_prefix('n')
            && pid > 0
            && found.len() < 64
        {
            found.push((pid, cwd.to_owned()));
        }
    }
    found
}

#[cfg(test)]
mod tests {    use super::*;
    use std::collections::HashMap;

    struct Fake {
        cwd: HashMap<u32, String>,
        zombies: Vec<u32>,
    }

    impl DirectoryIo for Fake {
        fn candidates(&self) -> Vec<u32> {
            let mut pids: Vec<u32> = self.cwd.keys().copied().collect();
            pids.sort_unstable();
            pids
        }

        fn cwd(&self, pid: u32) -> Option<String> {
            self.cwd.get(&pid).cloned()
        }

        fn is_zombie(&self, pid: u32) -> bool {
            self.zombies.contains(&pid)
        }

        fn kill(&self, _pid: u32) {}
    }

    #[test]
    fn lease_matches_only_paths_below_a_root() {
        let roots = vec!["/lease".to_owned()];
        assert!(within_lease("/lease", &roots));
        assert!(within_lease("/lease/work", &roots));
        assert!(!within_lease("/lease-other", &roots));
        assert!(!within_lease("/other", &roots));
        assert!(!within_lease("/lease/../other", &roots));
    }

    #[test]
    fn sweep_finds_only_leased_processes() {
        let io = Fake {
            cwd: [(10, "/lease/a"), (20, "/other"), (1, "/lease")]
                .into_iter()
                .map(|(pid, cwd)| (pid, cwd.to_owned()))
                .collect(),
            zombies: Vec::new(),
        };
        assert_eq!(
            directory_pids(&io, &["/lease".to_owned()], None).expect("sweeps"),
            vec![1, 10]
        );
        assert_eq!(
            directory_pids(&io, &["/lease".to_owned()], Some(&[10, 20, 30])).expect("sweeps"),
            vec![10]
        );
    }

    #[test]
    fn sweep_caps_what_one_stop_ends() {
        let io = Fake {
            cwd: (2..200u32).map(|pid| (pid, "/lease".to_owned())).collect(),
            zombies: Vec::new(),
        };
        assert_eq!(
            directory_pids(&io, &["/lease".to_owned()], None)
                .expect("sweeps")
                .len(),
            DIRECTORY_KILL_LIMIT
        );
    }
}
