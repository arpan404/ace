// SPDX-License-Identifier: Apache-2.0
//! Bounded unknown evidence (`packages/adapter-opencode/src/redaction.ts`).
//! Secrets are removed before observation or translation. Copy on write: a
//! value with nothing to redact or bound is borrowed as is, since this runs
//! on every event and most evidence holds no secret. Recursion is bounded at
//! 12 levels, lists and objects at 2,048 entries.
//!
//! Credential shapes and secret-key names are `ace-redaction`'s: this module
//! keeps only the walk, the bounds and the ephemeral secrets the session owns,
//! so a shape added for another caller cannot leak here
//! (`docs/engine/behaviour.md` §20). Its keys use the adapter's own policy
//! (`is_opencode_secret_key`), which keeps `tokens` readable as usage.

use ace_json::{Map, Value};
use ace_redaction::{is_opencode_secret_key, redact_with_marker};
use std::borrow::Cow;

const MAX_STRING: usize = 1 << 20;
const MAX_ENTRIES: usize = 2048;
const MAX_DEPTH: u32 = 12;

/// Sanitize unknown evidence, borrowing it when there is nothing to change.
/// Secrets are generic so a caller that owns them (the session core) passes its
/// list without building a slice of references per event.
pub fn sanitize<'a, S: AsRef<str>>(value: &'a Value, secrets: &[S]) -> Cow<'a, Value> {
    sanitize_at(value, secrets, 0)
}

fn sanitize_at<'a, S: AsRef<str>>(value: &'a Value, secrets: &[S], depth: u32) -> Cow<'a, Value> {
    if depth > MAX_DEPTH {
        return Cow::Owned(Value::from(String::from("[depth limit]")));
    }
    match value {
        Value::String(text) => {
            let clipped = (text.len_utf16() > MAX_STRING).then(|| text.slice_units(0, MAX_STRING));
            let bounded = clipped.as_ref().unwrap_or(text);
            match sanitize_text(bounded.as_str(), secrets) {
                Cow::Borrowed(_) => clipped.map_or(Cow::Borrowed(value), |clean| {
                    Cow::Owned(Value::String(clean))
                }),
                Cow::Owned(mut clean) => {
                    // The scanner reads a surrogate as U+FFFD. Restore a high surrogate
                    // retained by the slice if the scanner kept that final unit.
                    if let Some(unit) = clipped.as_ref().and_then(|text| text.units().last())
                        && (0xd800..=0xdbff).contains(&unit)
                        && clean.ends_with(char::REPLACEMENT_CHARACTER)
                    {
                        clean.pop();
                        let mut text = ace_json::JsString::from(clean);
                        text.push_js(&ace_json::JsString::from_units(&[unit]));
                        Cow::Owned(Value::String(text))
                    } else {
                        Cow::Owned(Value::from(clean))
                    }
                }
            }
        }
        Value::Array(items) => {
            let count = items.len().min(MAX_ENTRIES);
            let mut clean: Option<Vec<Value>> = if items.len() > MAX_ENTRIES {
                Some(Vec::with_capacity(count))
            } else {
                None
            };
            for (index, item) in items.iter().enumerate().take(count) {
                match sanitize_at(item, secrets, depth + 1) {
                    Cow::Borrowed(_) => {
                        if let Some(out) = clean.as_mut() {
                            out.push(item.clone());
                        }
                    }
                    Cow::Owned(next) => {
                        if clean.is_none() {
                            let mut out = Vec::with_capacity(items.len().min(MAX_ENTRIES));
                            out.extend(items[..index].iter().cloned());
                            clean = Some(out);
                        }
                        if let Some(out) = clean.as_mut() {
                            out.push(next);
                        }
                    }
                }
            }
            match clean {
                Some(out) => Cow::Owned(Value::from(out)),
                None => Cow::Borrowed(value),
            }
        }
        Value::Object(map) => sanitize_object(value, map, secrets, depth),
        _ => Cow::Borrowed(value),
    }
}

fn sanitize_object<'a, S: AsRef<str>>(
    value: &'a Value,
    map: &'a Map,
    secrets: &[S],
    depth: u32,
) -> Cow<'a, Value> {
    let count = map.len().min(MAX_ENTRIES);
    let mut clean: Option<Map> = if map.len() > MAX_ENTRIES {
        Some(Map::new())
    } else {
        None
    };
    for (key, original) in map.iter().take(count) {
        let next = if is_opencode_secret_key(key) {
            Cow::Owned(Value::from(String::from("[redacted]")))
        } else {
            sanitize_at(original, secrets, depth + 1)
        };
        match next {
            Cow::Borrowed(_) => {
                if let Some(out) = clean.as_mut() {
                    out.insert(key.clone(), original.clone());
                }
            }
            Cow::Owned(redacted) => {
                if clean.is_none() {
                    let mut out = Map::with_capacity(count);
                    for (earlier, kept) in map.iter().take(count).take_while(|(k, _)| *k != key) {
                        out.insert(earlier.clone(), kept.clone());
                    }
                    clean = Some(out);
                }
                if let Some(out) = clean.as_mut() {
                    out.insert(key.clone(), redacted);
                }
            }
        }
    }
    match clean {
        Some(out) => Cow::Owned(Value::Object(out)),
        None => Cow::Borrowed(value),
    }
}

/// Replace listed secrets and every credential shape `ace-redaction` knows.
fn sanitize_text<'a, S: AsRef<str>>(text: &'a str, secrets: &[S]) -> Cow<'a, str> {
    let mut current = Cow::Borrowed(text);
    for secret in secrets {
        let secret = secret.as_ref();
        if !secret.is_empty() && current.contains(secret) {
            current = Cow::Owned(current.replace(secret, "[redacted]"));
        }
    }
    match redact_with_marker(&current, "[redacted]") {
        Some(redacted) => Cow::Owned(redacted),
        None => current,
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_STRING, sanitize};
    use crate::translate::translator::Translator;
    use ace_json::{Value, json};

    /// Token counters are usage, not credentials: they survive sanitizing, and
    /// translation still emits the context sample and the usage fact with their
    /// cost (the TypeScript pins 185/35 tokens and $0.0027 in `v2.test.ts`).
    #[test]
    fn token_counters_survive_sanitize_and_still_translate_to_usage_and_context() {
        let step = json!({
            "id": "e1",
            "type": "session.step.ended",
            "data": { "sessionID": "a", "tokens": { "input": 185, "output": 35 } },
        });
        let clean = sanitize(&step, &[] as &[&str]).into_owned();
        assert!(clean["data"]["tokens"].as_object().is_some(), "{clean}");
        let mut out = String::new();
        let mut translator = Translator::new(String::from("root"));
        let created = json!({
            "id": "e0",
            "type": "session.created",
            "data": { "id": "a" },
        });
        translator.translate_json(
            r#"{"channel":"sse","dir":"in"}"#,
            &ace_json::ser::to_string(&created).expect("events serialize"),
            1.0,
            &mut out,
        );
        translator.translate_json(
            r#"{"channel":"sse","dir":"in"}"#,
            &ace_json::ser::to_string(&clean).expect("sanitized events serialize"),
            1.0,
            &mut out,
        );
        assert!(out.contains(r#""type":"context.sample""#), "{out}");
        assert!(out.contains(r#""usedTokens":220"#), "{out}");

        let usage = json!({
            "id": "e2",
            "type": "session.usage.updated",
            "data": {
                "sessionID": "a",
                "tokens": { "input": 185, "output": 35 },
                "cost": 0.0027,
            },
        });
        let clean = sanitize(&usage, &[] as &[&str]).into_owned();
        let mut out = String::new();
        translator.translate_json(
            r#"{"channel":"sse","dir":"in"}"#,
            &ace_json::ser::to_string(&clean).expect("sanitized events serialize"),
            1.0,
            &mut out,
        );
        assert!(out.contains(r#""type":"usage""#), "{out}");
        assert!(out.contains(r#""inputTokens":185"#), "{out}");
        assert!(out.contains(r#""outputTokens":35"#), "{out}");
        assert!(out.contains(r#""costUsd":0.0027"#), "{out}");
    }

    /// Opaque provider state is redacted under both its 2.0 and 2.1 names,
    /// text is kept.
    #[test]
    fn opaque_provider_state_is_redacted_under_both_names() {
        let event = json!({
            "type": "session.text.ended",
            "data": {
                "text": "Pushed.",
                "providerState": { "reasoningEncryptedContent": "secret-20" },
                "native": { "itemId": "rs_1", "reasoningEncryptedContent": "secret-21" },
            },
        });
        let clean = sanitize(&event, &[] as &[&str]);
        assert_eq!(
            clean.into_owned(),
            json!({
                "type": "session.text.ended",
                "data": {
                    "text": "Pushed.",
                    "providerState": "[redacted]",
                    "native": "[redacted]",
                },
            })
        );
    }

    /// Fields that only contain the word native are not redacted.
    #[test]
    fn native_substrings_are_not_redacted() {
        let value = json!({ "nativeSessionId": "ses_1", "native_name": "shell" });
        assert_eq!(sanitize(&value, &[] as &[&str]).into_owned(), value);
    }

    /// Credentials and session secrets are redacted deep inside evidence,
    /// and the rest is kept. Sanitizing never mutates its input.
    #[test]
    fn credentials_and_secrets_are_redacted_deep_inside() {
        let evidence = json!({
            "kept": { "text": "plain", "count": 2, "flags": [true, null] },
            "output": [
                "fine",
                "curl -H 'Authorization: Bearer abc.def-1'",
                { "note": "token sk-live-1 used" },
            ],
        });
        let clean = sanitize(&evidence, &["sk-live-1"]).into_owned();
        assert_eq!(
            clean,
            json!({
                "kept": { "text": "plain", "count": 2, "flags": [true, null] },
                "output": [
                    "fine",
                    "curl -H 'Authorization: [redacted]'",
                    { "note": "token [redacted] used" },
                ],
            })
        );
        assert_eq!(
            evidence["output"][1],
            json!("curl -H 'Authorization: Bearer abc.def-1'")
        );
    }

    /// Every credential shape `ace-redaction` owns is redacted here too: provider
    /// tokens, assignments and the union's secret-key names, with ordinary fields kept.
    #[test]
    fn every_credential_shape_ace_redaction_knows_is_redacted_here() {
        let evidence = json!({
            "note": "pushed with ghp_12345678901234567890",
            "command": "env TOKEN=ghp_abcdefghijklmnopqrstuvwxyz",
            "settings": { "value": "kept-hidden" },
            "header": "kept",
        });
        let clean = sanitize(&evidence, &[] as &[&str]).into_owned();
        let text = ace_json::ser::to_string(&clean).expect("sanitized evidence serializes");
        assert!(!text.contains("ghp_12345678901234567890"), "{text}");
        assert!(!text.contains("ghp_abcdefghijklmnopqrstuvwxyz"), "{text}");
        assert!(!text.contains("kept-hidden"), "{text}");
        assert!(text.contains("\"header\":\"kept\""), "{text}");
    }

    /// Evidence is bounded to 2,048 entries per list or object and 12 levels.
    #[test]
    fn evidence_is_bounded_in_width_and_depth() {
        let wide: Vec<ace_json::Value> = (0..2050).map(|index| json!(index)).collect();
        let fields: ace_json::Map = wide
            .iter()
            .enumerate()
            .map(|(index, value)| (format!("k{index}"), value.clone()))
            .collect();
        let mut deep = json!("bottom");
        for _ in 0..14 {
            deep = json!({ "deep": deep });
        }
        let value = json!({ "wide": wide, "fields": fields, "deep": deep });
        let clean = sanitize(&value, &[] as &[&str]);
        let text = ace_json::ser::to_string(&clean).expect("sanitized evidence serializes");
        assert_eq!(
            clean["wide"].as_array().map(|items| items.len()),
            Some(2048)
        );
        assert_eq!(text.matches("\"k").count(), 2048);
        assert!(text.contains("\"[depth limit]\""));
        assert!(!text.contains("bottom"));
    }

    /// Every JSON object is plain by construction, so nested objects keep
    /// their own fields: there are no class instances to strip. (The
    /// TypeScript case covers `Date` and `Map` inputs, which have no JSON
    /// form; `ace-adapter-api` documents this plainness for its readers.)
    #[test]
    fn nested_objects_keep_only_their_own_fields() {
        let value = json!({ "when": {}, "map": {} });
        assert_eq!(sanitize(&value, &[] as &[&str]).into_owned(), value);
    }

    #[test]
    fn truncation_preserves_the_split_surrogate_even_when_redacting() {
        for padding in [MAX_STRING - 8, MAX_STRING - 7] {
            let plain = Value::from(format!("secret{}😀", "a".repeat(padding)));
            let clean = sanitize(&plain, &["secret"]);
            let text = clean.as_js_str().expect("text");
            assert!(text.as_str().starts_with("[redacted]"));
            assert_eq!(
                text.units().last(),
                Some(if padding == MAX_STRING - 8 {
                    0xde00
                } else {
                    0xd83d
                })
            );
        }
    }
}
