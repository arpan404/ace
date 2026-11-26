// SPDX-License-Identifier: Apache-2.0
//! Bounded unknown evidence (`packages/adapter-opencode/src/redaction.ts`).
//! Secrets are removed before observation or translation. Copy on write: a
//! value with nothing to redact or bound is borrowed as is, since this runs
//! on every event and most evidence holds no secret. Recursion is bounded at
//! 12 levels, lists and objects at 2,048 entries.

use ace_json::{Map, Value};
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
        Value::String(text) => match sanitize_text(text, secrets) {
            Cow::Borrowed(_) => Cow::Borrowed(value),
            Cow::Owned(clean) => Cow::Owned(Value::from(clean)),
        },
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
        let next = if is_secret_key(key) {
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

/// Truncate to a million UTF-16 code units, replace listed secrets, then
/// `Authorization`/`Basic` credentials.
fn sanitize_text<'a, S: AsRef<str>>(text: &'a str, secrets: &[S]) -> Cow<'a, str> {
    let mut current = Cow::Borrowed(truncate_units(text));
    for secret in secrets {
        let secret = secret.as_ref();
        if !secret.is_empty() && current.contains(secret) {
            current = Cow::Owned(current.replace(secret, "[redacted]"));
        }
    }
    if has_credential(&current) {
        current = Cow::Owned(redact_credentials(&current));
    }
    current
}

fn truncate_units(text: &str) -> &str {
    if text.len() <= MAX_STRING {
        return text;
    }
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > MAX_STRING {
            break;
        }
        end = index + ch.len_utf8();
    }
    &text[..end]
}

/// Whether the text holds a `Bearer`/`Basic` credential with its token.
fn has_credential(text: &str) -> bool {
    credential_span(text.as_bytes(), 0).is_some()
}

/// The byte span of the first credential match at or after `from`.
fn credential_span(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut index = from;
    while index < bytes.len() {
        let keyword = if matches_word(bytes, index, b"bearer") {
            Some(6)
        } else if matches_word(bytes, index, b"basic") {
            Some(5)
        } else {
            None
        };
        if let Some(len) = keyword {
            let mut next = index + len;
            let after_keyword = next;
            while matches!(bytes.get(next), Some(b' ' | b'\t' | b'\n' | b'\r' | 0x0C)) {
                next += 1;
            }
            // The pattern needs whitespace between the scheme and its token.
            if next == after_keyword {
                index += 1;
                continue;
            }
            let start = next;
            while let Some(byte) = bytes.get(next) {
                if byte.is_ascii_alphanumeric()
                    || matches!(byte, b'+' | b'/' | b'_' | b'=' | b'.' | b'-')
                {
                    next += 1;
                } else {
                    break;
                }
            }
            if next > start {
                return Some((index, next));
            }
            index += 1;
        } else {
            index += 1;
        }
    }
    None
}

/// ASCII case-insensitive word match bounded to ASCII letters around it.
fn matches_word(bytes: &[u8], at: usize, word: &[u8]) -> bool {
    if at + word.len() > bytes.len() {
        return false;
    }
    bytes[at..at + word.len()]
        .iter()
        .zip(word.iter())
        .all(|(a, b)| a.to_ascii_lowercase() == *b)
}

fn redact_credentials(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        match credential_span(bytes, index) {
            Some((start, end)) => {
                out.push_str(&text[index..start]);
                out.push_str("[redacted]");
                index = end;
            }
            None => {
                out.push_str(&text[index..]);
                break;
            }
        }
    }
    out
}

/// The TypeScript secret-key pattern, matched case-insensitively:
/// authorization, password, cookie, api.?key, credential, access.?token,
/// refresh.?token, headers, settings, providerState, resultState,
/// encryptedContent, and exactly `native`.
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    let text = lower.as_str();
    text.contains("authorization")
        || text.contains("password")
        || text.contains("cookie")
        || has_suffixed(text, "api", "key")
        || text.contains("credential")
        || has_suffixed(text, "access", "token")
        || has_suffixed(text, "refresh", "token")
        || text.contains("headers")
        || text.contains("settings")
        || text.contains("providerstate")
        || text.contains("resultstate")
        || text.contains("encryptedcontent")
        || text == "native"
}

/// `head` plus an optional single character plus `tail`, like `api.?key`.
fn has_suffixed(text: &str, head: &str, tail: &str) -> bool {
    let mut search = 0;
    while let Some(found) = text[search..].find(head) {
        let rest = &text[search + found + head.len()..];
        if rest.starts_with(tail) {
            return true;
        }
        if let Some(next) = rest.get(..1)
            && rest[next.len()..].starts_with(tail)
        {
            return true;
        }
        search += found + head.len();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::sanitize;
    use ace_json::json;

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
}
