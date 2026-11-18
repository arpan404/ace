// SPDX-License-Identifier: Apache-2.0

//! The one error type for a listing that could not be produced.

use std::io;

/// Something the caller asked for could not be done.
///
/// `code` is what the wire protocol carries, so it is stable and never derived from a message.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A relative path broke the path rules, or pointed outside the root.
    #[error(transparent)]
    Path(#[from] files_safe::Error),
    /// An option was outside what the contract allows, such as a `limit` of 0.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// A path is not a folder, so it cannot be listed.
    #[error("not a directory: {0}")]
    NotDirectory(String),
    /// A cursor was not handed out for this folder as it is now.
    #[error("invalid cursor: {0}")]
    InvalidCursor(String),
    /// The file system refused a call.
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl Error {
    /// A stable code for the wire protocol: the daemon sends it to the client unchanged.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Path(error) => error.code(),
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::NotDirectory(_) => "NOT_DIRECTORY",
            Error::InvalidCursor(_) => "INVALID_CURSOR",
            Error::Io(error) => match error.kind() {
                io::ErrorKind::NotFound => "NOT_FOUND",
                io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
                io::ErrorKind::NotADirectory => "NOT_DIRECTORY",
                io::ErrorKind::InvalidInput => "INVALID_ARGUMENT",
                _ => "IO_ERROR",
            },
        }
    }
}
