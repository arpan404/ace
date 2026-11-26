// SPDX-License-Identifier: Apache-2.0
//! The wire encodings (`@opencode/client`'s `appendQuery` and `encodeURIComponent`): a path
//! segment keeps `!'()*~`, a query is `URLSearchParams` serialization (space is `+`, `!'()~`
//! escaped), a null is the text `null`, and an array repeats its key.

use ace_json::Value;

use crate::translate::data::num_str;

/// `appendQuery`: an object is `key[child]`, an array repeats the key, null is
/// the text `null`, and a number prints as `String(value)`.
pub(super) fn flatten(key: &str, value: &Value, out: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            for (nested, item) in map.iter() {
                flatten(&format!("{key}[{nested}]"), item, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                flatten(key, item, out);
            }
        }
        Value::Null => out.push((key.to_owned(), String::from("null"))),
        Value::String(text) => out.push((key.to_owned(), text.as_str().to_owned())),
        Value::Bool(hit) => out.push((key.to_owned(), hit.to_string())),
        Value::Number(number) => {
            out.push((key.to_owned(), num_str(number.as_f64().unwrap_or(0.0))));
        }
    }
}

/// `encodeURIComponent`, the encoding the SDK gives a path segment.
pub(super) fn encode_segment(text: &str) -> String {
    encode(text, |byte| {
        matches!(
            byte,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\''
                | b'('
                | b')'
        )
    })
}

/// `URLSearchParams` serialization, what the SDK's query reaches the wire as: a
/// space is `+`, and `!'()~` are escaped where a path segment keeps them.
pub(super) fn encode_query(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b' ' => out.push('+'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn encode(text: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if keep(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
