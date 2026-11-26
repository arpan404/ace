// SPDX-License-Identifier: Apache-2.0

//! The one error a failed shutdown reports (`shutdown-failure.ts`): sessions that wouldn't
//! stop, as a sentence a person can read, naming the first few reasons and counting the rest.

use ace_json::JsString;

/// At most this many distinct reasons are named (`shutdown-failure.ts:2`).
const SHOWN_REASONS: usize = 3;
/// A reason keeps this many UTF-16 units (`shutdown-failure.ts:3`).
const REASON_UNITS: usize = 160;

/// What a failed shutdown reports (`AggregateError`): the sentence, the failures it names, and
/// how many sessions there were.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownFailure {
    pub message: String,
    pub errors: Vec<String>,
    /// `total` as the message counts it: never fewer than the failures themselves.
    pub total: usize,
}

impl std::fmt::Display for ShutdownFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ShutdownFailure {}

/// Sessions that wouldn't stop during a shutdown, as one error (`shutdown-failure.ts:13`),
/// e.g. "1 of 3 app sessions didn't stop: helper timed out".
pub fn shutdown_failure(reasons: &[String], total: usize) -> ShutdownFailure {
    let errors: Vec<String> = reasons.iter().map(|reason| reason_of(reason)).collect();
    let mut distinct: Vec<String> = Vec::new();
    for reason in &errors {
        if !distinct.contains(reason) {
            distinct.push(reason.clone());
        }
    }
    let named = distinct
        .iter()
        .take(SHOWN_REASONS)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    let more = if distinct.len() > SHOWN_REASONS {
        format!(" (and {} more)", distinct.len() - SHOWN_REASONS)
    } else {
        String::new()
    };
    let sessions = if total == 1 {
        "app session"
    } else {
        "app sessions"
    };
    let counted = total.max(errors.len());
    let message = format!(
        "{} of {counted} {sessions} didn't stop: {named}{more}",
        errors.len()
    );
    ShutdownFailure {
        message,
        errors,
        total: counted,
    }
}

/// A failure's message, cut to the length the sentence keeps (`shutdown-failure.ts:5`): UTF-16
/// units, as `String.prototype.slice` counts them.
fn reason_of(reason: &str) -> String {
    let text = JsString::from(reason);
    let units: Vec<u16> = text.units().take(REASON_UNITS).collect();
    JsString::from_units(&units).as_str().to_owned()
}

#[cfg(test)]
// The `shutdown-failure` cases, moved from TypeScript
// (`packages/screen/src/shutdown-failure.test.ts`): the count and each reason once (`:4`), and
// at most three named reasons with the rest counted (`:13`).
mod tests {
    use super::shutdown_failure;

    /// `shutdown-failure.test.ts:4`.
    #[test]
    fn a_failed_shutdown_says_how_many_sessions_didnt_stop_and_why_each_reason_once() {
        let error = shutdown_failure(
            &[
                "helper timed out".to_owned(),
                "helper timed out".to_owned(),
                "window gone".to_owned(),
            ],
            5,
        );
        assert_eq!(
            error.message,
            "3 of 5 app sessions didn't stop: helper timed out; window gone"
        );
        assert_eq!(error.errors.len(), 3);
    }

    /// `shutdown-failure.test.ts:13`.
    #[test]
    fn many_distinct_reasons_are_named_up_to_three_and_the_rest_counted() {
        let reasons: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|r| (*r).to_owned())
            .collect();
        let error = shutdown_failure(&reasons, 4);
        assert_eq!(
            error.message,
            "4 of 4 app sessions didn't stop: a; b; c (and 1 more)"
        );
    }

    #[test]
    fn one_session_is_named_in_the_singular() {
        let error = shutdown_failure(&["helper timed out".to_owned()], 1);
        assert_eq!(
            error.message,
            "1 of 1 app session didn't stop: helper timed out"
        );
    }
}
