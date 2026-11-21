// SPDX-License-Identifier: Apache-2.0

//! The reader's one error type. Its `Display` is the message the daemon sees, so the messages
//! the TypeScript reader compared by text are kept word for word.

use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// The daemon cancelled the scan or import.
    Aborted,
    /// A path that vanished between listing and reading.
    Missing(String),
    /// Any other failure, as the message the daemon reports.
    Message(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// The message of a source that changed while it was read; compared by text, as before.
pub const CHANGED_BEFORE: &str = "Session changed before sampling";
pub const CHANGED_WHILE: &str = "Session changed while sampling";
pub const CHANGED_DURING: &str = "Session changed during import";

impl Error {
    pub fn message(text: impl Into<String>) -> Error {
        Error::Message(text.into())
    }

    /// Whether this is one of the "source changed" races that the next scan resolves.
    pub fn is_change(&self) -> bool {
        matches!(self, Error::Message(m) if m == CHANGED_BEFORE || m == CHANGED_WHILE || m == CHANGED_DURING)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Aborted => f.write_str("This operation was aborted"),
            Error::Missing(path) => write!(f, "ENOENT: no such file or directory, '{path}'"),
            Error::Message(message) => f.write_str(message),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Error {
        if error.kind() == std::io::ErrorKind::NotFound {
            Error::Missing(error.to_string())
        } else {
            Error::Message(error.to_string())
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Error {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
            return Error::Message(crate::snapshot::OVERRAN.to_owned());
        }
        Error::Message(error.to_string())
    }
}

/// A NotFound error that names its path, as Node's do.
pub fn io_at(error: std::io::Error, path: &std::path::Path) -> Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        Error::Missing(path.display().to_string())
    } else {
        Error::Message(format!("{error}, '{}'", path.display()))
    }
}
