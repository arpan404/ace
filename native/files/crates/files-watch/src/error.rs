// SPDX-License-Identifier: Apache-2.0

//! The one error type; `code` is the protocol code the daemon sends.

/// Why a watcher could not start.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid watch options: {0}")]
    InvalidArgument(String),
    #[error("no file watching backend is available: {0}")]
    Unsupported(String),
}

impl Error {
    /// The protocol code for this error.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::Unsupported(_) => "UNSUPPORTED",
        }
    }
}
