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
}

impl WorkDir {
    pub fn path(&self) -> &Path {
        self.dir.as_ref().map_or(Path::new(""), |d| d.path())
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        if let Some(dir) = self.dir.take() {
            let _ = dir.close();
        }
    }
}

/// The one snapshot stage; released by [`SnapshotScratch::release`].
pub struct Stage {
    pub dir: PathBuf,
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
            if let Some(pid) = owner(&name)
                && pid != self.pid
                && alive(pid)
            {
                continue;
            }
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
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
        Ok(WorkDir { dir: Some(dir) })
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
        self.held = true;
        Ok(Stage { dir })
    }

    pub fn release(&mut self, stage: Stage) {
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
