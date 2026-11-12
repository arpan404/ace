//! Each bot's workspace (ADR 0130): a folder under Spade's data folder, `workspace/<bot id>/`,
//! with file tools bounded to it and a shell that runs there.
//!
//! Every file operation goes through the workspace's opened directory handle (`cap-std`), one
//! component at a time relative to it, so a path, a symlink or a folder swapped mid-operation can
//! never reach outside. Paths are relative; absolute paths, `~` and `..` are refused up front.
//! Writes go to a temporary file beside the target and are renamed over it, never truncated in
//! place, and a file with more than one hard link is never written.

mod files;
pub mod shell;
mod tools;
pub mod trust;

use std::path::{Component, Path, PathBuf};

use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;

pub use files::{Entry, EntryKind, FileView, Listing};
pub use tools::{
    ShellTool, WorkspaceEdit, WorkspaceList, WorkspaceRead, WorkspaceSearch, WorkspaceWrite,
    tools as workspace_tools,
};
pub use trust::Trust;

/// Results longer than this are kept as a file and the model gets the head, the tail and the path.
pub const LARGE_OUTPUT_CHARS: usize = 16_000;
/// Where large outputs go, inside a workspace.
pub const OUTPUTS: &str = ".spade/outputs";
/// Where each bot's trust record is kept, inside the workspaces' root (outside every bot's own
/// folder; bot ids never start with a dot).
const TRUST_DIR: &str = ".trust";

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

impl PathError {
    /// An I/O error on `relative`, in words: a path cap-std refused as escaping is `Outside`.
    fn at(relative: &str, error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::Missing(relative.to_owned()),
            std::io::ErrorKind::PermissionDenied => Self::Outside(relative.to_owned()),
            _ => Self::Io(format!("{relative}: {error}")),
        }
    }
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
    /// Held while a trust record is read and written.
    trust_lock: std::sync::Arc<std::sync::Mutex<()>>,
}

impl Workspaces {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            trust_lock: std::sync::Arc::default(),
        }
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
            root: self.root.clone(),
            bot: bot.to_owned(),
            trust: Trust::new(
                self.root.join(TRUST_DIR).join(format!("{bot}.json")),
                self.trust_lock.clone(),
            ),
        })
    }

    /// Deletes the bot's workspace, everything in it and its trust record.
    pub fn remove(&self, bot: &str) -> Result<(), PathError> {
        let workspace = self.of(bot)?;
        workspace.trust.forget();
        let root = match Dir::open_ambient_dir(&self.root, ambient_authority()) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        match root.symlink_metadata(bot) {
            Ok(meta) if meta.is_dir() => Ok(root.remove_dir_all(bot)?),
            Ok(_) => Ok(root.remove_file(bot)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// One bot's folder.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
    bot: String,
    trust: Trust,
}

impl Workspace {
    /// The folder, opened as a handle every operation is relative to; created if missing. A
    /// symlink in the folder's own place is refused.
    pub fn dir(&self) -> Result<Dir, PathError> {
        std::fs::create_dir_all(&self.root)?;
        let root = Dir::open_ambient_dir(&self.root, ambient_authority())?;
        match root.create_dir(&self.bot) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        root.open_dir_nofollow(&self.bot)
            .map_err(|_| PathError::Outside(self.bot.clone()))
    }

    /// The folder's path, for the shell's working directory. Checked to be a real folder.
    pub fn path(&self) -> Result<PathBuf, PathError> {
        self.dir()?;
        Ok(self.root.join(&self.bot))
    }

    /// `relative` as the tools and the taint record name it, or why it is refused.
    pub fn normal(&self, relative: &str) -> Result<String, PathError> {
        clean(relative).map(|path| shown(&path))
    }

    /// Which of this bot's files are trusted.
    pub fn trust(&self) -> &Trust {
        &self.trust
    }

    /// Keeps a long result as a file and answers what the model is shown instead: the head, the
    /// tail and the file's path. Short text comes back as it is. A kept file is never trusted.
    pub fn keep_large(&self, name: &str, text: &str) -> String {
        let count = text.chars().count();
        if count <= LARGE_OUTPUT_CHARS {
            return text.to_owned();
        }
        let file = format!("{OUTPUTS}/{name}.txt");
        let kept = self.write(&file, text).map(|_| ());
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

/// A cleaned path as the model and the person see it: relative, with `/`.
fn shown(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
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
        assert!(all.of(".trust").is_err());
        assert!(all.of("a_1").is_ok());
    }
}
