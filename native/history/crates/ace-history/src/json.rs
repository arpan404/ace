// SPDX-License-Identifier: Apache-2.0

//! The lenient accessors native records are read through (`object`, `string`, `timestamp` in
//! `@ace/native-session`): a missing or wrongly typed field reads as absent, never as an error.

use std::sync::LazyLock;

use history_text::js;
use serde_json::{Map, Value};

static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

/// The value as an object, or an empty one.
pub fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().unwrap_or(&EMPTY)
}

/// A field of an object, `Null` when absent.
pub fn field<'a>(map: &'a Map<String, Value>, key: &str) -> &'a Value {
    map.get(key).unwrap_or(&Value::Null)
}

/// A field as a string.
pub fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// `value ?? fallback`: JSON null is nullish too.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// A non-negative safe integer, or a date string `Date.parse` reads.
pub fn timestamp(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            let f = n.as_f64()?;
            (f >= 0.0 && f.fract() == 0.0 && f <= js::MAX_SAFE_INTEGER as f64).then_some(f as i64)
        }
        Value::String(s) => js::parse_date(s).filter(|ms| (0..=js::MAX_SAFE_INTEGER).contains(ms)),
        _ => None,
    }
}

/// Whether the field is JSON `true`.
pub fn is_true(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key) == Some(&Value::Bool(true))
}

/// Whether the object has the key at all (`Object.hasOwn`).
pub fn has(map: &Map<String, Value>, key: &str) -> bool {
    map.contains_key(key)
}

/// The deepest nesting a provider record is decoded with. serde_json stops at 128 levels and
/// JavaScript goes much deeper; past 128 the record is decoded again without serde's limit, up to
/// this depth, so the reader's stack stays bounded. Deeper records stay raw (ADR 0206).
pub const MAX_DEPTH: usize = 512;

/// `JSON.parse` of provider text, as close as Rust strings allow: nesting past serde's limit is
/// read up to [`MAX_DEPTH`], and a lone UTF-16 surrogate escape, which a Rust string cannot hold,
/// reads as U+FFFD instead of failing the record (ADR 0206).
pub fn parse(text: &str) -> Option<Value> {
    match serde_json::from_str(text) {
        Ok(value) => Some(value),
        Err(_) => {
            let repaired = repair_surrogates(text);
            let text = repaired.as_deref().unwrap_or(text);
            if repaired.is_some()
                && let Ok(value) = serde_json::from_str(text)
            {
                return Some(value);
            }
            history_wire::parse_within(text.as_bytes(), MAX_DEPTH)
        }
    }
}

/// A row or item this reader stored, read back: as deep as anything it stores can be.
pub fn stored<T: serde::de::DeserializeOwned>(text: &str) -> crate::error::Result<T> {
    let value = history_wire::parse_within(text.as_bytes(), history_wire::WIRE_DEPTH)
        .ok_or_else(|| crate::error::Error::message("A stored history row is not valid JSON"))?;
    serde_json::from_value(value).map_err(|e| crate::error::Error::message(e.to_string()))
}

fn hex4(bytes: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(bytes.get(..4)?).ok()?;
    u32::from_str_radix(text, 16).ok()
}

/// The text with every lone surrogate escape (`\ud800` with no pair) written as `�`; `None`
/// when it has none.
fn repair_surrogates(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        if bytes.get(i + 1) != Some(&b'u') {
            i += 2;
            continue;
        }
        let Some(unit) = hex4(&bytes[i + 2..]) else {
            i += 2;
            continue;
        };
        let paired_low = |at: usize| {
            bytes.get(at) == Some(&b'\\')
                && bytes.get(at + 1) == Some(&b'u')
                && hex4(&bytes[at + 2..]).is_some_and(|u| (0xDC00..=0xDFFF).contains(&u))
        };
        if (0xD800..=0xDBFF).contains(&unit) && paired_low(i + 6) {
            i += 12;
            continue;
        }
        if (0xD800..=0xDFFF).contains(&unit) {
            let repaired = out.get_or_insert_with(String::new);
            repaired.push_str(&text[copied..i]);
            repaired.push_str("\\ufffd");
            copied = i + 6;
        }
        i += 6;
    }
    out.map(|mut repaired| {
        repaired.push_str(&text[copied..]);
        repaired
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn nested(levels: usize) -> String {
        format!("{}1{}", "[".repeat(levels), "]".repeat(levels))
    }

    #[test]
    fn records_nested_past_serdes_limit_decode_as_javascript_decodes_them() {
        assert!(serde_json::from_str::<Value>(&nested(150)).is_err());
        assert!(parse(&nested(150)).is_some());
        assert!(parse(&nested(MAX_DEPTH)).is_some());
        assert!(parse(&nested(MAX_DEPTH + 1)).is_none());
    }

    #[test]
    fn a_lone_surrogate_reads_as_the_replacement_character() {
        let value = parse(r#"{"text":"a\ud800b","low":"\udc00","pair":"😀"}"#).unwrap();
        assert_eq!(value["text"], "a\u{fffd}b");
        assert_eq!(value["low"], "\u{fffd}");
        assert_eq!(value["pair"], "\u{1f600}");
        // An escaped backslash is not an escape.
        assert_eq!(parse(r#""\\ud800""#).unwrap(), r"\ud800");
    }

    #[test]
    fn integers_past_two_to_the_53rd_keep_the_digits_the_provider_wrote() {
        // JavaScript rounds 9007199254740993 to ...992; the reader keeps what was written.
        let value = parse(r#"{"n":9007199254740993,"m":12345678901234567890}"#).unwrap();
        assert_eq!(
            value.to_string(),
            r#"{"n":9007199254740993,"m":12345678901234567890}"#
        );
        // Timestamps still require a safe integer, as JavaScript's do.
        assert_eq!(timestamp(&value["n"]), None);
    }

    #[test]
    fn dates_are_read_in_the_iso_format_providers_write_and_nothing_else() {
        assert_eq!(
            timestamp(&Value::from("2030-01-02T10:00:00Z")),
            Some(1_893_578_400_000)
        );
        assert_eq!(
            timestamp(&Value::from("2030-01-02T10:00:00.123456Z")),
            Some(1_893_578_400_123)
        );
        // Date.parse reads these, differently per engine; the reader does not (ADR 0206).
        assert_eq!(timestamp(&Value::from("Jan 2, 2030 10:00:00 GMT")), None);
        assert_eq!(timestamp(&Value::from("2030/01/02")), None);
    }
}
