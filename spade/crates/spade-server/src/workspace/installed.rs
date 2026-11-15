//! A loaded skill's files in the bot's workspace (ADR 0151, point 5): `skills/<name>/`, written
//! read only when the skill is loaded and replaced when it changed. The person installed the
//! skill, so its files are trusted: each is recorded with its hash, and one a command rewrites
//! no longer matches and reads as untrusted like any other file a command changed.

use std::collections::HashSet;
use std::path::Path;

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::OpenOptions;

use super::{PathError, Workspace, clean, shown};
use crate::tools::SkillFileData;

/// Where loaded skills' files go in a workspace.
pub const SKILLS_FOLDER: &str = "skills";

/// A skill's file is at most this large (the daemon's own limit), with room to spare.
const LARGEST_SKILL_FILE: usize = 2 * 1024 * 1024;

/// The most entries looked at to tell whether a skill's folder is exactly its files.
const MOST_ENTRIES: usize = 2_000;

impl Workspace {
    /// Makes `skills/<name>/` hold exactly `files` and answers that folder, or `None` when the
    /// skill has no files (and so no folder). When the folder already holds exactly these files
    /// with the same content, still trusted, nothing is written; otherwise it is replaced whole
    /// and its old trust records go with it, so nothing of an older version is left or trusted.
    pub fn place_skill(
        &self,
        name: &str,
        files: &[SkillFileData],
    ) -> Result<Option<String>, PathError> {
        let one = clean(name)?;
        if one.components().count() != 1 || name.starts_with('.') {
            return Err(PathError::Unusable(name.to_owned()));
        }
        let folder = format!("{SKILLS_FOLDER}/{}", shown(&one));
        let mut placed = Vec::with_capacity(files.len());
        for file in files {
            let path = clean(&format!("{folder}/{}", file.path))?;
            if !path.starts_with(Path::new(SKILLS_FOLDER).join(&one)) {
                return Err(PathError::Parent);
            }
            placed.push((shown(&path), file));
        }
        self.changing(|| {
            if files.is_empty() {
                return self.remove_skill_folder(&folder);
            }
            let current = self.holds_exactly(&folder, &placed)
                && placed.iter().all(|(path, file)| {
                    self.bytes_up_to(path, LARGEST_SKILL_FILE as u64)
                        .is_ok_and(|bytes| bytes == file.bytes && self.file_trusted(path, &bytes))
                });
            if current {
                return Ok(());
            }
            self.remove_skill_folder(&folder)?;
            for (path, file) in &placed {
                self.write_bytes(path, &file.bytes, LARGEST_SKILL_FILE)?;
                self.read_only(path, file.executable)?;
                self.trust().record_installed(path, &file.bytes);
            }
            Ok(())
        })?;
        Ok((!files.is_empty()).then_some(folder))
    }

    /// Removes a skill's folder, if there, and forgets what was trusted in it.
    fn remove_skill_folder(&self, folder: &str) -> Result<(), PathError> {
        let removed = match self.delete(folder) {
            Ok(()) | Err(PathError::Missing(_)) => Ok(()),
            Err(error) => Err(error),
        };
        // Forgotten even when the delete failed part way: a file left behind is not trusted.
        self.trust().forget_under(folder);
        removed
    }

    /// Whether `folder` holds the `placed` files and nothing else: no other file, no link, no
    /// pipe, no folder that holds none of them.
    fn holds_exactly(&self, folder: &str, placed: &[(String, &SkillFileData)]) -> bool {
        let wanted: HashSet<&str> = placed.iter().map(|(path, _)| path.as_str()).collect();
        let Ok(dir) = self.dir() else {
            return false;
        };
        let Ok(top) = super::files::folder(&dir, Path::new(folder), folder) else {
            return false;
        };
        let mut stack = vec![(folder.to_owned(), top)];
        let mut seen = 0;
        while let Some((path, at)) = stack.pop() {
            let Ok(entries) = at.entries() else {
                return false;
            };
            let mut empty = true;
            for entry in entries {
                seen += 1;
                empty = false;
                let Ok(entry) = entry else {
                    return false;
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                let full = format!("{path}/{name}");
                let Ok(meta) = at.symlink_metadata(&name) else {
                    return false;
                };
                if seen > MOST_ENTRIES || meta.file_type().is_symlink() {
                    return false;
                }
                if meta.is_dir() {
                    let Ok(inner) = at.open_dir(&name) else {
                        return false;
                    };
                    stack.push((full, inner));
                } else if !meta.is_file() || !wanted.contains(full.as_str()) {
                    return false;
                }
            }
            if empty {
                return false;
            }
        }
        true
    }

    /// Marks a file Spade just wrote read only (and runnable when `executable`), through a
    /// handle that never follows a link. On Windows files stay writable: a read-only file there
    /// could not be replaced or deleted when the skill changes.
    fn read_only(&self, relative: &str, executable: bool) -> Result<(), PathError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No);
            let file = self
                .dir()?
                .open_with(relative, &options)
                .map_err(|error| PathError::at(relative, error))?;
            let mode = if executable { 0o555 } else { 0o444 };
            file.set_permissions(cap_std::fs::Permissions::from_std(
                std::fs::Permissions::from_mode(mode),
            ))
            .map_err(|error| PathError::at(relative, error))?;
        }
        #[cfg(not(unix))]
        let _ = (relative, executable, OpenOptions::new(), FollowSymlinks::No);
        Ok(())
    }
}
