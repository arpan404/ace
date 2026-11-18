// SPDX-License-Identifier: Apache-2.0

use std::io::ErrorKind;

/// Every failure a file operation can report.
///
/// `code` is the stable value the daemon sends on the wire; the variants carry the detail only
/// logs and error messages read.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The path is malformed or leaves the checkout root; `files-safe` decided which.
    #[error(transparent)]
    Path(#[from] files_safe::Error),
    #[error("not a regular file: {0}")]
    NotFile(String),
    /// A guarded operation saw a different file than the caller was working from.
    #[error("file changed on disk: {path}")]
    Conflict {
        path: String,
        /// The version that was found, or `None` when nothing was there.
        current: Option<String>,
    },
    #[error("too much to walk: {0}")]
    LimitExceeded(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The caller's cancel flag went up before the walk finished.
    #[error("aborted")]
    Aborted,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Error {
    /// The stable wire code for this failure.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Path(error) => error.code(),
            Error::NotFile(_) => "NOT_FILE",
            Error::Conflict { .. } => "CONFLICT",
            Error::LimitExceeded(_) => "LIMIT_EXCEEDED",
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::Aborted => "ABORTED",
            Error::Io(error) => io_code(error),
        }
    }
}

/// `io::ErrorKind` in wire terms.
fn io_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        ErrorKind::NotFound => "NOT_FOUND",
        ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => "CONFLICT",
        ErrorKind::IsADirectory => "NOT_FILE",
        ErrorKind::NotADirectory => "NOT_DIRECTORY",
        ErrorKind::InvalidInput => "INVALID_ARGUMENT",
        _ => "IO_ERROR",
    }
}
