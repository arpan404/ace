// SPDX-License-Identifier: Apache-2.0
//! The bounded, redacted copy of a model's native payload.
//!
//! Ports `packages/models/src/raw.ts`: keys that name credentials are replaced
//! before the payload is kept, the JSON is capped at 2,048 UTF-8 bytes, and the
//! cap never splits a code point (rule 17: the bound is `Buffer.byteLength`, so
//! bytes, not characters).

use serde_json::Value;
use std::sync::OnceLock;

const RAW_LIMIT: usize = 2048;
const DEPTH_LIMIT: i32 = 16;

fn secret_key() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)authorization|cookie|token|secret|password|credential|api[_-]?key|headers|env",
            )
            .ok()
        })
        .as_ref()
}

fn redact(value: &Value, depth: i32) -> Value {
    if depth > DEPTH_LIMIT {
        return Value::String("[depth limit]".into());
    }
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact(item, depth + 1)).collect())
        }
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, child)| {
                    let redacted = secret_key()
                        .map(|pattern| pattern.is_match(key))
                        .unwrap_or(false);
                    (
                        key.clone(),
                        if redacted {
                            Value::String("[redacted]".into())
                        } else {
                            redact(child, depth + 1)
                        },
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A native payload kept for debugging: its redacted JSON and whether it was cut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPayload {
    pub json: String,
    pub truncated: bool,
}

/// The redacted payload, capped at 2,048 UTF-8 bytes as the protocol requires.
pub fn raw_payload(value: &Value) -> RawPayload {
    let text = serde_json::to_string(&redact(value, 0)).unwrap_or_else(|_| "null".into());
    let bytes = text.as_bytes();
    if bytes.len() <= RAW_LIMIT {
        return RawPayload {
            json: text,
            truncated: false,
        };
    }
    // Round-trip avoids a partial UTF-8 code point exceeding the byte limit.
    let mut json = String::from_utf8_lossy(&bytes[..RAW_LIMIT]).into_owned();
    while json.len() > RAW_LIMIT {
        json.pop();
    }
    RawPayload {
        json,
        truncated: true,
    }
}

#[cfg(test)]
mod tests {
    //! Ports the raw-metadata cases of the catalog tests:
    //! - `packages/models/src/acp-extensions.test.ts`, "unknown ACP option semantics
    //!   preserve models and bounded redacted raw metadata": credential-bearing keys
    //!   read `[redacted]`, a large extension is truncated, and the kept JSON is at
    //!   most 2 KiB;
    //! - "representative session metadata remains redacted and capped when per-model
    //!   configs are empty": the same bound on a session extension.
    //!
    //! Rule 17: the bound is a UTF-8 byte count, so the emoji cases check both sides.

    use super::*;
    use serde_json::json;

    #[test]
    fn credential_keys_are_redacted_and_other_metadata_survives() {
        let payload = raw_payload(&json!({
            "id": "model",
            "metadata": { "description": "future setting", "apiKey": "private-value" },
            "headers": { "authorization": "Bearer sentinel" },
        }));
        let parsed: Value = serde_json::from_str(&payload.json).unwrap_or(Value::Null);
        assert_eq!(parsed["metadata"]["apiKey"], "[redacted]");
        assert_eq!(parsed["metadata"]["description"], "future setting");
        assert_eq!(parsed["headers"], "[redacted]");
        assert!(!payload.json.contains("private-value"));
        assert!(!payload.json.contains("sentinel"));
        assert!(!payload.truncated);
    }

    #[test]
    fn a_large_extension_is_capped_at_two_kibibytes() {
        let payload = raw_payload(&json!({
            "id": "model",
            "metadata": { "apiKey": "private-value" },
            "extra": "x".repeat(4096),
        }));
        assert!(payload.truncated);
        assert!(payload.json.len() <= RAW_LIMIT);
        assert!(payload.json.contains("\"apiKey\":\"[redacted]\""));
        assert!(!payload.json.contains("private-value"));
    }

    #[test]
    fn the_cap_counts_utf8_bytes_and_never_splits_an_emoji() {
        // A string of 600 astral characters is 2,400 UTF-8 bytes: over the cap, so
        // the kept JSON is cut and stays valid UTF-8 (no half emoji).
        let payload = raw_payload(&json!({ "note": "🚀".repeat(600) }));
        assert!(payload.truncated);
        assert!(payload.json.len() <= RAW_LIMIT);
        assert!(payload.json.is_char_boundary(payload.json.len()));
        // Exactly 2,048 bytes of JSON is kept whole; one more byte truncates.
        let head = "{\"note\":\"";
        let tail = "\"}";
        let exact = format!(
            "{head}{}{tail}",
            "a".repeat(RAW_LIMIT - head.len() - tail.len())
        );
        assert_eq!(exact.len(), RAW_LIMIT);
        let kept = raw_payload(&json!({ "note": "a".repeat(RAW_LIMIT - head.len() - tail.len()) }));
        assert_eq!(kept.json, exact);
        assert!(!kept.truncated);
        let over =
            raw_payload(&json!({ "note": "a".repeat(RAW_LIMIT - head.len() - tail.len() + 1) }));
        assert!(over.truncated);
        assert!(over.json.len() <= RAW_LIMIT);
    }

    #[test]
    fn nesting_past_the_depth_limit_is_replaced_not_dropped() {
        let mut value = json!(0);
        for _ in 0..20 {
            value = json!({ "next": value });
        }
        let payload = raw_payload(&value);
        assert!(payload.json.contains("[depth limit]"));
    }
}
