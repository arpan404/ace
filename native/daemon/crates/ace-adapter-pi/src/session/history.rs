// SPDX-License-Identifier: Apache-2.0
//! Pi's native-history diagnostics, ported from `packages/adapter-pi/src/history-errors.ts`.
//!
//! Only ace's own fixed sentences reach a person: a provider's exception text can carry
//! credentials, so anything that is not one of these becomes one generic sentence.

/// The history failures, each with the TypeScript's exact sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PiHistoryError {
    #[error("Pi saved session is missing or unreadable")]
    Missing,
    #[error("Pi saved session header is invalid or exceeds 64 KiB")]
    Header,
    #[error("Pi saved session identity changed")]
    Identity,
    #[error("Pi extension cancelled session switch")]
    CancelledSwitch,
    #[error("Pi extension cancelled fork")]
    CancelledFork,
    #[error("Pi history controls require an idle session")]
    Idle,
    #[error("Invalid Pi entry id")]
    Entry,
    #[error("Pi navigation was not acknowledged")]
    Acknowledgement,
    #[error("Pi fork did not create a new session")]
    Fork,
    #[error("Pi cannot save a fork without an assistant message on the selected branch")]
    UnflushedFork,
    #[error("Pi fork history is invalid or exceeds the 4096-entry control limit")]
    ForkState,
}

/// `piHistoryErrorMessage`: a `PiHistoryError`'s sentence, else the generic one.
pub fn pi_history_error_message(error: &(dyn std::error::Error + 'static)) -> String {
    error
        .downcast_ref::<PiHistoryError>()
        .map(ToString::to_string)
        .unwrap_or_else(|| "Pi native history operation failed".to_owned())
}

#[cfg(test)]
mod tests {
    // Ported from `packages/adapter-pi/src/history-errors.test.ts`.
    use super::*;

    /// "provider exception text cannot leak through history diagnostics".
    #[test]
    fn provider_exception_text_cannot_leak_through_history_diagnostics() {
        let foreign = std::io::Error::other("private credential and native stderr");
        assert_eq!(
            pi_history_error_message(&foreign),
            "Pi native history operation failed"
        );
        assert_eq!(
            pi_history_error_message(&PiHistoryError::Identity),
            "Pi saved session identity changed"
        );
    }
}
