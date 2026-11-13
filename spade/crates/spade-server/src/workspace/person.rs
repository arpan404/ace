//! What the person does in a bot's workspace through the app while they have its computer, or
//! any time (ADR 0142): make folders and move things, and a snapshot of every file, so the
//! hand-back note can say which files changed while they drove.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::files::{MOST_WALKED, folder, millis};
use super::{PathError, Workspace, clean, shown};

/// Largest file a revision is taken of: the largest the person writes.
pub const LARGEST_REVISION: u64 = 32 * 1024 * 1024;

/// A file's revision: `sha256:<hex>` of its content.
pub fn revision_of(bytes: &[u8]) -> String {
    format!("sha256:{}", super::trust::hash(bytes))
}

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
    /// The file at `relative`'s revision now: `None` when nothing is there, an error for a folder
    /// or a file too large to have one.
    pub fn revision(&self, relative: &str) -> Result<Option<String>, PathError> {
        match self.bytes_up_to(relative, LARGEST_REVISION) {
            Ok(bytes) => Ok(Some(revision_of(&bytes))),
            Err(PathError::Missing(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Refuses with [`PathError::Changed`] unless the file at `relative` is still revision
    /// `base`. No `base` (a new file, or the person chose to overwrite) always passes.
    pub fn check_base(&self, relative: &str, base: Option<&str>) -> Result<(), PathError> {
        let Some(base) = base else {
            return Ok(());
        };
        // Grown past the largest file a revision is taken of: it can't be the one they opened.
        let cleaned = clean(relative)?;
        if let Ok(meta) = self.dir()?.metadata(&cleaned)
            && meta.is_file()
            && meta.len() > LARGEST_REVISION
        {
            return Err(PathError::Changed(None));
        }
        let now = self.revision(relative)?;
        if now.as_deref() == Some(base) {
            Ok(())
        } else {
            Err(PathError::Changed(now))
        }
    }

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

/// Moves `name` in `from` to `new_name` in `to` in one step that fails if anything is at the
/// target, even something made there a moment ago: `renameat2(RENAME_NOREPLACE)` on Linux,
/// `renamex_np(RENAME_EXCL)` on macOS. A move to another disk (`EXDEV`) is refused, never copied.
#[cfg(unix)]
fn move_no_replace(
    from: &cap_std::fs::Dir,
    name: &std::ffi::OsStr,
    to: &cap_std::fs::Dir,
    new_name: &std::ffi::OsStr,
) -> Result<(), Moved> {
    use rustix::fs::{RenameFlags, renameat_with};
    renameat_with(from, name, to, new_name, RenameFlags::NOREPLACE).map_err(|errno| {
        if errno == rustix::io::Errno::XDEV {
            Moved::Failed(std::io::Error::other(
                "that is on another disk; moves stay on the workspace's own disk",
            ))
        } else {
            std::io::Error::from(errno).into()
        }
    })
}

/// Windows has no rename that refuses a taken target, so this checks first: something made at
/// the target between the check and the move can be replaced (docs/computer.md says so).
#[cfg(not(unix))]
fn move_no_replace(
    from: &cap_std::fs::Dir,
    name: &std::ffi::OsStr,
    to: &cap_std::fs::Dir,
    new_name: &std::ffi::OsStr,
) -> Result<(), Moved> {
    match to.symlink_metadata(new_name) {
        Ok(_) => return Err(Moved::Exists),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    from.rename(name, to, new_name).map_err(Moved::from)
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
