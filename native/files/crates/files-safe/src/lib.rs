// SPDX-License-Identifier: Apache-2.0

//! Every path ace-files touches is relative to a checkout root and must stay inside it.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("path leaves the root: {0}")]
    PathEscape(String),
    #[error("not a directory: {0}")]
    NotDirectory(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidPath(_) => "INVALID_PATH",
            Error::PathEscape(_) => "PATH_ESCAPE",
            Error::NotDirectory(_) => "NOT_DIRECTORY",
            Error::Io(error) => match error.kind() {
                std::io::ErrorKind::NotFound => "NOT_FOUND",
                std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
                _ => "IO_ERROR",
            },
        }
    }
}

/// A checkout root: its canonical path and a capability handle for I/O inside it.
#[derive(Clone)]
pub struct Root {
    path: PathBuf,
    dir: Arc<cap_std::fs::Dir>,
}

impl Root {
    pub fn open(path: &Path) -> Result<Root, Error> {
        let path = std::fs::canonicalize(path)?;
        if !path.is_dir() {
            return Err(Error::NotDirectory(path.display().to_string()));
        }
        let dir = cap_std::fs::Dir::open_ambient_dir(&path, cap_std::ambient_authority())?;
        Ok(Root {
            path,
            dir: Arc::new(dir),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn dir(&self) -> &cap_std::fs::Dir {
        &self.dir
    }

    /// Syntax only: `/`-separated, no leading `/`, no `.` or `..`, no NUL, no trailing `/`.
    /// The empty string is the root itself.
    pub fn check(rel: &str) -> Result<&str, Error> {
        let bad = rel.starts_with('/')
            || rel.ends_with('/')
            || rel.contains('\0')
            || rel.contains('\\')
            || (!rel.is_empty() && rel.split('/').any(|part| matches!(part, "" | "." | "..")));
        if bad {
            Err(Error::InvalidPath(rel.to_owned()))
        } else {
            Ok(rel)
        }
    }

    /// The absolute path for `rel`, symlinks resolved; a missing leaf resolves under its parent.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, Error> {
        Root::check(rel)?;
        let joined = self.path.join(rel);
        let resolved = match std::fs::canonicalize(&joined) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let (parent, name) = match (joined.parent(), joined.file_name()) {
                    (Some(parent), Some(name)) => (parent, name),
                    _ => return Err(Error::InvalidPath(rel.to_owned())),
                };
                std::fs::canonicalize(parent)?.join(name)
            }
            Err(error) => return Err(error.into()),
        };
        if resolved.starts_with(&self.path) {
            Ok(resolved)
        } else {
            Err(Error::PathEscape(rel.to_owned()))
        }
    }

    /// The relative form of an absolute path inside the root; `None` outside it.
    pub fn relative(&self, absolute: &Path) -> Option<String> {
        let rest = absolute.strip_prefix(&self.path).ok()?;
        let mut parts = Vec::new();
        for component in rest.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_str()?.to_owned()),
                _ => return None,
            }
        }
        Some(parts.join("/"))
    }
}
