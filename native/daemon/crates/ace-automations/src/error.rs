// SPDX-License-Identifier: Apache-2.0
//! Why an automation operation failed. Messages are the TypeScript's own words where the
//! contract names them ("Skipped: new work was paused.", the CAS and store errors).

use thiserror::Error;

pub type Result<T> = std::result::Result<T, AutomationsError>;

#[derive(Debug, Error)]
pub enum AutomationsError {
    /// A refusal the TypeScript throws with this exact text.
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Store(#[from] ace_store::Error),
    #[error(transparent)]
    Json(#[from] ace_json::DeError),
}

impl AutomationsError {
    pub fn message(text: impl Into<String>) -> Self {
        AutomationsError::Message(text.into())
    }
}
