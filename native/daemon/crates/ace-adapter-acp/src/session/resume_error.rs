// SPDX-License-Identifier: Apache-2.0
//! Resume load failure classification (`packages/adapter-acp/src/resume-error.ts`).

use ace_json::Value;
use serde::{Deserialize, Serialize};

use super::protocol::{INTERNAL_ERROR_CODE, METHOD_NOT_FOUND_CODE, RESOURCE_NOT_FOUND_CODE};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeFailureCode {
    ResumeUnavailable,
    ResumeUnsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeFailure {
    pub code: ResumeFailureCode,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq)]
enum WireCode {
    Str(String),
    Num(f64),
}

impl WireCode {
    fn is_i64(&self, expected: i64) -> bool {
        matches!(self, WireCode::Num(n) if *n == expected as f64)
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            WireCode::Str(s) => Some(s.as_str()),
            WireCode::Num(_) => None,
        }
    }
}

/// Interpret only a failed `session/load` / `session/resume` error message, never
/// initialization or fresh opening (`resume-error.ts:9`–`:40`).
pub fn resume_load_failure(error: &str) -> Option<ResumeFailure> {
    let mut detail = error.to_owned();
    let mut code: Option<WireCode> = None;

    // JsonRpcPeer retains the wire error as JSON in the error message.
    if let Ok(Value::Object(map)) = ace_json::parse(error) {
        let code_field = match map.get("code") {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(WireCode::Str(s.to_string()))),
            Some(Value::Number(n)) => n.as_f64().map(|f| Some(WireCode::Num(f))).ok_or(()),
            Some(_) => Err(()),
        };
        let message_field = match map.get("message") {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.to_string())),
            Some(_) => Err(()),
        };
        if let (Ok(parsed_code), Ok(parsed_message)) = (code_field, message_field) {
            code = parsed_code;
            if let Some(message) = parsed_message {
                detail = message;
            }
        }
    }

    if code.as_ref().is_some_and(|c| {
        c.is_i64(METHOD_NOT_FOUND_CODE) || c.as_str() == Some("resume_unsupported")
    }) {
        return Some(ResumeFailure {
            code: ResumeFailureCode::ResumeUnsupported,
            detail,
        });
    }

    let unavailable_string_code = code.as_ref().and_then(WireCode::as_str).is_some_and(|s| {
        matches!(
            s,
            "resume_unavailable"
                | "session_not_found"
                | "thread_not_found"
                | "conversation_not_found"
        )
    });

    if unavailable_string_code
        || code
            .as_ref()
            .is_some_and(|c| c.is_i64(RESOURCE_NOT_FOUND_CODE))
        || (code.as_ref().is_some_and(|c| c.is_i64(INTERNAL_ERROR_CODE))
            && contains_word_phrase_ci(&detail, "session not found"))
        || starts_with_word_phrase_ci(&detail, "no conversation found")
    {
        return Some(ResumeFailure {
            code: ResumeFailureCode::ResumeUnavailable,
            detail,
        });
    }

    None
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// Case-insensitive `/\bsession not found\b/i` match.
fn contains_word_phrase_ci(haystack: &str, needle_lower: &str) -> bool {
    let lower = haystack.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let nlen = needle_lower.len();
    let mut start = 0;
    while let Some(pos) = lower[start..].find(needle_lower) {
        let abs = start + pos;
        let left_ok = abs == 0 || !is_word_byte(bytes[abs - 1]);
        let right_ok = abs + nlen == bytes.len() || !is_word_byte(bytes[abs + nlen]);
        if left_ok && right_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

/// Case-insensitive `/^No conversation found\b/i` match.
fn starts_with_word_phrase_ci(haystack: &str, prefix_lower: &str) -> bool {
    let lower = haystack.to_ascii_lowercase();
    if !lower.starts_with(prefix_lower) {
        return false;
    }
    let bytes = lower.as_bytes();
    let plen = prefix_lower.len();
    plen == bytes.len() || !is_word_byte(bytes[plen])
}

#[cfg(test)]
mod tests {
    use super::{ResumeFailure, ResumeFailureCode, resume_load_failure};

    #[test]
    fn resume_load_failure_classifies_rpc_and_plain_errors() {
        let cases: &[(&str, Option<(ResumeFailureCode, &str)>)] = &[
            (
                r#"{"code":-32601,"message":"Method not found"}"#,
                Some((ResumeFailureCode::ResumeUnsupported, "Method not found")),
            ),
            (
                r#"{"code":"resume_unsupported","message":"nope"}"#,
                Some((ResumeFailureCode::ResumeUnsupported, "nope")),
            ),
            (
                r#"{"code":-32002,"message":"Resource not found"}"#,
                Some((ResumeFailureCode::ResumeUnavailable, "Resource not found")),
            ),
            (
                r#"{"code":"session_not_found","message":"missing"}"#,
                Some((ResumeFailureCode::ResumeUnavailable, "missing")),
            ),
            (
                r#"{"code":"thread_not_found"}"#,
                Some((
                    ResumeFailureCode::ResumeUnavailable,
                    r#"{"code":"thread_not_found"}"#,
                )),
            ),
            (
                r#"{"code":"conversation_not_found","message":"gone"}"#,
                Some((ResumeFailureCode::ResumeUnavailable, "gone")),
            ),
            (
                r#"{"code":"resume_unavailable","message":"archived"}"#,
                Some((ResumeFailureCode::ResumeUnavailable, "archived")),
            ),
            (
                r#"{"code":-32603,"message":"Error: Session Not Found in store"}"#,
                Some((
                    ResumeFailureCode::ResumeUnavailable,
                    "Error: Session Not Found in store",
                )),
            ),
            (r#"{"code":-32603,"message":"mysession not found"}"#, None),
            (r#"{"code":-32603,"message":"internal crash"}"#, None),
            (
                "No conversation found for id abc",
                Some((
                    ResumeFailureCode::ResumeUnavailable,
                    "No conversation found for id abc",
                )),
            ),
            ("No conversation foundx", None),
            (r#"{"code":-32000,"message":"auth required"}"#, None),
            (r#"{"code":true,"message":"No conversation found"}"#, None),
            ("plain network timeout", None),
        ];

        for &(input, expected) in cases {
            let actual = resume_load_failure(input);
            let expected = expected.map(|(code, detail)| ResumeFailure {
                code,
                detail: detail.to_owned(),
            });
            assert_eq!(actual, expected, "input={input:?}");
        }
    }
}
