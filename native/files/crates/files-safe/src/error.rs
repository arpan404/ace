// SPDX-License-Identifier: Apache-2.0

//! The one error type of this crate. Every variant maps to a stable wire code.

use std::io;

/// Why a path was refused or could not be resolved.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The string is not in the relative form, so it was never looked at.
    #[error("invalid path: {0}")]
    InvalidPath(String),
    /// The path is well formed but resolves outside the root.
    #[error("path leaves the root: {0}")]
    PathEscape(String),
    /// A segment that had to be a folder is a file or something else.
    #[error("not a directory: {0}")]
    NotDirectory(String),
    /// The filesystem refused the lookup; the kind decides the code.
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl Error {
    /// The stable code the daemon and the clients route on.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidPath(_) => "INVALID_PATH",
            Error::PathEscape(_) => "PATH_ESCAPE",
            Error::NotDirectory(_) => "NOT_DIRECTORY",
            Error::Io(error) => match error.kind() {
                io::ErrorKind::NotFound => "NOT_FOUND",
                io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
                io::ErrorKind::NotADirectory => "NOT_DIRECTORY",
                io::ErrorKind::IsADirectory => "NOT_FILE",
                io::ErrorKind::AlreadyExists => "CONFLICT",
                io::ErrorKind::InvalidInput => "INVALID_PATH",
                _ => "IO_ERROR",
            },
        }
    }
}
