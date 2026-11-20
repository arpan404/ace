//! Undo in the conversation (ADR 0167 decision 8, amendment 2): the checkpoint a step's or a
//! turn's changes go back to, and what restoring it would revert, listed for the person before
//! they confirm. Which checkpoint is pure ([`before`]); the comparison reads the two trees, by size
//! and time first and by content only where those differ.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::checkpoints::Checkpoint;

/// The most paths each list carries; past it, [`Changes::more`] counts the rest.
pub const LISTED: usize = 200;

/// What putting a checkpoint back would do to the workspace as it is now, path by path
/// (relative, `/`-separated). Spade's own temporary folder isn't part of it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Changes {
    /// Files that differ now: they go back to how they were.
    pub changed: Vec<String>,
    /// Files made since: they go.
    pub added: Vec<String>,
    /// Files removed since: they come back.
    pub deleted: Vec<String>,
    /// Paths past [`LISTED`] in any list, counted.
    pub more: usize,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.added.is_empty() && self.deleted.is_empty()
    }

    /// How many files an undo touches.
    pub fn total(&self) -> usize {
        self.changed.len() + self.added.len() + self.deleted.len() + self.more
    }
}

/// The checkpoint work that started at `started_at` (a step's `tool_started`) goes back to: the
/// newest taken at or before it. An automatic one is taken just before the work it guards, and
/// before the first unreviewed work of every turn, so for a turn's first file-changing step this
/// is that turn's own checkpoint. Pure.
pub fn before(all: &[Checkpoint], started_at: i64) -> Option<&Checkpoint> {
    all.iter()
        .filter(|c| c.at <= started_at)
        .max_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)))
}

/// One file's facts for the comparison.
struct Facts {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    link: bool,
}

/// Every file under `root`, by its path relative to it, leaving out Spade's temporary folder.
/// Links are files here (their target isn't followed).
fn files(root: &Path) -> std::io::Result<BTreeMap<String, Facts>> {
    let mut out = BTreeMap::new();
    let temp = Path::new(spade_sandbox::policy::TEMP);
    let mut stack = vec![PathBuf::new()];
    while let Some(relative) = stack.pop() {
        let entries = match std::fs::read_dir(root.join(&relative)) {
            Ok(entries) => entries,
            Err(error) if relative.as_os_str().is_empty() => return Err(error),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let inner = relative.join(entry.file_name());
            if inner == temp {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(inner);
                continue;
            }
            let key = inner
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.insert(
                key,
                Facts {
                    path: entry.path(),
                    len: meta.len(),
                    modified: meta.modified().ok(),
                    link: meta.file_type().is_symlink(),
                },
            );
        }
    }
    Ok(out)
}

/// Whether two files hold the same: the same size and time (copies keep times) count as the
/// same; otherwise their bytes are compared.
fn same(a: &Facts, b: &Facts) -> bool {
    if a.link || b.link {
        return a.link == b.link
            && std::fs::read_link(&a.path).ok() == std::fs::read_link(&b.path).ok();
    }
    if a.len != b.len {
        return false;
    }
    if a.modified.is_some() && a.modified == b.modified {
        return true;
    }
    same_bytes(&a.path, &b.path).unwrap_or(false)
}

fn same_bytes(a: &Path, b: &Path) -> std::io::Result<bool> {
    let (mut a, mut b) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut left, mut right) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let read = a.read(&mut left)?;
        if read == 0 {
            return Ok(b.read(&mut right[..1])? == 0);
        }
        b.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

/// What restoring the copy at `checkpoint` would do to `workspace` now.
pub fn changes(checkpoint: &Path, workspace: &Path) -> std::io::Result<Changes> {
    let then = files(checkpoint)?;
    let now = match files(workspace) {
        Ok(now) => now,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error),
    };
    let mut out = Changes::default();
    let push = |list: &mut Vec<String>, more: &mut usize, path: &str| {
        if list.len() < LISTED {
            list.push(path.to_owned());
        } else {
            *more += 1;
        }
    };
    for (path, facts) in &now {
        match then.get(path) {
            None => push(&mut out.added, &mut out.more, path),
            Some(old) if !same(old, facts) => push(&mut out.changed, &mut out.more, path),
            Some(_) => {}
        }
    }
    for path in then.keys().filter(|path| !now.contains_key(*path)) {
        push(&mut out.deleted, &mut out.more, path);
    }
    Ok(out)
}

/// The note the bot reads after the person undid its changes, so it doesn't rely on files that
/// went back. Counts only: the file names were chosen by whoever wrote them.
pub fn note_for_bot(when: &str, changes: &Changes) -> String {
    format!(
        "The person undid changes in your workspace: it is back to how it was at {when}. \
         {} file(s) went back to their earlier content, {} made since were removed and {} \
         removed since came back. Read files again before relying on what you remember of them.",
        changes.changed.len(),
        changes.added.len(),
        changes.deleted.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(id: &str, at: i64) -> Checkpoint {
        Checkpoint {
            id: id.to_owned(),
            at,
            reason: "auto".to_owned(),
        }
    }

    #[test]
    fn a_step_goes_back_to_the_newest_checkpoint_taken_before_it_started() {
        let all = vec![
            checkpoint("a", 10),
            checkpoint("b", 50),
            checkpoint("c", 90),
        ];
        assert_eq!(before(&all, 50).map(|c| c.id.as_str()), Some("b"));
        assert_eq!(before(&all, 89).map(|c| c.id.as_str()), Some("b"));
        assert_eq!(before(&all, 1_000).map(|c| c.id.as_str()), Some("c"));
        assert_eq!(before(&all, 9), None, "work before any checkpoint can't be undone");
    }

    #[test]
    fn the_comparison_lists_files_changed_made_and_removed_since_the_checkpoint() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let (then, now) = (dir.path().join("then"), dir.path().join("now"));
        for root in [&then, &now] {
            std::fs::create_dir_all(root.join("src")).unwrap_or_default();
            std::fs::write(root.join("src/same.txt"), "same").unwrap_or_default();
            std::fs::create_dir_all(root.join(spade_sandbox::policy::TEMP)).unwrap_or_default();
        }
        std::fs::write(then.join("src/main.rs"), "good").unwrap_or_default();
        std::fs::write(now.join("src/main.rs"), "worse").unwrap_or_default();
        std::fs::write(then.join("notes.md"), "kept").unwrap_or_default();
        std::fs::write(now.join("draft.md"), "new").unwrap_or_default();
        std::fs::write(now.join(spade_sandbox::policy::TEMP).join("x"), "tmp").unwrap_or_default();
        let found = changes(&then, &now).unwrap_or_default();
        assert_eq!(found.changed, vec!["src/main.rs"]);
        assert_eq!(found.added, vec!["draft.md"]);
        assert_eq!(found.deleted, vec!["notes.md"]);
        assert_eq!(found.total(), 3);
    }

    #[test]
    fn a_file_rewritten_with_the_same_bytes_is_not_a_change() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| std::process::abort());
        let (then, now) = (dir.path().join("then"), dir.path().join("now"));
        for root in [&then, &now] {
            std::fs::create_dir_all(root).unwrap_or_default();
            std::fs::write(root.join("a.txt"), "same bytes").unwrap_or_default();
        }
        assert!(changes(&then, &now).unwrap_or_default().is_empty());
    }
}
