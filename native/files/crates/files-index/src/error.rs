// SPDX-License-Identifier: Apache-2.0

//! The one error type the index returns.

use std::io;

/// A build or update that cannot proceed. Nothing here is caused by the query text, which is
/// always accepted as plain data.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The caller asked for something the index cannot do, such as an empty file cap or a hide
    /// pattern that is not a glob.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// Reading the checkout failed in a way that is not about one folder's permissions.
    #[error("cannot read the checkout: {0}")]
    Io(#[from] io::Error),
}

impl Error {
    /// The stable wire code the daemon reports for this error.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidArgument(_) => "INVALID_ARGUMENT",
            Error::Io(error) => match error.kind() {
                io::ErrorKind::NotFound => "NOT_FOUND",
                io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
                _ => "IO_ERROR",
            },
        }
    }
}

impl From<ignore::Error> for Error {
    fn from(error: ignore::Error) -> Error {
        match error {
            ignore::Error::WithPath { err, .. }
            | ignore::Error::WithDepth { err, .. }
            | ignore::Error::WithLineNumber { err, .. } => Error::from(*err),
            ignore::Error::Glob { glob, err } => Error::InvalidArgument(match glob {
                Some(glob) => format!("{glob}: {err}"),
                None => err,
            }),
            ignore::Error::Io(error) => Error::Io(error),
            other => {
                let message = other.to_string();
                other
                    .into_io_error()
                    .map_or_else(|| Error::InvalidArgument(message), Error::Io)
            }
        }
    }
}
