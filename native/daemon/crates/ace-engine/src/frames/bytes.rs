// SPDX-License-Identifier: Apache-2.0
//! Byte measures over JavaScript strings (`fact-bytes.ts`). Every count is in UTF-16 code
//! units, as JavaScript sees the string, so a lone surrogate costs what `JSON.stringify`
//! writes for it and never what its replacement character would.

use ace_json::{JsString, Value};

/// UTF-8 bytes of `JSON.stringify(text)`, counted without building it (`fact-bytes.ts:2`).
pub fn json_string_bytes(text: &JsString) -> usize {
    // The starting 2 is the quotes.
    let mut bytes = 2;
    let mut units = text.units().peekable();
    while let Some(unit) = units.next() {
        if unit < 0x80 {
            if unit == 34 || unit == 92 {
                bytes += 2;
            } else if unit >= 32 {
                bytes += 1;
            } else {
                // `\b \t \n \f \r` have two-byte escapes; every other control is `\u00XX`.
                bytes += if matches!(unit, 8 | 9 | 10 | 12 | 13) {
                    2
                } else {
                    6
                };
            }
        } else if unit < 0x800 {
            bytes += 2;
        } else if (0xd800..0xdc00).contains(&unit) {
            match units.peek() {
                Some(low) if (0xdc00..0xe000).contains(low) => {
                    bytes += 4;
                    units.next();
                }
                // A lone high surrogate is written `\udxxx`.
                _ => bytes += 6,
            }
        } else if (0xdc00..0xe000).contains(&unit) {
            bytes += 6;
        } else {
            bytes += 3;
        }
    }
    bytes
}

/// `Buffer.byteLength(string)`: UTF-8 bytes, with a lone surrogate counted as three, the way
/// Node encodes it as U+FFFD.
pub fn utf8_len(text: &JsString) -> usize {
    let mut bytes = 0;
    let mut units = text.units().peekable();
    while let Some(unit) = units.next() {
        if unit < 0x80 {
            bytes += 1;
        } else if unit < 0x800 {
            bytes += 2;
        } else if (0xd800..0xdc00).contains(&unit) {
            match units.peek() {
                Some(low) if (0xdc00..0xe000).contains(low) => {
                    bytes += 4;
                    units.next();
                }
                _ => bytes += 3,
            }
        } else {
            // A lone low surrogate is U+FFFD too.
            bytes += 3;
        }
    }
    bytes
}

/// UTF-8 bytes of `JSON.stringify(facts)` for streamed facts, which are flat records
/// (`fact-bytes.ts:27`). String fields are counted in place, so a batch of deltas is never
/// serialised only to be measured.
pub fn streamed_facts_bytes(facts: &[Value]) -> usize {
    let mut bytes = 2 + facts.len().saturating_sub(1);
    for fact in facts {
        bytes += 2;
        let Value::Object(map) = fact else {
            continue;
        };
        for (fields, (key, value)) in map.iter().enumerate() {
            let size = match value {
                Value::String(text) => json_string_bytes(text),
                other => ace_json::to_string(other).len(),
            };
            bytes += (if fields > 0 { 1 } else { 0 }) + json_string_bytes(key) + 1 + size;
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::{json_string_bytes, streamed_facts_bytes, utf8_len};
    use ace_json::{JsString, Value, json};

    fn units(text: &[u16]) -> JsString {
        JsString::from_units(text)
    }

    #[test]
    fn utf8_len_counts_a_lone_surrogate_as_three_bytes_as_buffer_byte_length_does() {
        assert_eq!(utf8_len(&JsString::from("é€😀 中文")), 2 + 3 + 4 + 1 + 6);
        assert_eq!(utf8_len(&units(&[0xd800])), 3);
        assert_eq!(utf8_len(&units(&[0xdc00])), 3);
        assert_eq!(utf8_len(&JsString::from_units(&[0x61, 0xd83d])), 1 + 3);
    }

    #[test]
    fn json_string_bytes_counts_the_quotes_and_each_escape() {
        assert_eq!(json_string_bytes(&JsString::from("")), 2);
        assert_eq!(json_string_bytes(&JsString::from("hello")), 2 + 5);
        assert_eq!(json_string_bytes(&JsString::from("\"\\")), 2 + 4);
        assert_eq!(
            json_string_bytes(&JsString::from("\n\t\u{1}")),
            2 + 2 + 2 + 6
        );
        assert_eq!(json_string_bytes(&units(&[0xd800])), 2 + 6);
        assert_eq!(json_string_bytes(&JsString::from("😀")), 2 + 4);
    }

    fn delta(append: &str, extra: Value) -> Value {
        let mut fact = match json!({
            "type": "item.delta",
            "agent": "root",
            "item": "message",
            "field": "text",
            "append": append,
        }) {
            Value::Object(map) => map,
            _ => unreachable!("a literal object"),
        };
        if let Value::Object(extra) = extra {
            for (key, value) in extra {
                fact.insert(key, value);
            }
        }
        Value::Object(fact)
    }

    /// The moved `fact-bytes.test.ts` rows: seven as they are, four as the JSON those
    /// JavaScript-only values serialize to (an absent field, `null`, and a string).
    #[test]
    fn streamed_facts_bytes_equals_the_serialised_json_length() {
        let facts: Vec<(&str, Vec<Value>)> = vec![
            ("no facts", vec![]),
            (
                "a signal with and without an agent",
                vec![
                    json!({"type": "signal"}),
                    json!({"type": "signal", "agent": "root"}),
                ],
            ),
            ("plain text", vec![delta("hello world", json!({}))]),
            (
                "escapes and controls",
                vec![delta("\"quoted\"\\path\n\t\u{1}\u{1f}\u{7f}", json!({}))],
            ),
            ("multi-byte characters", vec![delta("é€😀 中文", json!({}))]),
            (
                "lone surrogates",
                vec![
                    Value::Object(
                        match json!({"type": "item.delta", "append": Value::String(units(&[0x61, 0xd800, 0x62, 0xdc00]))})
                        {
                            Value::Object(map) => map,
                            _ => unreachable!(),
                        },
                    ),
                    Value::Object(
                        match json!({"type": "item.delta", "append": Value::String(units(&[0xd83d]))})
                        {
                            Value::Object(map) => map,
                            _ => unreachable!(),
                        },
                    ),
                ],
            ),
            // "an absent optional field": `agent: undefined` is dropped by `JSON.stringify`.
            ("an absent optional field", vec![delta("x", json!({}))]),
            (
                "a non-string field",
                vec![delta(
                    "x",
                    json!({"at": 12.5, "done": true, "meta": {"n": [1, "é"]}}),
                )],
            ),
            // "fields serialised as nothing or as null": the toJSON/function fields are
            // absent, NaN is `null`.
            (
                "fields serialised as nothing or as null",
                vec![delta("x", json!({"none": null, "nan": Value::Null}))],
            ),
            // "a field serialised through toJSON": the Date is its ISO string.
            (
                "a field serialised through toJSON",
                vec![delta(
                    "x",
                    json!({"at": "1970-01-01T00:00:00.000Z", "id": "é"}),
                )],
            ),
            (
                "a large batch",
                (0..256)
                    .map(|n| delta(&format!("chunk {n} ").repeat(n % 9), json!({})))
                    .collect(),
            ),
        ];
        for (name, facts) in facts {
            let expected = ace_json::to_string(&Value::Array(facts.clone().into())).len();
            assert_eq!(streamed_facts_bytes(&facts), expected, "{name}");
        }
    }
}
