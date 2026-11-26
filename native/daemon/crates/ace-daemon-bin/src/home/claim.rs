// SPDX-License-Identifier: Apache-2.0
//! Claiming a home before a fresh start (`packages/service/src/home-claim.ts`): the
//! old home's daemon lock, held across the rename so no daemon can take it in
//! between. A home whose lock a live daemon holds is refused with `LiveHomeError`
//! and nothing moves; a crashed daemon's kernel lock is gone, so it never blocks.
//!
//! TypeScript cases ported: `packages/service/src/home-fresh-start.process.test.ts`
//! ("a live home is never renamed", "a crashed old daemon's leftover lock does not
//! block the fresh start") and `home-format.ts`'s two refusal messages.

use std::path::{Path, PathBuf};

use ace_store::Connection;

use super::HomeError;

/// A home's lock, held from the claim until the rename finishes.
pub struct Claim {
    connection: Option<std::sync::Arc<Connection>>,
}

impl Claim {
    /// `release()`: roll back and close, which frees the kernel lock.
    pub fn release(mut self) {
        self.release_inner();
    }

    fn release_inner(&mut self) {
        if let Some(connection) = self.connection.take() {
            let _ = connection.exec("ROLLBACK");
            let _ = connection.close();
        }
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.release_inner();
    }
}

/// `claimHome`: the old home's daemon lock, or the refusal naming its live daemon.
pub fn claim(root: &Path) -> Result<Claim, HomeError> {
    let database = root.join("daemon-lock.sqlite");
    // Opening never creates a lock database in the old home.
    let exists = std::fs::symlink_metadata(&database)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    if exists {
        match Connection::open(
            &database.to_string_lossy(),
            ace_store::OpenOptions::default(),
        ) {
            Ok(connection) => {
                match connection.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE") {
                    Ok(()) => {
                        return Ok(Claim {
                            connection: Some(connection),
                        });
                    }
                    Err(error) => {
                        let _ = connection.close();
                        if crate::store::sqlite_busy(&error) {
                            return Err(HomeError::live(root, lock_owner(root)));
                        }
                        // Not a lock database this build knows: the pid decides.
                    }
                }
            }
            Err(_) => {
                // The database is unreadable; the pid below still decides.
            }
        }
    }
    let pid = lock_owner(root);
    if let Some(pid) = pid
        && pid != std::process::id() as i64
        && alive(pid)
    {
        return Err(HomeError::live(root, Some(pid)));
    }
    // An older ace keeps no lock database: what it has open, or the pid files it
    // published, prove it is using the home (`home-claim.ts:83`).
    if !exists {
        let files = live_files(root);
        let running = recorded_pids(&files)
            .into_iter()
            .filter(|pid| *pid != std::process::id() as i64 && alive(*pid))
            .chain(
                openers(&files)
                    .into_iter()
                    .filter(|pid| *pid != std::process::id() as i64),
            )
            .next();
        if let Some(pid) = running {
            return Err(HomeError::live_old(root, pid));
        }
    }
    Ok(Claim { connection: None })
}

/// The pid in `<home>/daemon-lock`, when it holds one.
/// The files under `root`, two levels deep, that a running ace keeps open
/// (`liveFiles`): databases, journals, sockets, pid and lock files.
pub fn live_files(root: &Path) -> Vec<PathBuf> {
    const SKIPPED: [&str; 3] = ["worktrees", "node_modules", "releases"];
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0_u8)];
    while let Some((directory, depth)) = pending.first().cloned() {
        pending.remove(0);
        if files.len() >= 256 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = directory.join(entry.file_name());
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if depth < 2 && !SKIPPED.contains(&name.as_str()) {
                    pending.push((path, depth + 1));
                }
            } else if is_live(&entry.file_name().to_string_lossy()) && files.len() < 256 {
                files.push(path);
            }
        }
    }
    files
}

fn is_live(name: &str) -> bool {
    [".sqlite", ".db", ".sock", ".socket", ".pid", ".lock"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || [".sqlite-wal", ".sqlite-shm", ".db-wal"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

/// Pids recorded in `*.pid` files (`recordedPids`).
fn recorded_pids(files: &[PathBuf]) -> Vec<i64> {
    let mut pids = Vec::new();
    for file in files {
        if file.extension().and_then(|extension| extension.to_str()) != Some("pid") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(file)
            && let Ok(pid) = text.get(..32).unwrap_or(&text).trim().parse::<i64>()
            && pid > 0
        {
            pids.push(pid);
        }
    }
    pids
}

/// Which processes hold any of `files` open (`systemOpeners`): Linux reads
/// `/proc/*/fd`; elsewhere lsof is asked about these files only.
fn openers(files: &[PathBuf]) -> Vec<i64> {
    if files.is_empty() {
        return Vec::new();
    }
    #[cfg(target_os = "linux")]
    {
        let mut pids = Vec::new();
        let mut descriptors = 0_u32;
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return pids;
        };
        for entry in entries.flatten().take(16_384) {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i64>() else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                descriptors += 1;
                if descriptors > 65_536 {
                    return pids;
                }
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                if files.iter().any(|file| file == &target) {
                    pids.push(pid);
                    break;
                }
            }
        }
        return pids;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = std::process::Command::new("lsof")
            .arg("-t")
            .arg("--")
            .args(files)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<i64>().ok())
            .filter(|pid| *pid > 0)
            .collect()
    }
}


fn lock_owner(root: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(root.join("daemon-lock")).ok()?;
    let value: serde_json::Value = serde_json::from_str(text.get(..256).unwrap_or(&text)).ok()?;
    value.get("pid").and_then(serde_json::Value::as_i64)
}

/// `processAlive`: a process that exists, even one this user may not signal.
fn alive(pid: i64) -> bool {
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    let Some(pid) = rustix::process::Pid::from_raw(pid.cast_signed()) else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == rustix::io::Errno::PERM,
    }
}

/// `home-format.ts`'s `LiveHomeError` message, word for word.
pub fn live_message(home: &Path, pid: Option<i64>) -> String {
    format!(
        "The ace data in {} needs a fresh start, but an older ace daemon{} is still using it. Quit that ace (or run its `ace stop`), then open ace again. Nothing was moved.",
        home.display(),
        pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
    )
}
