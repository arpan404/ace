//! Which file a workspace path names (cowork, ADR 0143), so "the person changed this a moment
//! ago" can't be dodged by spelling it differently. Two paths name the same file when their
//! resolved names match (folders' links followed, compared without case on a volume that ignores
//! it) or, where the file exists, when they are the same file on disk (device and inode). The
//! name still matches after the file is deleted or made again.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{PathError, Workspace, clean};

/// A path's identity in its workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    /// Relative to the workspace's resolved folder, with links in folders followed; folded to
    /// lower case on a volume that ignores case.
    pub name: String,
    /// Device and inode, when the file exists (not on Windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<(u64, u64)>,
}

impl Identity {
    /// Whether the two name the same file.
    pub fn same(&self, other: &Self) -> bool {
        self.name == other.name || (self.file.is_some() && self.file == other.file)
    }
}

/// Whether the volume holding the folder `path` (resolved) treats names that differ only by
/// case as one: a folder spelt with its last name's case swapped is the same folder. The probe
/// uses `path` or the nearest folder above it on the same volume whose name has letters to swap.
/// When none has, the volume counts as minding case: names then match only as spelt, and files
/// that exist still match by device and inode.
fn ignores_case(path: &Path) -> bool {
    let device = file_id(path).map(|(device, _)| device);
    for folder in path.ancestors() {
        if file_id(folder).map(|(device, _)| device) != device {
            break;
        }
        let (Some(name), Some(parent)) =
            (folder.file_name().and_then(|n| n.to_str()), folder.parent())
        else {
            break;
        };
        let swapped = swap_case(name);
        if swapped == name {
            continue;
        }
        return match (file_id(folder), file_id(&parent.join(swapped))) {
            (Some(this), Some(other)) => this == other,
            (Some(_), None) => false,
            // Windows (no inode here) ignores case.
            _ => cfg!(windows),
        };
    }
    cfg!(windows)
}

fn swap_case(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_lowercase() {
                c.to_uppercase().next().unwrap_or(c)
            } else {
                c.to_lowercase().next().unwrap_or(c)
            }
        })
        .collect()
}

#[cfg(unix)]
fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn file_id(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// `path` with its longest existing ancestor resolved and the rest appended as written.
fn resolved(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&existing) {
            let mut out = real;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (
            existing.file_name().map(ToOwned::to_owned),
            existing.parent(),
        ) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

impl Workspace {
    /// The identity of the file at `relative`, whether or not it exists. A path whose folders
    /// lead outside the workspace is refused.
    pub fn identity(&self, relative: &str) -> Result<Identity, PathError> {
        let cleaned = clean(relative)?;
        let Some(name) = cleaned.file_name() else {
            return Err(PathError::Io("that is the workspace itself".to_owned()));
        };
        let root = std::fs::canonicalize(self.path()?)?;
        let parent = resolved(&root.join(cleaned.parent().unwrap_or(Path::new(""))));
        let inside = parent
            .strip_prefix(&root)
            .map_err(|_| PathError::Outside(relative.to_owned()))?;
        let mut parts: Vec<String> = inside
            .components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        parts.push(name.to_string_lossy().into_owned());
        let mut joined = parts.join("/");
        if ignores_case(&root) {
            joined = joined.to_lowercase();
        }
        Ok(Identity {
            name: joined,
            file: file_id(&parent.join(name)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ignores_case;

    #[test]
    fn a_folder_named_without_letters_judges_case_like_its_volume() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let digits = dir.path().join("12345");
        let letters = dir.path().join("Workspace");
        std::fs::create_dir(&digits)?;
        std::fs::create_dir(&letters)?;
        let digits = std::fs::canonicalize(digits)?;
        let letters = std::fs::canonicalize(letters)?;
        assert_eq!(ignores_case(&digits), ignores_case(&letters));
        Ok(())
    }
}
