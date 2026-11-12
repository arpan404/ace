//! Each bot's workspace (ADR 0130): a folder under Spade's data folder, `workspace/<bot id>/`,
//! with file tools bounded to it and a shell that runs there. Paths are always relative to the
//! folder; anything that resolves outside it, after following symlinks, is refused.

pub mod allow;
mod files;
pub mod shell;
mod tools;

use std::path::{Component, Path, PathBuf};

pub use files::{Entry, EntryKind, FileView, Listing};
pub use tools::{
    ShellTool, WorkspaceEdit, WorkspaceList, WorkspaceRead, WorkspaceSearch, WorkspaceWrite,
    tools as workspace_tools,
};

/// Results longer than this are kept as a file and the model gets the head, the tail and the path.
pub const LARGE_OUTPUT_CHARS: usize = 16_000;
/// Where large outputs go, inside a workspace.
pub const OUTPUTS: &str = ".spade/outputs";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PathError {
    #[error("give a path inside the workspace, relative to it (not {0})")]
    Absolute(String),
    #[error("paths may not use `..`")]
    Parent,
    #[error("{0} leads outside the workspace")]
    Outside(String),
    #[error("{0} does not exist")]
    Missing(String),
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for PathError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// Every bot's workspace, under one root (`<data folder>/workspace`).
#[derive(Debug, Clone)]
pub struct Workspaces {
    root: PathBuf,
}

impl Workspaces {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The bot's workspace. Its folder is created on first use; `bot` must be an id Spade made.
    pub fn of(&self, bot: &str) -> Result<Workspace, PathError> {
        if bot.is_empty()
            || !bot
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(PathError::Io(format!("{bot} is not a bot id")));
        }
        Ok(Workspace {
            dir: self.root.join(bot),
        })
    }

    /// Deletes the bot's workspace and everything in it, if it has one.
    pub fn remove(&self, bot: &str) -> Result<(), PathError> {
        let workspace = self.of(bot)?;
        match std::fs::remove_dir_all(&workspace.dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// One bot's folder.
#[derive(Debug, Clone)]
pub struct Workspace {
    dir: PathBuf,
}

impl Workspace {
    /// The folder, created if missing, with symlinks resolved.
    pub fn root(&self) -> Result<PathBuf, PathError> {
        std::fs::create_dir_all(&self.dir)?;
        Ok(std::fs::canonicalize(&self.dir)?)
    }

    /// The real path of `relative`, which must exist and lie inside the workspace.
    pub fn existing(&self, relative: &str) -> Result<PathBuf, PathError> {
        let root = self.root()?;
        let joined = root.join(clean(relative)?);
        let real = match std::fs::canonicalize(&joined) {
            Ok(real) => real,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(PathError::Missing(relative.to_owned()));
            }
            Err(error) => return Err(error.into()),
        };
        inside(&root, &real, relative)?;
        Ok(real)
    }

    /// Where a file at `relative` would be written: its folders are created, and the folder and
    /// any existing file (or link) at the path must resolve inside the workspace.
    pub fn writable(&self, relative: &str) -> Result<PathBuf, PathError> {
        let root = self.root()?;
        let cleaned = clean(relative)?;
        let Some(name) = cleaned.file_name().map(ToOwned::to_owned) else {
            return Err(PathError::Io("give a file name".to_owned()));
        };
        let parent = root.join(cleaned.parent().unwrap_or(Path::new("")));
        // Each existing folder on the way is checked before anything is created under it.
        let mut at = root.clone();
        for part in cleaned.parent().unwrap_or(Path::new("")).components() {
            at.push(part);
            match std::fs::symlink_metadata(&at) {
                Ok(_) => {
                    let real = std::fs::canonicalize(&at)?;
                    inside(&root, &real, relative)?;
                    at = real;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&at)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        let folder = std::fs::canonicalize(&parent)?;
        inside(&root, &folder, relative)?;
        let target = folder.join(name);
        if std::fs::symlink_metadata(&target).is_ok() {
            let real = std::fs::canonicalize(&target)
                .map_err(|_| PathError::Outside(relative.to_owned()))?;
            inside(&root, &real, relative)?;
            return Ok(real);
        }
        Ok(target)
    }

    /// `path` (inside the workspace) as the model and the person see it: relative, with `/`.
    pub fn shown(&self, path: &Path) -> String {
        let root = self.root().unwrap_or_else(|_| self.dir.clone());
        path.strip_prefix(&root)
            .unwrap_or(path)
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// Keeps a long result as a file and answers what the model is shown instead: the head, the
    /// tail and the file's path. Short text comes back as it is.
    pub fn keep_large(&self, name: &str, text: &str) -> String {
        let count = text.chars().count();
        if count <= LARGE_OUTPUT_CHARS {
            return text.to_owned();
        }
        let file = format!("{OUTPUTS}/{name}.txt");
        let kept = self
            .writable(&file)
            .and_then(|path| std::fs::write(&path, text).map_err(PathError::from));
        let part = LARGE_OUTPUT_CHARS * 3 / 8;
        let head: String = text.chars().take(part).collect();
        let tail: String = text.chars().skip(count - part).collect();
        let note = match kept {
            Ok(()) => format!(
                "[{count} characters in all. The whole output is in {file}; read it with \
                 workspace_read.]"
            ),
            Err(error) => format!("[{count} characters in all; it could not be kept: {error}]"),
        };
        format!(
            "{head}\n[… {} characters left out …]\n{tail}\n{note}",
            count - 2 * part
        )
    }
}

/// `relative` as plain names, or why it is refused. Empty and `.` mean the folder itself.
fn clean(relative: &str) -> Result<PathBuf, PathError> {
    let trimmed = relative.trim();
    let path = Path::new(trimmed);
    if path.is_absolute() || path.has_root() || trimmed.starts_with('~') {
        return Err(PathError::Absolute(trimmed.to_owned()));
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => return Err(PathError::Parent),
            Component::RootDir | Component::Prefix(_) => {
                return Err(PathError::Absolute(trimmed.to_owned()));
            }
        }
    }
    Ok(out)
}

fn inside(root: &Path, real: &Path, relative: &str) -> Result<(), PathError> {
    if real.starts_with(root) {
        Ok(())
    } else {
        Err(PathError::Outside(relative.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_plain_names_inside_the_folder() {
        assert_eq!(clean("a/./b.txt"), Ok(PathBuf::from("a/b.txt")));
        assert_eq!(clean(""), Ok(PathBuf::new()));
        assert_eq!(clean("a/../../x"), Err(PathError::Parent));
        assert!(matches!(clean("/etc/passwd"), Err(PathError::Absolute(_))));
        assert!(matches!(clean("~/.ssh"), Err(PathError::Absolute(_))));
    }

    #[test]
    fn a_bot_id_with_path_characters_has_no_workspace() {
        let all = Workspaces::new("/tmp/nowhere");
        assert!(all.of("../a_1").is_err());
        assert!(all.of("a/b").is_err());
        assert!(all.of("a_1").is_ok());
    }
}
