// SPDX-License-Identifier: Apache-2.0

//! The scratch directory beside the index: `sqlite-read-<pid>-*` snapshot stages and
//! `history-plan-<pid>-*` work directories.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cancel::Cancel;
use crate::error::{Error, Result, io_at};
use crate::options::SnapshotLimits;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
const PREFIXES: [&str; 3] = ["sqlite-read-", "history-plan-", "storage-order-"];

#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub max_copy_bytes: u64,
    pub min_free_bytes: u64,
    pub min_free_ratio: f64,
}

impl Policy {
    pub fn from_limits(limits: Option<&SnapshotLimits>) -> Policy {
        let limits = limits.cloned().unwrap_or_default();
        Policy {
            max_copy_bytes: limits.max_copy_bytes.unwrap_or(4 * 1024 * 1024 * 1024),
            min_free_bytes: limits.min_free_bytes.unwrap_or(5 * 1024 * 1024 * 1024),
            min_free_ratio: limits.min_free_ratio.unwrap_or(0.02),
        }
    }
}

fn size_text(bytes: f64) -> String {
    if bytes >= GIB {
        format!("{:.1} GB", bytes / GIB)
    } else {
        format!("{} MB", (bytes / (1024.0 * 1024.0)).ceil())
    }
}

fn alive(pid: i32) -> bool {
    crate::setup::process_alive(pid)
}

/// The lock file a live owner holds in each of its directories. The operating system releases it
/// when the owner exits, however it exits, so a directory whose lock can be taken has no owner,
/// whatever its pid now names (Windows reuses pids quickly, and a pid check alone can keep a dead
/// reader's multi-gigabyte snapshot forever).
const OWNER_LOCK: &str = "owner.lock";

fn hold(dir: &Path) -> Result<std::fs::File> {
    let path = dir.join(OWNER_LOCK);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| io_at(e, &path))?;
    file.try_lock()
        .map_err(|e| Error::message(format!("Could not lock {}: {e}", path.display())))?;
    Ok(file)
}

/// Whether the directory is still owned: by its lock where it has one, else by its pid, as a
/// directory made before locks were is.
fn owned(dir: &Path, name: &str, me: i32) -> bool {
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join(OWNER_LOCK))
    {
        Ok(file) => matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        Err(_) => owner(name).is_some_and(|pid| pid != me && alive(pid)),
    }
}

fn owner(name: &str) -> Option<i32> {
    let rest = PREFIXES.iter().find_map(|p| name.strip_prefix(p))?;
    let (pid, _) = rest.split_once('-')?;
    pid.parse().ok()
}

pub struct SnapshotScratch {
    pub root: PathBuf,
    policy: Policy,
    pid: i32,
    held: bool,
}

/// A private work directory, removed when dropped (or by the next start's sweep after a crash).
pub struct WorkDir {
    dir: Option<tempfile::TempDir>,
    lock: Option<std::fs::File>,
}

impl WorkDir {
    pub fn path(&self) -> &Path {
        self.dir.as_ref().map_or(Path::new(""), |d| d.path())
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        // Unlocked and closed first: Windows cannot remove a folder holding an open file.
        drop(self.lock.take());
        if let Some(dir) = self.dir.take() {
            let _ = dir.close();
        }
    }
}

/// The one snapshot stage; released by [`SnapshotScratch::release`].
pub struct Stage {
    pub dir: PathBuf,
    lock: Option<std::fs::File>,
}

impl SnapshotScratch {
    pub fn new(root: PathBuf, policy: Policy) -> SnapshotScratch {
        SnapshotScratch {
            root,
            policy,
            pid: std::process::id() as i32,
            held: false,
        }
    }

    /// Remove stages and work directories left by dead processes. Only before this reader made any.
    pub fn sweep(&self) -> Result<usize> {
        self.sweep_prefixes(&PREFIXES)
    }

    fn sweep_prefixes(&self, prefixes: &[&str]) -> Result<usize> {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(io_at(error, &self.root)),
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !prefixes.iter().any(|p| name.starts_with(p)) {
                continue;
            }
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if owned(&entry.path(), &name, self.pid) {
                continue;
            }
            let _ = std::fs::remove_dir_all(entry.path());
            removed += 1;
        }
        Ok(removed)
    }

    pub fn work_dir(&self, kind: &str) -> Result<WorkDir> {
        let dir = tempfile::Builder::new()
            .prefix(&format!("{kind}-{}-", self.pid))
            .tempdir_in(&self.root)
            .map_err(|e| io_at(e, &self.root))?;
        let lock = hold(dir.path())?;
        Ok(WorkDir {
            dir: Some(dir),
            lock: Some(lock),
        })
    }

    pub fn acquire(&mut self, cancel: &Cancel) -> Result<Stage> {
        cancel.check()?;
        if self.held {
            return Err(Error::message(super::BUSY));
        }
        self.sweep_prefixes(&["sqlite-read-"])?;
        cancel.check()?;
        let dir = tempfile::Builder::new()
            .prefix(&format!("sqlite-read-{}-", self.pid))
            .tempdir_in(&self.root)
            .map_err(|e| io_at(e, &self.root))?
            .keep();
        let lock = match hold(&dir) {
            Ok(lock) => lock,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(error);
            }
        };
        crate::hooks::snapshot(&dir);
        self.held = true;
        Ok(Stage {
            dir,
            lock: Some(lock),
        })
    }

    pub fn release(&mut self, mut stage: Stage) {
        drop(stage.lock.take());
        let _ = std::fs::remove_dir_all(&stage.dir);
        self.held = false;
    }

    /// Refuse before writing when a copy is over the cap or would starve the disk.
    pub fn reserve(&self, bytes: u64) -> Result<()> {
        if bytes > self.policy.max_copy_bytes {
            return Err(Error::message(format!(
                "Saved history skipped a provider database: reading it needs {} of scratch space, above the {} snapshot limit",
                size_text(bytes as f64),
                size_text(self.policy.max_copy_bytes as f64)
            )));
        }
        let available = fs4::available_space(&self.root).map_err(|e| io_at(e, &self.root))? as f64;
        let total = fs4::total_space(&self.root).map_err(|e| io_at(e, &self.root))? as f64;
        let margin = (self.policy.min_free_bytes as f64).max(self.policy.min_free_ratio * total);
        if available - (bytes as f64) < margin {
            return Err(Error::message(format!(
                "Saved history skipped a provider database: reading it needs {} of scratch space and would leave less than {} free",
                size_text(bytes as f64),
                size_text(margin)
            )));
        }
        Ok(())
    }

    /// A copy-on-write clone, where the filesystem allows one. False otherwise.
    pub fn clone_file(&self, source: &Path, target: &Path) -> bool {
        let command = if cfg!(target_os = "macos") {
            Some((
                "/bin/cp",
                vec![
                    "-c".into(),
                    source.as_os_str().to_owned(),
                    target.as_os_str().to_owned(),
                ],
            ))
        } else if cfg!(target_os = "linux") {
            Some((
                "cp",
                vec![
                    "--reflink=always".into(),
                    source.as_os_str().to_owned(),
                    target.as_os_str().to_owned(),
                ],
            ))
        } else {
            None
        };
        let Some((program, args)) = command else {
            return false;
        };
        let Ok(mut child) = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let started = Instant::now();
        let ok = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if started.elapsed() < Duration::from_secs(60) => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        // A failed clone may leave an empty target; the streamed copy recreates it exclusively.
        if !ok {
            let _ = std::fs::remove_file(target);
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn scratch(root: &Path) -> SnapshotScratch {
        SnapshotScratch::new(root.to_owned(), Policy::from_limits(None))
    }

    #[test]
    fn a_directory_whose_owner_lock_is_free_is_swept_whatever_pid_it_names() {
        let root = tempfile::tempdir().unwrap();
        // The pid of this very process: alive, as a reused pid would be.
        let me = std::process::id();
        let dir = root.path().join(format!("sqlite-read-{me}-Ab12Cd"));
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join(OWNER_LOCK), "").unwrap();
        std::fs::write(dir.join("snapshot.sqlite"), "big").unwrap();
        let mut other = scratch(root.path());
        other.pid = -1;
        assert_eq!(other.sweep().unwrap(), 1);
        assert!(!dir.exists());
    }

    #[test]
    fn a_directory_whose_owner_holds_its_lock_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let held = scratch(root.path()).work_dir("history-plan").unwrap();
        let mut other = scratch(root.path());
        other.pid = -1;
        assert_eq!(other.sweep().unwrap(), 0);
        assert!(held.path().exists());
        let path = held.path().to_owned();
        drop(held);
        assert!(!path.exists());
    }
}
