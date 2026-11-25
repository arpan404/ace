// SPDX-License-Identifier: Apache-2.0
//! `ProviderPayload`'s bound over a value that is already decoded
//! (`packages/provider-kit/src/payload.ts:14`-`:40`). The TypeScript admits an
//! encoded text, parses it, and measures what it built. A native session holds
//! the parsed value already, so it measures that value and the serialized text
//! it produced for the frame: no text is parsed again, and nothing is encoded
//! twice.
//!
//! Order is the TypeScript's: the byte bound first, then the structural bound,
//! so a frame past both names the same reason `ProviderPayload` does.

use ace_json::Value;

/// `maxProviderPayloadBytes` (`payload.ts:5`): the frame text `ProviderPayload` admits.
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
/// `ProviderPayload`'s structural bound (`payload.ts:31`).
pub const MAX_PAYLOAD_NODES: usize = 32_768;

/// Why `ProviderPayload` refused a value. Both are the TypeScript's
/// `RangeError` messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PayloadError {
    /// The serialized text is over one MiB of UTF-8.
    #[error("Provider payload exceeds byte limit")]
    Bytes,
    /// The value holds more than 32,768 nodes.
    #[error("Provider payload exceeds structural limit")]
    Structural,
}

impl PayloadError {
    /// The message the TypeScript throws, for a diagnostic.
    pub fn message(self) -> &'static str {
        match self {
            PayloadError::Bytes => "Provider payload exceeds byte limit",
            PayloadError::Structural => "Provider payload exceeds structural limit",
        }
    }
}

/// Admits a value and the text it serializes to: the UTF-8 byte bound, then
/// the node count. The text must be the value's own serialization, so the
/// caller encodes once and this never parses it.
pub fn admit(text: &str, value: &Value) -> Result<(), PayloadError> {
    if text.len() > MAX_PAYLOAD_BYTES {
        return Err(PayloadError::Bytes);
    }
    if nodes(value) > MAX_PAYLOAD_NODES {
        return Err(PayloadError::Structural);
    }
    Ok(())
}

/// How many nodes a value holds: every value counts, containers included,
/// keys not counted (`payload.ts:22`-`:40`). One linear pass with a heap stack,
/// so a deeply nested value cannot exhaust the call stack.
pub fn nodes(value: &Value) -> usize {
    let mut pending = vec![value];
    let mut nodes = 0usize;
    while let Some(value) = pending.pop() {
        nodes += 1;
        match value {
            Value::Array(items) => pending.extend(items.iter()),
            Value::Object(map) => pending.extend(map.values()),
            _ => {}
        }
    }
    nodes
}

#[cfg(test)]
mod tests {
    use super::{MAX_PAYLOAD_BYTES, MAX_PAYLOAD_NODES, PayloadError, admit, nodes};
    use ace_json::{Array, Value, json};

    fn text(value: &Value) -> String {
        ace_json::to_string(value)
    }

    #[test]
    fn a_frame_past_the_byte_bound_reports_the_byte_limit() {
        // Exactly one MiB of UTF-8 passes; one more byte does not.
        let inside = Value::from("a".repeat(MAX_PAYLOAD_BYTES - 2));
        assert_eq!(text(&inside).len(), MAX_PAYLOAD_BYTES);
        assert_eq!(admit(&text(&inside), &inside), Ok(()));

        let outside = Value::from("a".repeat(MAX_PAYLOAD_BYTES - 1));
        assert_eq!(text(&outside).len(), MAX_PAYLOAD_BYTES + 1);
        assert_eq!(admit(&text(&outside), &outside), Err(PayloadError::Bytes));
        assert_eq!(
            PayloadError::Bytes.message(),
            "Provider payload exceeds byte limit"
        );
    }

    #[test]
    fn an_astral_character_counts_its_utf8_bytes() {
        // An emoji is four UTF-8 bytes but one code point: the bound is bytes.
        let inside = Value::from("😀".repeat((MAX_PAYLOAD_BYTES - 2) / 4));
        assert!(text(&inside).len() <= MAX_PAYLOAD_BYTES);
        assert_eq!(admit(&text(&inside), &inside), Ok(()));
    }

    #[test]
    fn the_structural_bound_counts_every_value_and_no_keys() {
        // A flat array of 32,767 scalars plus the array itself is 32,768 nodes.
        let inside = Value::Array(Array::from(vec![Value::Null; MAX_PAYLOAD_NODES - 1]));
        assert_eq!(nodes(&inside), MAX_PAYLOAD_NODES);
        assert_eq!(admit(&text(&inside), &inside), Ok(()));

        let outside = Value::Array(Array::from(vec![Value::Null; MAX_PAYLOAD_NODES]));
        assert_eq!(nodes(&outside), MAX_PAYLOAD_NODES + 1);
        assert_eq!(
            admit(&text(&outside), &outside),
            Err(PayloadError::Structural)
        );
        assert_eq!(
            PayloadError::Structural.message(),
            "Provider payload exceeds structural limit"
        );
    }

    #[test]
    fn object_keys_take_no_node() {
        let value = json!({ "a": 1, "b": { "c": [1, 2] } });
        // The object, 1, the inner object, the array, 1 and 2; keys never count.
        assert_eq!(nodes(&value), 6);
    }
}
