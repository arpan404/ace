// SPDX-License-Identifier: Apache-2.0

//! JSON nested deeper than serde_json's 128 levels. Provider records can be (JavaScript reads them),
//! and so can the items and rows ace makes from them, so both ends read past 128 up to a cap that
//! keeps the stack bounded.

use serde_json::Value;

/// The deepest nesting any message or stored row is read with: a provider record's own cap
/// (512, ADR 0206) plus room for the item and envelope around it.
pub const WIRE_DEPTH: usize = 640;

/// The deepest `[`/`{` nesting outside strings.
pub fn nesting(bytes: &[u8]) -> usize {
    let (mut level, mut deepest, mut string, mut escaped) = (0usize, 0usize, false, false);
    for &byte in bytes {
        if string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => string = true,
            b'[' | b'{' => {
                level += 1;
                deepest = deepest.max(level);
            }
            b']' | b'}' => level = level.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

/// Parse `bytes` with no recursion limit when it nests at most `cap` levels; `None` otherwise or
/// when it is not one JSON value.
pub fn parse_within(bytes: &[u8], cap: usize) -> Option<Value> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        return Some(value);
    }
    if nesting(bytes) > cap {
        return None;
    }
    let mut reader = serde_json::Deserializer::from_slice(bytes);
    reader.disable_recursion_limit();
    let value = serde::Deserialize::deserialize(&mut reader).ok()?;
    reader.end().ok()?;
    Some(value)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn a_message_nested_past_128_levels_is_read_up_to_the_cap() {
        let nested = |n: usize| format!("{}0{}", "[".repeat(n), "]".repeat(n));
        assert!(parse_within(nested(300).as_bytes(), WIRE_DEPTH).is_some());
        assert!(parse_within(nested(WIRE_DEPTH + 1).as_bytes(), WIRE_DEPTH).is_none());
        // Brackets inside strings do not count.
        assert_eq!(nesting(br#"{"a":"[[[[\"]]"}"#), 1);
    }
}
