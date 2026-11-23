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
pub fn terminate_directory_processes<I: DirectoryIo>(
    io: &I,
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

#[cfg(test)]
mod tests {
    use super::*;
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
