// SPDX-License-Identifier: Apache-2.0
//! Why an access step was refused, as `AccessError` carries it (`remote-auth.ts:15`–`:21`): an
//! HTTP status and the exact words the client is shown. The words are contract; tests compare
//! them byte for byte.

use thiserror::Error;

/// The refusal `AccessError` has always been: the status its route answers with and the text.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct AccessError {
    pub status: u16,
    pub message: String,
}

impl AccessError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

/// A step's failure: the refusals above, or a store read/write that failed.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("{0}")]
    Access(#[from] AccessError),
    #[error(transparent)]
    Store(#[from] ace_store::Error),
    /// A token file that can't be read or doesn't hold a 64-hex token (`local-token.ts:14`–`:23`).
    #[error("{0}")]
    Token(String),
}

impl AuthError {
    pub fn access(status: u16, message: impl Into<String>) -> Self {
        Self::Access(AccessError::new(status, message))
    }

    /// The status a refusal answers with; a store failure is the daemon's own (500).
    pub fn status(&self) -> u16 {
        match self {
            Self::Access(error) => error.status,
            Self::Store(_) | Self::Token(_) => 500,
        }
    }

    /// The message a caller shows, for a refusal and for a store or token failure alike.
    pub fn message(&self) -> String {
        match self {
            Self::Access(error) => error.message.clone(),
            Self::Store(error) => error.to_string(),
            Self::Token(message) => message.clone(),
        }
    }
}

pub type Result<T> = std::result::Result<T, AuthError>;
