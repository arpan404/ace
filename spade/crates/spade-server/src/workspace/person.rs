//! What the person does in a bot's workspace through the app while they have its computer, or
//! any time (ADR 0142): make folders and move things, and a snapshot of every file, so the
//! hand-back note can say which files changed while they drove.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::files::{MOST_WALKED, folder, millis};
use super::{PathError, Workspace, clean, shown};

/// What a snapshot keeps of one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seen {
    /// `None` for a folder.
    pub size: Option<u64>,
    pub modified_at: Option<i64>,
}

/// Every file and folder in a workspace, by path; links are not followed and Spade's own
/// `.spade` folder is left out. At most [`MOST_WALKED`] entries.
pub type Snapshot = BTreeMap<String, Seen>;

impl Workspace {
    /// The workspace's files and folders now.
    pub fn snapshot(&self) -> Result<Snapshot, PathError> {
        let dir = self.dir()?;
        let mut seen = Snapshot::new();
        let mut stack = vec![String::new()];
        while let Some(path) = stack.pop() {
            let Ok(at) = folder(&dir, Path::new(&path), &path) else {
                continue;
            };
            for entry in at.entries()?.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                let full = if path.is_empty() {
                    name.clone()
                } else {
                    format!("{path}/{name}")
                };
                if full == ".spade" {
                    continue;
                }
                let Ok(meta) = at.symlink_metadata(&name) else {
                    continue;
                };
                let modified_at = millis(meta.modified());
                if meta.is_dir() {
                    seen.insert(
                        full.clone(),
                        Seen {
                            size: None,
                            modified_at,
                        },
                    );
                    stack.push(full);
                } else {
                    seen.insert(
                        full,
                        Seen {
                            size: Some(meta.len()),
                            modified_at,
                        },
                    );
                }
                if seen.len() >= MOST_WALKED {
                    return Ok(seen);
                }
            }
        }
        Ok(seen)
    }

    /// Makes a folder and those on the way to it. A folder already there is fine; a file there
    /// is not.
    pub fn mkdir(&self, relative: &str) -> Result<String, PathError> {
        let cleaned = clean(relative)?;
        if cleaned.as_os_str().is_empty() {
            return Err(PathError::Io("give the folder's name".to_owned()));
        }
        let dir = self.dir()?;
        dir.create_dir_all(&cleaned)
            .map_err(|error| PathError::at(relative, error))?;
        match dir.symlink_metadata(&cleaned) {
            Ok(meta) if meta.is_dir() => Ok(shown(&cleaned)),
            Ok(_) => Err(PathError::Exists(relative.to_owned())),
            Err(error) => Err(PathError::at(relative, error)),
        }
    }

    /// Moves a file, link or folder to `to`, never over something already there. Folders on the
    /// way to `to` are made. Answers both paths as the workspace names them.
    pub fn rename(&self, from: &str, to: &str) -> Result<(String, String), PathError> {
        let (source, target) = (clean(from)?, clean(to)?);
        let (Some(name), Some(new_name)) = (source.file_name(), target.file_name()) else {
            return Err(PathError::Io(
                "the workspace itself cannot be moved".to_owned(),
            ));
        };
        if target.starts_with(&source) {
            return Err(PathError::Io(format!("{from} cannot go inside itself")));
        }
        let dir = self.dir()?;
        let from_at = folder(&dir, source.parent().unwrap_or(Path::new("")), from)?;
        from_at
            .symlink_metadata(name)
            .map_err(|error| PathError::at(from, error))?;
        let parent = target.parent().unwrap_or(Path::new(""));
        if !parent.as_os_str().is_empty() {
            dir.create_dir_all(parent)
                .map_err(|error| PathError::at(to, error))?;
        }
        let to_at = folder(&dir, parent, to)?;
        move_no_replace(&from_at, name, &to_at, new_name).map_err(|error| match error {
            Moved::Exists => PathError::Exists(to.to_owned()),
            Moved::Failed(error) => PathError::at(from, error),
        })?;
        Ok((shown(&source), shown(&target)))
    }
}

/// Why a move did not happen.
#[derive(Debug)]
enum Moved {
    /// Something is at the target: it is never replaced.
    Exists,
    Failed(std::io::Error),
}

impl From<std::io::Error> for Moved {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Self::Exists
        } else {
            Self::Failed(error)
        }
    }
}

/// Moves `name` in `from` to `new_name` in `to` without ever replacing what is there, even
/// something made there a moment ago: each step that claims the target fails if it is taken.
/// A file is hard-linked at the target, then unlinked; a folder gets an empty folder made at the
/// target (refused if taken), which `rename` then replaces with it; a link is made again at the
/// target, then removed. A plain `rename` would replace a file there.
fn move_no_replace(
    from: &cap_std::fs::Dir,
    name: &std::ffi::OsStr,
    to: &cap_std::fs::Dir,
    new_name: &std::ffi::OsStr,
) -> Result<(), Moved> {
    let meta = from.symlink_metadata(name)?;
    if meta.is_dir() {
        if !cfg!(windows) {
            // Windows never lets a folder replace another, so it renames straight away.
            to.create_dir(new_name)?;
        }
        if let Err(error) = from.rename(name, to, new_name) {
            if !cfg!(windows) {
                // Only ours, and only while empty: anything put in it meanwhile stays.
                let _ = to.remove_dir(new_name);
            }
            return Err(error.into());
        }
        return Ok(());
    }
    if meta.file_type().is_symlink() {
        return relink(from, name, to, new_name);
    }
    from.hard_link(name, to, new_name)?;
    if let Err(error) = from.remove_file(name) {
        let _ = to.remove_file(new_name);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(unix)]
fn relink(
    from: &cap_std::fs::Dir,
    name: &std::ffi::OsStr,
    to: &cap_std::fs::Dir,
    new_name: &std::ffi::OsStr,
) -> Result<(), Moved> {
    let target = from.read_link_contents(name)?;
    to.symlink_contents(&target, new_name)?;
    if let Err(error) = from.remove_file(name) {
        let _ = to.remove_file(new_name);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn relink(
    _from: &cap_std::fs::Dir,
    _name: &std::ffi::OsStr,
    _to: &cap_std::fs::Dir,
    _new_name: &std::ffi::OsStr,
) -> Result<(), Moved> {
    Err(Moved::Failed(std::io::Error::other(
        "links are not moved on Windows",
    )))
}

/// What changed between two snapshots, for the hand-back note: each path new, changed or gone.
/// A folder counts as new or gone, never as changed (its time moves with what is in it).
pub fn changes(before: &Snapshot, after: &Snapshot) -> Vec<(String, &'static str)> {
    let mut out = Vec::new();
    for (path, now) in after {
        match before.get(path) {
            None => out.push((path.clone(), "new")),
            Some(was) if now.size.is_some() && was != now => out.push((path.clone(), "changed")),
            Some(_) => {}
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            out.push((path.clone(), "removed"));
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder_at(path: &Path) -> cap_std::fs::Dir {
        cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority())
            .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn a_move_never_replaces_a_file_or_folder_already_at_the_target() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let dir = folder_at(root.path());
        std::fs::write(root.path().join("a.txt"), "mine").unwrap_or_default();
        std::fs::write(root.path().join("b.txt"), "theirs").unwrap_or_default();
        let moved = move_no_replace(&dir, "a.txt".as_ref(), &dir, "b.txt".as_ref());
        assert!(matches!(moved, Err(Moved::Exists)), "{moved:?}");
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.txt")).unwrap_or_default(),
            "theirs"
        );
        assert!(root.path().join("a.txt").exists());

        std::fs::create_dir(root.path().join("src")).unwrap_or_default();
        std::fs::create_dir(root.path().join("empty")).unwrap_or_default();
        let moved = move_no_replace(&dir, "src".as_ref(), &dir, "empty".as_ref());
        assert!(matches!(moved, Err(Moved::Exists)), "{moved:?}");
        assert!(root.path().join("src").is_dir());

        move_no_replace(&dir, "a.txt".as_ref(), &dir, "c.txt".as_ref())
            .unwrap_or_else(|e| panic!("{e:?}"));
        move_no_replace(&dir, "src".as_ref(), &dir, "dst".as_ref())
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert!(!root.path().join("a.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join("c.txt")).unwrap_or_default(),
            "mine"
        );
        assert!(root.path().join("dst").is_dir() && !root.path().join("src").exists());
    }

    fn file(size: u64, at: i64) -> Seen {
        Seen {
            size: Some(size),
            modified_at: Some(at),
        }
    }

    #[test]
    fn changes_name_each_file_new_changed_or_removed() {
        let before: Snapshot = [
            ("a.txt".to_owned(), file(1, 1)),
            ("b.txt".to_owned(), file(1, 1)),
            (
                "keep".to_owned(),
                Seen {
                    size: None,
                    modified_at: Some(1),
                },
            ),
        ]
        .into();
        let after: Snapshot = [
            ("a.txt".to_owned(), file(2, 5)),
            ("c.txt".to_owned(), file(1, 5)),
            (
                "keep".to_owned(),
                Seen {
                    size: None,
                    modified_at: Some(9),
                },
            ),
        ]
        .into();
        assert_eq!(
            changes(&before, &after),
            vec![
                ("a.txt".to_owned(), "changed"),
                ("b.txt".to_owned(), "removed"),
                ("c.txt".to_owned(), "new"),
            ]
        );
    }
}
