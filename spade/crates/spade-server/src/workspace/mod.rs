//! Each bot's workspace (ADR 0130): a folder under Spade's data folder, `workspace/<bot id>/`,
//! with file tools bounded to it and a shell that runs there.
//!
//! Every file operation goes through the workspace's opened directory handle (`cap-std`), one
//! component at a time relative to it, so a path, a symlink or a folder swapped mid-operation can
//! never reach outside. Paths are relative; absolute paths, `~` and `..` are refused up front.
//! Writes go to a temporary file beside the target and are renamed over it, never truncated in
//! place, and a file with more than one hard link is never written.

mod files;
mod person;
pub mod shell;
mod tools;
pub mod trust;

use std::path::{Component, Path, PathBuf};

use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;

pub use files::{Entry, EntryKind, FileView, Listing};
pub use person::{Seen, Snapshot, changes};
pub use tools::{
    Commands, ShellTool, WorkspaceEdit, WorkspaceList, WorkspaceRead, WorkspaceSearch,
    WorkspaceWrite, tools as workspace_tools,
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
    #[error("{0} is not a name this system can keep as a file")]
    Unusable(String),
    #[error("{0} does not exist")]
    Missing(String),
    #[error("{0} is already there")]
    Exists(String),
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
            Component::Normal(part) => {
                if !usable(&part.to_string_lossy()) {
                    return Err(PathError::Unusable(trimmed.to_owned()));
                }
                out.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(PathError::Parent),
            Component::RootDir | Component::Prefix(_) => {
                return Err(PathError::Absolute(trimmed.to_owned()));
            }
        }
    }
    Ok(out)
}

/// Whether `name` is one plain file name on this system. On Windows a device name (`CON`,
/// `nul.txt`, `COM1`), a stream (`a.txt:hidden`), a trailing dot or space (Windows drops them,
/// so `a.txt.` is `a.txt`) and the characters Windows refuses are not: each would reach a
/// device, hide data in another file or name a file other than the one written down.
fn usable(name: &str) -> bool {
    if !cfg!(windows) {
        return true;
    }
    const DEVICES: &[&str] = &["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"];
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    let stem = stem.to_ascii_uppercase();
    let numbered = ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|rest| {
            matches!(
                rest,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
            ) || matches!(rest, "\u{b9}" | "\u{b2}" | "\u{b3}")
        })
    });
    !(DEVICES.contains(&stem.as_str())
        || numbered
        || name.ends_with('.')
        || name.ends_with(' ')
        || name
            .chars()
            .any(|c| c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')))
}

/// `name` as one this system can keep as a file, for names Spade did not choose (an attached
/// file's): on Windows the characters [`usable`] refuses become `_`, trailing dots and spaces go,
/// and a device name gets `_` after it (`CON.txt` is `CON_.txt`). Elsewhere it is unchanged.
pub fn storable(name: &str) -> String {
    if !cfg!(windows) || usable(name) {
        return name.to_owned();
    }
    let replaced: String = name
        .chars()
        .map(|c| {
            if c < ' ' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced.trim_end_matches(['.', ' ']);
    let name = if trimmed.is_empty() { "file" } else { trimmed };
    if usable(name) {
        return name.to_owned();
    }
    // Only a device name is left to refuse; `_` after its stem makes it a plain name.
    match name.split_once('.') {
        Some((stem, rest)) => format!("{stem}_.{rest}"),
        None => format!("{name}_"),
    }
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
    fn windows_paths_that_name_another_place_are_refused() {
        if !cfg!(windows) {
            return;
        }
        for absolute in [
            r"C:\Windows\win.ini",
            r"C:win.ini",
            r"\\server\share\x",
            r"\\?\C:\x",
            r"\\.\pipe\x",
            r"\Windows",
        ] {
            assert!(
                matches!(clean(absolute), Err(PathError::Absolute(_))),
                "{absolute}"
            );
        }
        assert_eq!(clean(r"a\..\..\x"), Err(PathError::Parent));
        assert_eq!(clean(r"a\b.txt"), Ok(PathBuf::from("a").join("b.txt")));
        assert_eq!(shown(&clean(r"a\b.txt").unwrap_or_default()), "a/b.txt");
    }

    #[test]
    fn windows_device_names_streams_and_aliases_are_refused() {
        let refused = [
            "CON",
            "nul",
            "nul.txt",
            "Aux.tar.gz",
            "a/COM1",
            "lpt9.log",
            "COM\u{b9}",
            "conin$",
            "notes.txt:hidden",
            "notes.txt::$DATA",
            "notes.txt.",
            "folder /notes.txt",
            "what?.txt",
            "a*b",
        ];
        for name in refused {
            let result = clean(name);
            if cfg!(windows) {
                assert!(matches!(result, Err(PathError::Unusable(_))), "{name}");
            } else {
                assert!(result.is_ok(), "{name} is a plain name off Windows");
            }
        }
        for fine in [
            "console.txt",
            "nullable.rs",
            "com10",
            "a.b.c",
            ".spade/outputs/x.txt",
        ] {
            assert!(clean(fine).is_ok(), "{fine}");
        }
    }

    #[test]
    fn a_name_windows_refuses_becomes_one_it_keeps() {
        let names = [
            ("Meeting 10:30.pdf", "Meeting 10_30.pdf"),
            ("why?.docx", "why_.docx"),
            ("\"draft\".txt", "_draft_.txt"),
            ("notes.", "notes"),
            ("notes. . ", "notes"),
            ("a: b?.pdf", "a_ b_.pdf"),
            ("CON.txt", "CON_.txt"),
            ("nul", "nul_"),
            ("...", "file"),
        ];
        for (given, kept) in names {
            let stored = storable(given);
            if cfg!(windows) {
                assert_eq!(stored, kept, "{given}");
                assert!(clean(&stored).is_ok(), "{given} -> {stored}");
            } else {
                assert_eq!(stored, given, "names are kept as given off Windows");
            }
        }
        assert_eq!(storable("report.pdf"), "report.pdf");
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
