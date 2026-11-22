//! What ace cloud's refusals mean to Spade: the sentence shown and how long to wait before asking
//! again (ADR 0210 §4, §6). Pure: no I/O.

use std::time::Duration;

use serde_json::Value;

use crate::clean;

/// The sentence when ace cloud's global breaker is reached.
pub const RESTING: &str = "ace search is resting today.";
/// The sentence for a refusal that came without a reason of its own.
pub(crate) const BUSY: &str = "ace search is busy right now. Try again later.";

/// The longest wait honoured after a refusal: a day, then Spade asks again.
pub(crate) const LONGEST_WAIT: Duration = Duration::from_secs(24 * 60 * 60);
/// The wait after a refusal whose `Retry-After` is missing or garbled.
pub(crate) const DEFAULT_WAIT: Duration = Duration::from_secs(60);
/// The wait after ace search failed or couldn't be reached.
pub(crate) const FAILED_WAIT: Duration = Duration::from_secs(30);
/// The longest reason shown, in characters.
const REASON_CHARS: usize = 200;

/// How long to wait before asking again: the `Retry-After` header in seconds, else the body's
/// `retryAfter`, else [`DEFAULT_WAIT`]; never more than [`LONGEST_WAIT`].
pub(crate) fn wait(header: Option<&str>, body: Option<&Value>) -> Duration {
    let from_header = header.and_then(|text| text.trim().parse::<u64>().ok());
    let from_body = || {
        body.and_then(|b| b.get("retryAfter"))
            .and_then(Value::as_u64)
    };
    from_header
        .or_else(from_body)
        .map_or(DEFAULT_WAIT, Duration::from_secs)
        .min(LONGEST_WAIT)
}

/// The refusal's `error` code and the one plain sentence that answers for it.
pub(crate) fn read(body: Option<&Value>) -> (String, String) {
    let field = |name: &str| {
        body.and_then(|b| b.get(name))
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let error = field("error").trim().to_owned();
    if error == "resting" {
        return (error, RESTING.to_owned());
    }
    let plain: String = field("reason")
        .chars()
        .filter(|c| !c.is_control() || c.is_whitespace())
        .collect();
    let reason = clean::text(&plain, REASON_CHARS);
    if reason.is_empty() {
        (error, BUSY.to_owned())
    } else {
        (error, reason)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_wait_comes_from_retry_after_and_is_bounded() {
        assert_eq!(wait(Some("120"), None), Duration::from_secs(120));
        assert_eq!(
            wait(None, Some(&json!({ "retryAfter": 30 }))),
            Duration::from_secs(30)
        );
        assert_eq!(wait(Some("soon"), None), DEFAULT_WAIT);
        assert_eq!(
            wait(None, Some(&json!({ "retryAfter": "x" }))),
            DEFAULT_WAIT
        );
        assert_eq!(wait(Some("9999999"), None), LONGEST_WAIT);
    }

    #[test]
    fn resting_has_its_own_sentence_and_other_reasons_are_plain_and_short() {
        let resting = json!({ "error": "resting", "reason": "whatever the cloud says" });
        assert_eq!(read(Some(&resting)).1, RESTING);

        let daily = json!({ "error": "daily_spent",
            "reason": "  You've used today's <b>ace searches</b>.\u{7}\nThey come back tomorrow. " });
        assert_eq!(
            read(Some(&daily)),
            (
                "daily_spent".to_owned(),
                "You've used today's ace searches. They come back tomorrow.".to_owned()
            )
        );

        let long = json!({ "error": "x", "reason": "word ".repeat(100) });
        assert!(read(Some(&long)).1.chars().count() <= REASON_CHARS + 1);
        assert_eq!(read(None).1, BUSY);
        assert_eq!(read(Some(&json!({ "reason": 5 }))).1, BUSY);
    }
}
