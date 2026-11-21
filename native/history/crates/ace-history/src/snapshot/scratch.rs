// SPDX-License-Identifier: Apache-2.0

//! The scratch directory beside the index: `sqlite-read-<pid>-*` snapshot stages and
//! `history-plan-<pid>-*` work directories.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::claim::{Claim, Holder, LOCK_SUFFIX, claim, holder};
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

fn owner(name: &str) -> Option<i32> {
    let rest = PREFIXES.iter().find_map(|p| name.strip_prefix(p))?;
    let (pid, _) = rest.split_once('-')?;
    pid.parse().ok()
}

#[derive(Clone)]
pub struct SnapshotScratch {
    pub root: PathBuf,
    policy: Policy,
    pid: i32,
    /// Whether the one stage is taken; shared with the stage, which frees it when dropped.
    held: Arc<AtomicBool>,
}

/// A private work directory, removed when dropped (or by the next start's sweep after a crash).
pub struct WorkDir {
    claim: Claim,
}

impl WorkDir {
    pub fn path(&self) -> &Path {
        &self.claim.dir
    }
}

/// The one snapshot stage, removed and freed when dropped.
pub struct Stage {
    pub dir: PathBuf,
    _claim: Claim,
    held: Arc<AtomicBool>,
}

impl Drop for Stage {
    fn drop(&mut self) {
        self.held.store(false, Ordering::SeqCst);
    }
}

impl SnapshotScratch {
    pub fn new(root: PathBuf, policy: Policy) -> SnapshotScratch {
        SnapshotScratch {
            root,
            policy,
            pid: std::process::id() as i32,
            held: Arc::new(AtomicBool::new(false)),
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
                // A lock whose directory is gone (its owner died between the two): free it.
                if let Some(dir) = name.strip_suffix(LOCK_SUFFIX)
                    && !self.root.join(dir).exists()
                    && let Holder::Free(free) = holder(&self.root.join(dir))
                {
                    drop(free);
                }
                continue;
            }
            match holder(&entry.path()) {
                Holder::Owned => continue,
                Holder::Free(free) => {
                    let _ = std::fs::remove_dir_all(entry.path());
                    drop(free);
                }
                Holder::Unknown => {
                    if owner(&name).is_some_and(|pid| pid != self.pid && alive(pid)) {
                        continue;
                    }
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
            removed += 1;
        }
        Ok(removed)
    }

    pub fn work_dir(&self, kind: &str) -> Result<WorkDir> {
        Ok(WorkDir {
            claim: claim(&self.root, &format!("{kind}-{}-", self.pid))?,
        })
    }

    pub fn acquire(&self, cancel: &Cancel) -> Result<Stage> {
        cancel.check()?;
        if self.held.load(Ordering::SeqCst) {
            return Err(Error::message(super::BUSY));
        }
        self.sweep_prefixes(&["sqlite-read-"])?;
        cancel.check()?;
        let claimed = claim(&self.root, &format!("sqlite-read-{}-", self.pid))?;
        crate::hooks::snapshot(&claimed.dir);
        self.held.store(true, Ordering::SeqCst);
        Ok(Stage {
            dir: claimed.dir.clone(),
            _claim: claimed,
            held: self.held.clone(),
        })
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

    /// A copy-on-write clone of the open `source` at `target`, where the filesystem allows one.
    /// It clones the descriptor that was checked, never a path, so nothing swapped in after the
    /// check can be what is copied. False otherwise; the streamed copy then makes `target`.
    pub fn clone_file(&self, source: &std::fs::File, target: &Path) -> bool {
        clone_from(source, target)
    }
}

#[cfg(target_vendor = "apple")]
fn clone_from(source: &std::fs::File, target: &Path) -> bool {
    rustix::fs::fclonefileat(
        source,
        rustix::fs::CWD,
        target,
        rustix::fs::CloneFlags::empty(),
    )
    .is_ok()
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn clone_from(source: &std::fs::File, target: &Path) -> bool {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let Ok(out) = options.open(target) else {
        return false;
    };
    let ok = rustix::fs::ioctl_ficlone(&out, source).is_ok();
    drop(out);
    // A failed clone leaves an empty target; the streamed copy recreates it exclusively.
    if !ok {
        let _ = std::fs::remove_file(target);
    }
    ok
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
fn clone_from(_source: &std::fs::File, _target: &Path) -> bool {
    false
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
        std::fs::write(
            root.path().join(format!("sqlite-read-{me}-Ab12Cd.lock")),
            "",
        )
        .unwrap();
        std::fs::write(dir.join("snapshot.sqlite"), "big").unwrap();
        let mut other = scratch(root.path());
        other.pid = -1;
        assert_eq!(other.sweep().unwrap(), 1);
        assert!(!dir.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_claimed_directory_never_exists_without_its_held_lock() {
        let root = tempfile::tempdir().unwrap();
        let held = scratch(root.path()).work_dir("history-plan").unwrap();
        let mut lock = held.path().as_os_str().to_owned();
        lock.push(LOCK_SUFFIX);
        let other = std::fs::OpenOptions::new().write(true).open(&lock).unwrap();
        assert!(matches!(
            other.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_whose_lock_cannot_be_checked_is_kept() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("history-plan-1-Qw3Er4");
        std::fs::create_dir(&dir).unwrap();
        let lock = root.path().join("history-plan-1-Qw3Er4.lock");
        std::fs::write(&lock, "").unwrap();
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o000)).unwrap();
        let mut other = scratch(root.path());
        other.pid = -1;
        assert_eq!(other.sweep().unwrap(), 0);
        assert!(dir.exists());
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn a_lock_left_without_its_directory_is_swept() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("storage-order-1-Ty5Ui6.lock"), "").unwrap();
        scratch(root.path()).sweep().unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
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
