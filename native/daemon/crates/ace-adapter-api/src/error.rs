// SPDX-License-Identifier: Apache-2.0
//! The adapter interface's typed errors. The binding maps each variant back to
//! the engine-api class `instanceof` checks on (`InputRejected` first, then
//! `SteerTargetLost`), so a provider refusal keeps its identity both ways.

use thiserror::Error;

/// What a session or translator call can fail with.
#[derive(Debug, Error)]
pub enum AdapterApiError {
    /// The provider refused the input before taking any of it: a steer that
    /// lost a race, or an admission the provider turned down. Unlike a
    /// transport failure, it proves the input never ran, so ace may send it
    /// again.
    #[error("input rejected: {0}")]
    InputRejected(String),
    /// A fenced steer whose turn ended before the provider read it: unread,
    /// and never retried into another turn.
    #[error("steer target lost: {0}")]
    SteerTargetLost(String),
    /// The transport failed after the provider may have taken the input.
    #[error("transport: {0}")]
    Transport(String),
    /// A frame the session could not admit or hand over.
    #[error("frame: {0}")]
    Frame(String),
}

impl AdapterApiError {
    /// Whether the input may be sent again. Only a refusal proves the input
    /// never ran; anything else holds the send as uncertain.
    pub fn retryable(&self) -> bool {
        matches!(self, AdapterApiError::InputRejected(_))
    }
}
