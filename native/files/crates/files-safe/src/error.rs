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
    /// The root folder is no longer what the root path names: it was moved, or replaced by a
    /// link to somewhere else. Nothing inside the held handle is trusted after that.
    #[error("root changed: {0}")]
    PathChanged(String),
    /// A segment that had to be a folder is a file or something else.
    #[error("not a directory: {0}")]
    NotDirectory(String),
    /// The path chains more links than the operating system would follow.
    #[error("link loop: {0}")]
    LinkLoop(String),
    /// The path needs more segments than a walk is allowed to visit.
    #[error("limit exceeded: {0}")]
    LimitExceeded(String),
    /// The filesystem refused the lookup; the kind decides the code.
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl Error {
    /// The stable code the daemon and the clients route on.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidPath(_) | Error::LinkLoop(_) => "INVALID_PATH",
            Error::LimitExceeded(_) => "LIMIT_EXCEEDED",
            Error::PathEscape(_) => "PATH_ESCAPE",
            Error::PathChanged(_) => "PATH_CHANGED",
            Error::NotDirectory(_) => "NOT_DIRECTORY",
            Error::Io(error) => match error.kind() {
                io::ErrorKind::NotFound => "NOT_FOUND",
                io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
                io::ErrorKind::NotADirectory => "NOT_DIRECTORY",
                io::ErrorKind::IsADirectory => "NOT_FILE",
                io::ErrorKind::AlreadyExists => "CONFLICT",
                // A name the filesystem cannot take, such as one over the platform's length limit.
                io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename => "INVALID_PATH",
                _ => "IO_ERROR",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::Error;

    #[test]
    fn maps_io_kinds_to_the_wire_codes() {
        for (kind, code) in [
            (io::ErrorKind::NotFound, "NOT_FOUND"),
            (io::ErrorKind::PermissionDenied, "PERMISSION_DENIED"),
            (io::ErrorKind::NotADirectory, "NOT_DIRECTORY"),
            (io::ErrorKind::IsADirectory, "NOT_FILE"),
            (io::ErrorKind::AlreadyExists, "CONFLICT"),
            (io::ErrorKind::InvalidInput, "INVALID_PATH"),
            (io::ErrorKind::InvalidFilename, "INVALID_PATH"),
            (io::ErrorKind::Other, "IO_ERROR"),
        ] {
            assert_eq!(Error::from(io::Error::from(kind)).code(), code, "{kind:?}");
        }
        assert_eq!(Error::InvalidPath(String::new()).code(), "INVALID_PATH");
        assert_eq!(Error::PathEscape(String::new()).code(), "PATH_ESCAPE");
        assert_eq!(Error::PathChanged(String::new()).code(), "PATH_CHANGED");
        assert_eq!(Error::NotDirectory(String::new()).code(), "NOT_DIRECTORY");
        assert_eq!(Error::LinkLoop(String::new()).code(), "INVALID_PATH");
        assert_eq!(Error::LimitExceeded(String::new()).code(), "LIMIT_EXCEEDED");
    }
}
