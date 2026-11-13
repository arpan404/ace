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
        match to_at.symlink_metadata(new_name) {
            Ok(_) => return Err(PathError::Exists(to.to_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(PathError::at(to, error)),
        }
        from_at
            .rename(name, &to_at, new_name)
            .map_err(|error| PathError::at(from, error))?;
        Ok((shown(&source), shown(&target)))
    }
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
