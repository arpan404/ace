// SPDX-License-Identifier: Apache-2.0

//! Root confinement: every path ace-files touches must stay inside one checkout root.
//!
//! Paths cross the wire as relative strings in exactly one form: `/`-separated, no leading or
//! trailing `/`, no empty, `.` or `..` segments, no NUL, plus the names Windows refuses.
//! [`Root::check`] enforces that form and [`Root::resolve`] turns one into an absolute path that
//! is proven to sit inside the root, following symbolic links only while they stay inside.
//! Crates above this one call these two and never join a path themselves, so a traversal bug can
//! only exist in one place.

mod check;
mod error;
mod resolve;
#[cfg(any(windows, test))]
mod windows;

pub use crate::error::Error;

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// A checkout root: its canonical path plus a capability handle that reaches inside it.
///
/// The handle is what I/O code opens files through. It resolves every path relative to the root
/// folder, so the kernel itself refuses to leave the tree even if a caller passes a bad path.
#[derive(Clone)]
pub struct Root {
    path: PathBuf,
    dir: Arc<cap_std::fs::Dir>,
}

impl Root {
    /// Opens `path` as a root. The path is canonicalized, so the root reports the real folder
    /// (symlinks resolved) and later comparisons are exact.
    ///
    /// Fails with `NOT_DIRECTORY` when the path exists but is not a folder, and `NOT_FOUND` when
    /// it does not exist.
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

    /// The canonical absolute path of the root folder.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A capability handle on the root folder, for opening files and folders inside it.
    pub fn dir(&self) -> &cap_std::fs::Dir {
        &self.dir
    }

    /// Validates the relative form without touching the filesystem: `/`-separated, no leading or
    /// trailing `/`, no empty, `.` or `..` segments, no NUL. The empty string is the root itself.
    ///
    /// On Windows a segment also may not contain `\` or `:`, end in a dot or a space, or name a
    /// device such as `CON` or `NUL`; those spellings mean something else there than they do on
    /// Unix, so they are refused rather than guessed at.
    pub fn check(rel: &str) -> Result<&str, Error> {
        check::check(rel)
    }

    /// The absolute path for `rel`, with every symbolic link resolved.
    ///
    /// A link that leaves the root is `PATH_ESCAPE`, as is any segment that would climb out. A
    /// path whose last segment does not exist yet resolves under its parent, which is what callers
    /// that are about to create a file need; a missing segment anywhere higher up is `NOT_FOUND`.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, Error> {
        resolve::resolve(self, rel)
    }

    /// The relative form of `absolute`, the inverse of [`Root::resolve`]; `None` outside the root.
    ///
    /// The root itself maps to the empty string. Paths carrying `.` or `..` are `None`, since
    /// they are not in the form the rest of ace-files accepts.
    pub fn relative(&self, absolute: &Path) -> Option<String> {
        if let Ok(rest) = absolute.strip_prefix(&self.path) {
            return encode(rest);
        }
        #[cfg(windows)]
        return windows::relative(self.path.to_str()?, absolute.to_str()?);
        #[cfg(not(windows))]
        None
    }
}

/// Turns a path inside the root into the `/`-separated form, or `None` if it is not one.
fn encode(rest: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in rest.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_owned()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}
