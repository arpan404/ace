// SPDX-License-Identifier: Apache-2.0
//! The event stream's failures, as the TypeScript names them.
//!
//! The first three are the SDK's (or `boundedSse`'s) own refusals: the event
//! byte bound, the SDK's 16 Mi-unit buffer bound and `JSON.parse`. The fourth
//! is `NativeEvent.parse`. A failure ends the connection: the facade reconnects
//! when the stream had already connected, and fails the server otherwise,
//! exactly as `consumeEvents` does (`server.ts:461`-`:468`).

use crate::translate::boundaries::BoundaryError;

/// One stream failure. Copy so a `ChunkOutcome` can carry it out of the core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StreamError {
    /// `boundedSse`'s per-event bound: "OpenCode event exceeds byte limit"
    /// (`observation.ts:63`-`:70`).
    #[error("OpenCode event exceeds byte limit")]
    EventBytes,
    /// The SDK's `SseEventTooLarge`: the decoded buffer is over 16 Mi UTF-16 units.
    #[error("SseEventTooLarge")]
    SseEventTooLarge,
    /// The SDK's `MalformedResponse`: a block's data is not JSON.
    #[error("MalformedResponse")]
    MalformedResponse,
    /// `NativeEvent.parse` refused the sanitized envelope. The field is the
    /// failed schema position, as `boundaries.ts`'s messages name it.
    #[error("OpenCode event failed its native envelope check: {0}")]
    Envelope(&'static str),
}

impl StreamError {
    /// The identity the TypeScript throws. The SDK's failures are its
    /// `ClientError` codes; the other two are `Error`s with this text.
    pub fn code(self) -> &'static str {
        match self {
            StreamError::EventBytes => "EventTooLarge",
            StreamError::SseEventTooLarge => "SseEventTooLarge",
            StreamError::MalformedResponse => "MalformedResponse",
            StreamError::Envelope(_) => "Envelope",
        }
    }
}

impl From<BoundaryError> for StreamError {
    fn from(error: BoundaryError) -> Self {
        match error {
            BoundaryError::Event(field) => StreamError::Envelope(field),
        }
    }
}

/// `ServerSecrets.parse` refused the redaction list (`server.ts:66`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    /// `z.array(...).max(32)`.
    #[error("OpenCode session secrets exceed 32 entries")]
    TooMany,
    /// `z.string().min(1).max(4096)`, whose bounds count code points (rule 17).
    #[error("OpenCode session secret is outside 1..=4096 characters")]
    Length,
}
