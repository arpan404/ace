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
    /// The `ClientError` reason the SDK raises, or `None` where the TypeScript
    /// throws a plain `Error` (the event bound) or a `ZodError` (the envelope
    /// check, `boundaries.ts`).
    pub fn code(self) -> Option<&'static str> {
        match self {
            StreamError::SseEventTooLarge => Some("SseEventTooLarge"),
            StreamError::MalformedResponse => Some("MalformedResponse"),
            StreamError::EventBytes | StreamError::Envelope(_) => None,
        }
    }

    /// The TypeScript's message. `ClientError`'s is its reason alone unless it
    /// has a cause; `MalformedResponse`'s cause is V8's `JSON.parse` text,
    /// which this does not reproduce, and a `ZodError` has no single line.
    pub fn message(self) -> String {
        match self {
            StreamError::EventBytes => String::from("OpenCode event exceeds byte limit"),
            StreamError::SseEventTooLarge => String::from("SseEventTooLarge"),
            StreamError::MalformedResponse => String::from("MalformedResponse"),
            StreamError::Envelope(field) => {
                // `NativeEvent.parse` threw a ZodError; the failed field is what
                // this build can name, and the daemon's log carries the text.
                format!("OpenCode event failed its native envelope check: {field}")
            }
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

/// `ServerSecrets.parse` refused the declared list (`server.ts:66`, `:144`).
/// The TypeScript throws a ZodError, which has no single-line message, so these
/// name the rule that failed; the count is the declared list's, duplicates
/// included, and never the authorization added at `:221`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    /// More than 32 declared entries (`z.array(...).max(32)`).
    #[error("OpenCode session secrets exceed 32 entries")]
    TooMany,
    /// A declared entry outside `z.string().min(1).max(4096)`; the bounds count
    /// code points (rule 17).
    #[error("OpenCode session secret is outside 1..=4096 characters")]
    Length,
}
