// SPDX-License-Identifier: Apache-2.0
//! How a failed Cursor run is classified (`failure-kind.ts`). Only the SDK's
//! own `rate_limit` code is a usage limit; out-of-usage prose stays a failed
//! turn that holds nothing.

/// A classified failure: its kind and, when the SDK names one, its code.
pub struct Failure {
    pub kind: &'static str,
    pub code: Option<String>,
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Case-insensitive phrase search with word boundaries, as the `\b` anchors do.
fn find_phrase(text: &str, phrase: &str) -> bool {
    if phrase.is_empty() {
        return false;
    }
    let mut start = 0;
    while let Some(found) = text[start..].find(phrase) {
        let at = start + found;
        let before = at == 0 || !is_word_byte(text.as_bytes()[at - 1]);
        let after =
            at + phrase.len() >= text.len() || !is_word_byte(text.as_bytes()[at + phrase.len()]);
        if before && after {
            return true;
        }
        start = at + 1;
    }
    false
}

fn hit_limit(text: &str) -> bool {
    let mut start = 0;
    while let Some(found) = text[start..].find("hit your ") {
        let at = start + found;
        if at > 0 && is_word_byte(text.as_bytes()[at - 1]) {
            start = at + 1;
            continue;
        }
        let token_at = at + "hit your ".len();
        let bytes = text.as_bytes();
        let mut end = token_at;
        while end < text.len() && (is_word_byte(bytes[end]) || bytes[end] == b'-') {
            end += 1;
        }
        if end > token_at
            && text[end..].starts_with(" limit")
            && (end + " limit".len() >= text.len()
                || !is_word_byte(text.as_bytes()[end + " limit".len()]))
        {
            return true;
        }
        start = token_at;
    }
    false
}

/// Classify a failed run from the SDK's code and its message.
pub fn cursor_failure(
    code: &serde_json::Value,
    message: &str,
    retryable: &serde_json::Value,
) -> Failure {
    use serde_json::Value;
    if code == &Value::String("auth".to_owned()) {
        return Failure {
            kind: "auth",
            code: None,
        };
    }
    if code == &Value::String("rate_limit".to_owned()) {
        return if retryable == &Value::Bool(true) {
            Failure {
                kind: "provider",
                code: Some("rate_limited".to_owned()),
            }
        } else {
            Failure {
                kind: "quota",
                code: None,
            }
        };
    }
    if code == &Value::String("network".to_owned()) {
        return Failure {
            kind: "network",
            code: None,
        };
    }
    let lower = message.to_lowercase();
    if find_phrase(&lower, "out of usage")
        || find_phrase(&lower, "usage limit")
        || hit_limit(&lower)
    {
        let suggests_model = find_phrase(&lower, "switch to auto")
            || find_phrase(&lower, "another model")
            || find_phrase(&lower, "a different model");
        return Failure {
            kind: "provider",
            code: Some(if suggests_model {
                "model_quota".to_owned()
            } else {
                "usage_limit".to_owned()
            }),
        };
    }
    Failure {
        kind: "provider",
        code: None,
    }
}
