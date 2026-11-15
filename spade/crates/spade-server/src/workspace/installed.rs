//! A loaded skill's files in the bot's workspace (ADR 0151, point 5): `skills/<name>/`, written
//! read only when the skill is loaded and replaced when it changed. The person installed the
//! skill, so its files are trusted: each is recorded with its hash, and one a command rewrites
//! no longer matches and reads as untrusted like any other file a command changed.

use std::path::Path;

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::OpenOptions;

use super::{PathError, Workspace, clean, shown};
use crate::tools::SkillFileData;

/// Where loaded skills' files go in a workspace.
pub const SKILLS_FOLDER: &str = "skills";

/// A skill's file is at most this large (the daemon's own limit), with room to spare.
const LARGEST_SKILL_FILE: usize = 2 * 1024 * 1024;

impl Workspace {
    /// Puts `files` in `skills/<name>/` and answers that folder. When each file is already there
    /// with the same content, still trusted, nothing is written; otherwise the folder is
    /// replaced whole, so nothing of an older version is left. No files, no folder.
    pub fn place_skill(&self, name: &str, files: &[SkillFileData]) -> Result<String, PathError> {
        let one = clean(name)?;
        if one.components().count() != 1 || name.starts_with('.') {
            return Err(PathError::Unusable(name.to_owned()));
        }
        let folder = format!("{SKILLS_FOLDER}/{}", shown(&one));
        if files.is_empty() {
            return Ok(folder);
        }
        let mut placed = Vec::with_capacity(files.len());
        for file in files {
            let path = clean(&format!("{folder}/{}", file.path))?;
            if !path.starts_with(Path::new(SKILLS_FOLDER).join(&one)) {
                return Err(PathError::Parent);
            }
            placed.push((shown(&path), file));
        }
        self.changing(|| {
            let current = placed.iter().all(|(path, file)| {
                self.bytes_up_to(path, LARGEST_SKILL_FILE as u64)
                    .is_ok_and(|bytes| bytes == file.bytes && self.file_trusted(path, &bytes))
            });
            if current {
                return Ok(());
            }
            match self.delete(&folder) {
                Ok(()) | Err(PathError::Missing(_)) => {}
                Err(error) => return Err(error),
            }
            for (path, file) in &placed {
                self.write_bytes(path, &file.bytes, LARGEST_SKILL_FILE)?;
                self.read_only(path, file.executable)?;
                self.trust().record_installed(path, &file.bytes);
            }
            Ok(())
        })?;
        Ok(folder)
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
