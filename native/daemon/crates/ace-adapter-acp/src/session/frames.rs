// SPDX-License-Identifier: Apache-2.0
//! ACP frame capture (`packages/adapter-acp/src/session.ts:360`-`:382` and
//! `packages/provider-kit/src/payload.ts`).
//!
//! Redacts lease secrets through the E1 port (`translate::frame_redaction`), admits the
//! JSON payload against the 1 MiB byte bound and 32,768 structural node bound, and falls
//! back to binary elision (`ace_adapter_api::util::elided_json`) when a frame exceeds a
//! bound.

use ace_adapter_api::util::elided_json;
use ace_json::Value;
use thiserror::Error;

use crate::translate::frame_redaction::redacted_frame_json_ref;

/// `maxProviderPayloadBytes` (`payload.ts:4`): 1 MiB.
pub const MAX_PROVIDER_PAYLOAD_BYTES: usize = 1024 * 1024;
/// Structural node limit (`payload.ts:28`).
pub const MAX_PROVIDER_PAYLOAD_NODES: usize = 32_768;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FrameCaptureError {
    #[error("Provider payload exceeds byte limit")]
    ExceedsByteLimit,
    #[error("Provider payload exceeds structural limit")]
    ExceedsStructuralLimit,
    #[error("Invalid JSON payload: {0}")]
    InvalidJson(String),
}

/// A captured, redacted, bounded frame payload ready for publication.
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedFrame {
    pub json: String,
    pub bytes: usize,
}

/// Capture an ACP frame (`session.ts:360`–`:373`): redact lease secrets, serialize with
/// `ace_json` and check `ProviderPayload`'s byte and node limits on the tree that was just
/// serialized; only a frame past a limit is elided and parsed again (`capture_frame` used to
/// re-parse every clean frame, and cloned its tree).
pub fn capture_frame(data: &Value, secrets: &[String]) -> Result<CapturedFrame, FrameCaptureError> {
    let (json, redacted) = redacted_frame_json_ref(data, secrets);
    let value = redacted.as_ref().unwrap_or(data);
    match validate_tree(&json, value) {
        Ok(()) => Ok(CapturedFrame {
            bytes: json.len(),
            json,
        }),
        Err(FrameCaptureError::ExceedsByteLimit | FrameCaptureError::ExceedsStructuralLimit) => {
            // `value` is already lease-redacted if any secret appeared in `data`.
            let elided = elided_json(value);
            let parsed = ace_json::parse(&elided)
                .map_err(|e| FrameCaptureError::InvalidJson(e.to_string()))?;
            validate_tree(&elided, &parsed)?;
            Ok(CapturedFrame {
                bytes: elided.len(),
                json: elided,
            })
        }
        Err(other) => Err(other),
    }
}

/// `ProviderPayload`'s bounds over an already-parsed tree and its serialized text
/// (`payload.ts:11`–`:42`): the byte count and the structural node count, in one walk.
pub fn validate_tree(json: &str, value: &Value) -> Result<(), FrameCaptureError> {
    if json.len() > MAX_PROVIDER_PAYLOAD_BYTES {
        return Err(FrameCaptureError::ExceedsByteLimit);
    }
    let mut nodes: usize = 0;
    let mut stack: Vec<&Value> = vec![value];
    while let Some(value) = stack.pop() {
        nodes += 1;
        if nodes > MAX_PROVIDER_PAYLOAD_NODES {
            return Err(FrameCaptureError::ExceedsStructuralLimit);
        }
        match value {
            Value::Array(items) => stack.extend(items.iter()),
            Value::Object(map) => stack.extend(map.values()),
            _ => {}
        }
    }
    Ok(())
}

/// Capture a plain text line (`stdio-text` malformed line or `stderr` line) as a JSON
/// string frame.
pub fn capture_text_frame(
    line: &str,
    secrets: &[String],
) -> Result<CapturedFrame, FrameCaptureError> {
    capture_frame(&Value::from(line), secrets)
}

#[cfg(test)]
mod tests {
    use super::{
        FrameCaptureError, MAX_PROVIDER_PAYLOAD_BYTES, MAX_PROVIDER_PAYLOAD_NODES, capture_frame,
        capture_text_frame,
    };
    use crate::translate::frame_redaction::LEASE_REDACTION;
    use ace_json::{JsString, Value, json};

    #[test]
    fn capture_redacts_secrets_and_preserves_unknown_fields_and_lone_surrogates() {
        let secret = "lease-secret-xyz".to_owned();
        let lone = JsString::from_units(&[0xD800, b'x' as u16]);
        let mut map = ace_json::Map::new();
        map.insert("method", Value::from("custom/unknown"));
        map.insert("token", Value::from(format!("Bearer {secret}")));
        map.insert("rawSurrogate", Value::String(lone.clone()));
        let frame = capture_frame(&Value::Object(map), std::slice::from_ref(&secret));
        let Ok(captured) = frame else {
            panic!("expected valid captured frame");
        };
        assert!(!captured.json.contains(&secret));
        assert!(captured.json.contains(LEASE_REDACTION));
        assert!(captured.json.contains("\\ud800x"));
        let parsed = ace_json::parse(&captured.json).unwrap_or(Value::Null);
        assert_eq!(
            parsed.get("method").and_then(Value::as_str),
            Some("custom/unknown")
        );
        assert_eq!(parsed.get("rawSurrogate"), Some(&Value::String(lone)));
    }

    #[test]
    fn oversized_base64_attachment_elides_into_bounded_frame_and_still_redacts_secrets() {
        let secret = "lease-secret-img".to_owned();
        // ~1.5 MiB base64 payload exceeds the 1 MiB frame bound.
        let blob = "ABCD".repeat(400_000);
        let value = json!({
            "method": "session/prompt",
            "params": {
                "auth": format!("Bearer {secret}"),
                "image": format!("data:image/png;base64,{blob}"),
            }
        });
        let captured = capture_frame(&value, std::slice::from_ref(&secret));
        let Ok(captured) = captured else {
            panic!("expected oversized base64 image to elide cleanly");
        };
        assert!(captured.bytes < 4096);
        assert!(!captured.json.contains(&secret));
        assert!(captured.json.contains(LEASE_REDACTION));
        assert!(
            captured
                .json
                .contains("bytes of data:image/png;base64 elided; sha256 ")
        );
    }

    #[test]
    fn non_elidable_oversized_text_and_structural_overflow_fail_with_expected_errors() {
        let huge_prose = "hello world! ".repeat(MAX_PROVIDER_PAYLOAD_BYTES / 10);
        let prose_err = capture_text_frame(&huge_prose, &[]);
        assert_eq!(prose_err, Err(FrameCaptureError::ExceedsByteLimit));

        let many: Vec<Value> = (0..MAX_PROVIDER_PAYLOAD_NODES + 5)
            .map(|_| Value::Null)
            .collect();
        let node_err = capture_frame(&Value::Array(many.into()), &[]);
        assert_eq!(node_err, Err(FrameCaptureError::ExceedsStructuralLimit));
    }
}
