// SPDX-License-Identifier: Apache-2.0

//! The one error this crate returns: a transaction whose changes break the model.

/// A rejected operation. Every public fallible call returns this.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// Two changes in one transaction overlap, or a change is out of order.
    #[error("invalid edit: {0}")]
    InvalidEdit(String),
}

impl Error {
    /// The wire code the daemon and clients share.
    pub fn code(&self) -> &'static str {
        match self {
            Error::InvalidEdit(_) => "INVALID_ARGUMENT",
        }
    }
}
