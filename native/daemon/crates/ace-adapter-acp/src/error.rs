// SPDX-License-Identifier: Apache-2.0
//! Typed errors for the ACP adapter crate (E1). Translators never fail on
//! provider data; these cover construction and frame handling.

use thiserror::Error;

/// What the ACP translator crate can fail with.
#[derive(Debug, Error)]
pub enum AcpError {
    /// Invalid translator identity allocation.
    #[error("invalid ACP identity allocation")]
    InvalidIdentity,
    /// A frame the shell could not encode as JSON.
    #[error("invalid frame: {0}")]
    InvalidFrame(String),
    /// Facts failed to serialize back to JSON.
    #[error("facts do not serialize: {0}")]
    Serialize(String),
}
