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
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StreamError {
    /// `boundedSse`'s per-event bound (`observation.ts:63`-`:70`). It reaches
    /// the SDK as a rejected `reader.read()`, so it surfaces as the SDK's
    /// `ClientError("Transport", { cause })`.
    #[error("Transport: OpenCode event exceeds byte limit")]
    EventBytes,
    /// The SDK's `SseEventTooLarge`: the decoded buffer is over 16 Mi UTF-16 units.
    #[error("SseEventTooLarge")]
    SseEventTooLarge,
    /// The SDK's `MalformedResponse`: a block's data is not JSON. The cause is
    /// the parser's text; the TypeScript's is V8's `JSON.parse` message.
    #[error("MalformedResponse: {0}")]
    MalformedResponse(String),
    /// `NativeEvent.parse` refused the sanitized envelope. The field is the
    /// failed schema position, as `boundaries.ts`'s messages name it.
    #[error("OpenCode event failed its native envelope check: {0}")]
    Envelope(&'static str),
    /// A tenant refused the event: the TypeScript's thrown Error or ZodError.
    #[error("{0}")]
    Tenant(String),
}

impl StreamError {
    /// The `ClientError` reason the SDK raises, or `None` where the TypeScript
    /// throws a `ZodError` (the envelope check, `boundaries.ts`) or a plain
    /// `Error` of the consumer body.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            StreamError::EventBytes => Some("Transport"),
            StreamError::SseEventTooLarge => Some("SseEventTooLarge"),
            StreamError::MalformedResponse(_) => Some("MalformedResponse"),
            StreamError::Envelope(_) | StreamError::Tenant(_) => None,
        }
    }

    /// The message `failed(error)` sees: the `ClientError` reason, plus the
    /// cause for the two that carry one. The bound's cause text is the
    /// TypeScript's own; a malformed block's is this parser's, where the
    /// TypeScript has V8's. A `ZodError` has no single line.
    pub fn message(&self) -> String {
        match self {
            StreamError::EventBytes => String::from("Transport: OpenCode event exceeds byte limit"),
            StreamError::SseEventTooLarge => String::from("SseEventTooLarge"),
            StreamError::MalformedResponse(cause) => format!("MalformedResponse: {cause}"),
            StreamError::Envelope(field) => {
                // `NativeEvent.parse` threw a ZodError; the failed field is what
                // this build can name, and the daemon's log carries the text.
                format!("OpenCode event failed its native envelope check: {field}")
            }
            StreamError::Tenant(message) => message.clone(),
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
