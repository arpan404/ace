// SPDX-License-Identifier: Apache-2.0

//! Failures a search reports.

/// Why a search stopped without finishing.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The request itself is unusable: an empty pattern, a regex that does not compile, or a
    /// glob that does not parse.
    #[error("invalid search argument: {0}")]
    InvalidArgument(String),
    /// The caller's cancel flag was set before the search finished.
    #[error("search aborted")]
    Aborted,
}

impl Error {
    /// The stable error code the daemon puts on the wire.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::Aborted => "ABORTED",
        }
    }
}
