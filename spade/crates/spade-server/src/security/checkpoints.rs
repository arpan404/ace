//! Checkpoints of a bot's workspace (ADR 0167 decision 8): copies taken before runs nobody
//! reviews (at most once a minute) or when the person asks, so a mistake inside the sandbox can be
//! undone. Each is `<root>/<bot>/<id>/`, a copy of the workspace (copy-on-write where the file
//! system clones), with `<id>.json` written once the copy is whole; a folder without its record
//! is a copy that didn't finish and is removed. Bounded: the newest [`KEEP`], none older than
//! [`LONGEST`]. Consented folders aren't copied: they are the person's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// The most checkpoints kept per bot.
pub const KEEP: usize = 20;
/// The oldest a checkpoint is kept, in milliseconds (7 days).
pub const LONGEST: i64 = 7 * 24 * 60 * 60 * 1000;
/// The least time between automatic checkpoints, in milliseconds.
pub const EVERY: i64 = 60 * 1000;

/// One checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub at: i64,
    /// `auto` before an unreviewed run, `person`, or `before_restore`.
    pub reason: String,
}

/// Which checkpoints to drop: past the newest `keep`, or older than `longest` at `now`. Pure.
pub fn to_drop(all: &[Checkpoint], now: i64, keep: usize, longest: i64) -> Vec<String> {
    let mut newest: Vec<&Checkpoint> = all.iter().collect();
    newest.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
    newest
        .iter()
        .enumerate()
        .filter(|(rank, c)| *rank >= keep || now - c.at > longest)
        .map(|(_, c)| c.id.clone())
        .collect()
}

pub struct Checkpoints {
    root: PathBuf,
    /// When each bot's last checkpoint was taken (successfully).
    last: Mutex<HashMap<String, i64>>,
    /// One checkpoint operation per bot at a time: a list never meets a copy in progress.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

fn io(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// A copy being made: never listed, published by a rename once whole.
const STAGE: &str = ".stage-";

impl Checkpoints {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            last: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
        }
    }

    fn folder(&self, bot: &str) -> PathBuf {
        self.root.join(bot)
    }

    /// Holds `bot`'s checkpoint operations for the guard's life.
    fn hold(&self, bot: &str) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(bot.to_owned())
            .or_default()
            .clone()
    }

    /// Whether an automatic checkpoint is due for `bot` at `now`. Only a checkpoint that was
    /// taken counts: a failed one leaves the next due.
    pub fn due(&self, bot: &str, now: i64) -> bool {
        let last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        !last.get(bot).is_some_and(|at| now - at < EVERY)
    }

    /// The bot's checkpoints, newest first. Copies left unfinished (a crash mid-copy) are
    /// removed on the way; none can be in progress, since operations on a bot are held.
    pub fn list(&self, bot: &str) -> Vec<Checkpoint> {
        let lock = self.hold(bot);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        self.list_held(bot)
    }

    fn list_held(&self, bot: &str) -> Vec<Checkpoint> {
        let folder = self.folder(bot);
        let Ok(entries) = std::fs::read_dir(&folder) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        let mut copies = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") => {
                    if let Some(checkpoint) = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|text| serde_json::from_str::<Checkpoint>(&text).ok())
                    {
                        found.push(checkpoint);
                    }
                }
                _ if path.is_dir() => copies.push(path),
                _ => {}
            }
        }
        for copy in copies {
            let name = copy
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if name.starts_with(STAGE) || !found.iter().any(|c| c.id == name) {
                let _ = std::fs::remove_dir_all(&copy);
            }
        }
        found.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
        found
    }

    /// Copies `workspace` as checkpoint `id`, then drops what the bounds no longer keep. The
    /// copy is made under a staging name and published by a rename, its record after it.
    pub fn take(
        &self,
        bot: &str,
        workspace: &Path,
        id: &str,
        at: i64,
        reason: &str,
    ) -> Result<Checkpoint, String> {
        let lock = self.hold(bot);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let folder = self.folder(bot);
        std::fs::create_dir_all(&folder).map_err(io)?;
        let stage = folder.join(format!("{STAGE}{id}"));
        let _ = std::fs::remove_dir_all(&stage);
        if let Err(error) = clone_tree(workspace, &stage) {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(error);
        }
        // Its own temporary files aren't part of the work.
        let _ = std::fs::remove_dir_all(stage.join(spade_sandbox::policy::TEMP));
        let checkpoint = Checkpoint {
            id: id.to_owned(),
            at,
            reason: reason.to_owned(),
        };
        let published = (|| {
            std::fs::rename(&stage, folder.join(id)).map_err(io)?;
            let record = serde_json::to_string(&checkpoint).map_err(io)?;
            let staged_record = folder.join(format!("{STAGE}{id}.json.tmp"));
            std::fs::write(&staged_record, record).map_err(io)?;
            std::fs::rename(&staged_record, folder.join(format!("{id}.json"))).map_err(io)
        })();
        if let Err(error) = published {
            let _ = std::fs::remove_dir_all(&stage);
            let _ = std::fs::remove_dir_all(folder.join(id));
            return Err(error);
        }
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(bot.to_owned(), at);
        let all = self.list_held(bot);
        for gone in to_drop(&all, at, KEEP, LONGEST) {
            self.remove(bot, &gone);
        }
        Ok(checkpoint)
    }

    fn remove(&self, bot: &str, id: &str) {
        let folder = self.folder(bot);
        let _ = std::fs::remove_file(folder.join(format!("{id}.json")));
        let _ = std::fs::remove_dir_all(folder.join(id));
    }

    /// Puts checkpoint `id` in place of `workspace`. The workspace as it was is moved aside
    /// first and put back if the copy fails.
    pub fn restore(&self, bot: &str, id: &str, workspace: &Path) -> Result<(), String> {
        let lock = self.hold(bot);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        if !self.list_held(bot).iter().any(|c| c.id == id) {
            return Err(format!("there is no checkpoint {id}"));
        }
        let copy = self.folder(bot).join(id);
        let aside = workspace.with_file_name(format!(
            ".{}.restoring-{id}",
            workspace
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("workspace")
        ));
        let _ = std::fs::remove_dir_all(&aside);
        std::fs::rename(workspace, &aside).map_err(io)?;
        match clone_tree(&copy, workspace) {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(&aside);
                Ok(())
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(workspace);
                let _ = std::fs::rename(&aside, workspace);
                Err(error)
            }
        }
    }

    /// Forgets a deleted bot's checkpoints.
    pub fn forget(&self, bot: &str) {
        let lock = self.hold(bot);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let _ = std::fs::remove_dir_all(self.folder(bot));
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(bot);
    }
}

/// Copies the folder `from` to `to` (which must not exist), links kept as links: a clone where
/// the file system makes one (APFS, Btrfs, XFS), else a plain copy.
fn clone_tree(from: &Path, to: &Path) -> Result<(), String> {
    let run = |args: &[&std::ffi::OsStr]| {
        std::process::Command::new("/bin/cp")
            .args(args)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(io)
            .and_then(|out| {
                if out.status.success() {
                    Ok(())
                } else {
                    Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
                }
            })
    };
    #[cfg(windows)]
    {
        // NTFS has no cheap clone, so a plain recursive copy (ReFS block-cloning is a later step).
        let _ = &run;
        return copy_tree(from, to).map_err(|error| error.to_string());
    }
    #[cfg(not(windows))]
    {
        let (from, to) = (from.as_os_str(), to.as_os_str());
        if cfg!(target_os = "macos") {
            // `-c` clones (copy-on-write); a volume that can't clone gets a plain copy.
            run(&["-c".as_ref(), "-R".as_ref(), "-p".as_ref(), from, to]).or_else(|_| {
                let _ = std::fs::remove_dir_all(to);
                run(&["-R".as_ref(), "-p".as_ref(), from, to])
            })
        } else {
            run(&["-a".as_ref(), "--reflink=auto".as_ref(), from, to])
        }
    }
}

/// A plain recursive copy of `from` to `to` (Windows, which has no cheap clone).
#[cfg(windows)]
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
        // Symlinks and other entries are skipped: a checkpoint is a copy of the bot's own files.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(id: &str, at: i64) -> Checkpoint {
        Checkpoint {
            id: id.to_owned(),
            at,
            reason: "auto".to_owned(),
        }
    }

    #[test]
    fn past_the_newest_kept_or_too_old_a_checkpoint_goes() {
        let all = vec![at("a", 1), at("b", 50), at("c", 100), at("d", 100)];
        assert_eq!(to_drop(&all, 100, 3, 1_000), vec!["a".to_owned()]);
        assert_eq!(to_drop(&all, 100, 10, 60), vec!["a".to_owned()]);
        assert_eq!(to_drop(&all, 100, 10, 1_000), Vec::<String>::new());
    }

    #[test]
    fn an_automatic_checkpoint_comes_at_most_once_a_minute_per_bot() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let workspace = dir.path().join("workspace/b1");
        std::fs::create_dir_all(&workspace).unwrap_or_default();
        let checkpoints = Checkpoints::new(dir.path().join("checkpoints"));
        assert!(checkpoints.due("b1", 0));
        assert!(checkpoints.take("b1", &workspace, "cp1", 0, "auto").is_ok());
        assert!(!checkpoints.due("b1", EVERY - 1));
        assert!(checkpoints.due("b2", 10));
        assert!(checkpoints.due("b1", EVERY));
    }

    #[test]
    fn a_restore_brings_back_the_workspace_as_it_was_and_unfinished_copies_are_cleared() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let workspace = dir.path().join("workspace/b1");
        std::fs::create_dir_all(workspace.join("src")).unwrap_or_default();
        std::fs::write(workspace.join("src/main.rs"), "good").unwrap_or_default();
        std::fs::create_dir_all(workspace.join(spade_sandbox::policy::TEMP)).unwrap_or_default();
        let checkpoints = Checkpoints::new(dir.path().join("checkpoints"));
        let taken = checkpoints.take("b1", &workspace, "cp1", 10, "person");
        assert!(taken.is_ok(), "{taken:?}");
        std::fs::write(workspace.join("src/main.rs"), "broken").unwrap_or_default();
        std::fs::write(workspace.join("junk.txt"), "x").unwrap_or_default();
        // A copy that never got its record.
        std::fs::create_dir_all(dir.path().join("checkpoints/b1/cp-half")).unwrap_or_default();
        assert_eq!(
            checkpoints
                .list("b1")
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cp1"]
        );
        assert!(!dir.path().join("checkpoints/b1/cp-half").exists());
        assert!(checkpoints.restore("b1", "cp1", &workspace).is_ok());
        assert_eq!(
            std::fs::read_to_string(workspace.join("src/main.rs")).unwrap_or_default(),
            "good"
        );
        assert!(!workspace.join("junk.txt").exists());
        assert!(checkpoints.restore("b1", "nope", &workspace).is_err());
    }

    #[test]
    fn listing_while_a_checkpoint_is_copied_never_removes_it() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let workspace = dir.path().join("workspace/b1");
        for n in 0..1500 {
            let folder = workspace.join(format!("d{}", n % 30));
            std::fs::create_dir_all(&folder).unwrap_or_default();
            std::fs::write(folder.join(format!("f{n}.txt")), "x").unwrap_or_default();
        }
        let checkpoints = std::sync::Arc::new(Checkpoints::new(dir.path().join("checkpoints")));
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let lister = {
            let (checkpoints, done) = (checkpoints.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = checkpoints.list("b1");
                }
            })
        };
        let taken = checkpoints.take("b1", &workspace, "cp1", 10, "auto");
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = lister.join();
        assert!(taken.is_ok(), "{taken:?}");
        let copied = walk_count(&dir.path().join("checkpoints/b1/cp1"));
        assert_eq!(copied, 1500);
        assert_eq!(checkpoints.list("b1").len(), 1);
    }

    #[test]
    fn a_failed_checkpoint_leaves_the_next_one_due() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let checkpoints = Checkpoints::new(dir.path().join("checkpoints"));
        assert!(checkpoints.due("b1", 0));
        let missing = dir.path().join("workspace/none");
        assert!(checkpoints.take("b1", &missing, "cp1", 0, "auto").is_err());
        assert!(checkpoints.due("b1", 1), "a failure doesn't count as taken");
        let workspace = dir.path().join("workspace/b1");
        std::fs::create_dir_all(&workspace).unwrap_or_default();
        assert!(checkpoints.take("b1", &workspace, "cp2", 2, "auto").is_ok());
        assert!(!checkpoints.due("b1", 3));
    }

    fn walk_count(path: &Path) -> usize {
        std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| {
                        let p = e.path();
                        if p.is_dir() { walk_count(&p) } else { 1 }
                    })
                    .sum()
            })
            .unwrap_or(0)
    }
}
