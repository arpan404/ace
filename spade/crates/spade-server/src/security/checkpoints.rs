//! Checkpoints of a bot's workspace (ADR 0167 decision 8): copies taken before runs nobody
//! reviews (at most once a minute) or when the person asks, so a mistake inside the sandbox can be
//! undone. Each is `<root>/<bot>/<id>/`, a copy of the workspace (copy-on-write where the file
//! system clones), with `<id>.json` written once the copy is whole; a folder without its record
//! is a copy that didn't finish and is removed. Bounded: the newest [`KEEP`], none older than
//! [`LONGEST`]. Consented folders aren't copied: they are the person's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    /// When each bot's last automatic checkpoint was taken.
    last: Mutex<HashMap<String, i64>>,
}

fn io(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Checkpoints {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            last: Mutex::new(HashMap::new()),
        }
    }

    fn folder(&self, bot: &str) -> PathBuf {
        self.root.join(bot)
    }

    /// Whether an automatic checkpoint is due for `bot` at `now`; if so, it counts as taken.
    pub fn due(&self, bot: &str, now: i64) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        match last.get(bot) {
            Some(at) if now - at < EVERY => false,
            _ => {
                last.insert(bot.to_owned(), now);
                true
            }
        }
    }

    /// The bot's checkpoints, newest first. Unfinished copies are removed on the way.
    pub fn list(&self, bot: &str) -> Vec<Checkpoint> {
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
            if !found.iter().any(|c| c.id == name) {
                let _ = std::fs::remove_dir_all(&copy);
            }
        }
        found.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
        found
    }

    /// Copies `workspace` as checkpoint `id`, then drops what the bounds no longer keep.
    pub fn take(
        &self,
        bot: &str,
        workspace: &Path,
        id: &str,
        at: i64,
        reason: &str,
    ) -> Result<Checkpoint, String> {
        let folder = self.folder(bot);
        std::fs::create_dir_all(&folder).map_err(io)?;
        let copy = folder.join(id);
        clone_tree(workspace, &copy)?;
        // Its own temporary files aren't part of the work.
        let _ = std::fs::remove_dir_all(copy.join(spade_sandbox::policy::TEMP));
        let checkpoint = Checkpoint {
            id: id.to_owned(),
            at,
            reason: reason.to_owned(),
        };
        let record = serde_json::to_string(&checkpoint).map_err(io)?;
        std::fs::write(folder.join(format!("{id}.json")), record).map_err(io)?;
        let all = self.list(bot);
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
        if !self.list(bot).iter().any(|c| c.id == id) {
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
        let _ = std::fs::remove_dir_all(self.folder(bot));
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
    let (from, to) = (from.as_os_str(), to.as_os_str());
    if cfg!(target_os = "macos") {
        // `-c` clones (copy-on-write); a volume that can't clone gets a plain copy.
        run(&["-c".as_ref(), "-R".as_ref(), "-p".as_ref(), from, to]).or_else(|_| {
            let _ = std::fs::remove_dir_all(to);
            run(&["-R".as_ref(), "-p".as_ref(), from, to])
        })
    } else if cfg!(unix) {
        run(&["-a".as_ref(), "--reflink=auto".as_ref(), from, to])
    } else {
        Err("checkpoints aren't available on this system yet".to_owned())
    }
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
        let checkpoints = Checkpoints::new(PathBuf::from("/nowhere"));
        assert!(checkpoints.due("b1", 0));
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
}
