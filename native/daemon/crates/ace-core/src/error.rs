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
    /// A JSON value of the wrong shape where an object was required.
    #[error("not an object")]
    NotAnObject,
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

    pub(crate) fn not_an_object() -> Self {
        Self::NotAnObject
    }

    pub(crate) fn contract(message: impl Into<String>) -> Self {
        Self::Contract(message.into())
    }
}
