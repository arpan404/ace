// SPDX-License-Identifier: Apache-2.0
//! The fold's typed errors. Invalid facts are rejected as notices, never
//! fatal; only a caller-contract violation (a fact that is not JSON at all,
//! a missing handle) becomes an error here.

/// What folding, validating, or (de)serializing the core can fail with.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// A fact, state, or context that is not JSON at all. The TypeScript
    /// facade only ever sends strings it serialized itself.
    #[error("not JSON: {0}")]
    NotJson(String),
    /// The caller broke the binding contract (unknown handle, bad ids).
    #[error("core contract: {0}")]
    Contract(String),
}

impl CoreError {
    pub(crate) fn invalid_json(error: impl std::fmt::Display) -> Self {
        Self::NotJson(error.to_string())
    }

    pub(crate) fn invalid_json_string(error: impl std::fmt::Display) -> Self {
        Self::NotJson(error.to_string())
    }

    pub(crate) fn contract(message: impl Into<String>) -> Self {
        Self::Contract(message.into())
    }
}

/// What a fold can fail with once a section reads from a source: the section's error joins
/// the contract violations above (E5.3 step 3).
#[derive(Debug, thiserror::Error)]
pub enum FoldError {
    #[error(transparent)]
    Source(#[from] crate::section::SourceError),
    #[error(transparent)]
    Core(#[from] CoreError),
}
