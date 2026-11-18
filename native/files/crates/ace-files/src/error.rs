// SPDX-License-Identifier: Apache-2.0

//! The binary's error type, and the `error` message a failure becomes.

/// What a failed request tells the daemon: a stable code, a sentence for the log, and the file's
/// version when the failure was a conflict, so the client can offer to reload it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// One of the codes `files-wire` defines, such as `NOT_FOUND` or `CONFLICT`.
    pub code: &'static str,
    /// A sentence describing what went wrong.
    pub message: String,
    /// The version the file has now, when a guarded write lost a race.
    pub current: Option<String>,
}

impl Failure {
    /// A failure with no version to report.
    pub fn new(code: &'static str, message: impl Into<String>) -> Failure {
        Failure {
            code,
            message: message.into(),
            current: None,
        }
    }
}

/// Everything a request can fail with, one variant per crate that can refuse it.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The path broke `files-safe`'s rules or left the root.
    #[error(transparent)]
    Safe(#[from] files_safe::Error),
    /// The lister refused the request.
    #[error(transparent)]
    List(#[from] files_list::Error),
    /// The path index could not be built, or was stopped.
    #[error(transparent)]
    Index(#[from] files_index::Error),
    /// The search could not start or did not finish.
    #[error(transparent)]
    Search(#[from] files_search::Error),
    /// A read, write or mutation refused the request.
    #[error(transparent)]
    Io(#[from] files_io::Error),
    /// The watcher could not start.
    #[error(transparent)]
    Watch(#[from] files_watch::Error),
    /// An option was outside what the contract allows.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The request's cancel flag went up before it finished.
    #[error("aborted")]
    Aborted,
    /// The operating system refused a call that is not about one path.
    #[error(transparent)]
    System(#[from] std::io::Error),
}

impl Error {
    /// The stable code the daemon routes on.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Safe(error) => error.code(),
            Error::List(error) => error.code(),
            Error::Index(error) => error.code(),
            Error::Search(error) => error.code(),
            Error::Io(error) => error.code(),
            Error::Watch(error) => error.code(),
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::Aborted => "ABORTED",
            Error::System(error) => match error.kind() {
                std::io::ErrorKind::NotFound => "NOT_FOUND",
                std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
                std::io::ErrorKind::AlreadyExists => "CONFLICT",
                _ => "IO_ERROR",
            },
        }
    }

    /// The version a conflict found on disk, when the crate that refused carries one.
    pub fn current(&self) -> Option<String> {
        match self {
            Error::Io(files_io::Error::Conflict { current, .. }) => current.clone(),
            _ => None,
        }
    }

    /// The message this error becomes on the wire.
    pub fn failure(&self) -> Failure {
        Failure {
            code: self.code(),
            message: self.to_string(),
            current: self.current(),
        }
    }
}
