// SPDX-License-Identifier: Apache-2.0
//! Lease redaction (`frame-redaction.ts`): exact ephemeral secrets are
//! replaced, everything else keeps its value. The walk is iterative, so any
//! depth keeps its unrelated values and redacts at every level.

use ace_json::{JsString, Map, Value};
use std::collections::{HashMap, HashSet};

/// What a lease secret reads as once redacted.
pub const LEASE_REDACTION: &str = "[ace lease redacted]";

/// Redact exact ephemeral lease material, keeping unchanged values.
pub fn redact_lease(data: &Value, secrets: &[String]) -> Value {
    let active: Vec<JsString> = secrets
        .iter()
        .filter(|secret| !secret.is_empty())
        .map(|secret| JsString::from(secret.as_str()))
        .collect();
    if active.is_empty() {
        return data.clone();
    }
    let redaction = JsString::from(LEASE_REDACTION);
    // Flatten the tree into an arena with explicit stacks: no recursion, no
    // depth limit. Parents always precede children in `order`, so the reverse
    // is a post-order that folds children before their parent.
    struct Node<'a> {
        value: &'a Value,
        // Children in iteration order; for objects `keys` runs parallel.
        children: Vec<usize>,
        keys: Vec<JsString>,
    }
    let mut arena: Vec<Node<'_>> = Vec::new();
    let mut order: Vec<usize> = Vec::new();
    // Iterative pre-order that links children in insertion order.
    let mut pre: Vec<(&Value, Option<usize>)> = vec![(data, None)];
    while let Some((value, parent)) = pre.pop() {
        let index = arena.len();
        arena.push(Node {
            value,
            children: Vec::new(),
            keys: Vec::new(),
        });
        order.push(index);
        if let Some(parent_index) = parent {
            arena[parent_index].children.push(index);
        }
        match value {
            Value::Array(items) => {
                for child in items.iter().rev() {
                    pre.push((child, Some(index)));
                }
            }
            Value::Object(map) => {
                let keys: Vec<JsString> = map.keys().cloned().collect();
                arena[index].keys = keys.clone();
                for key in keys.iter().rev() {
                    if let Some(child) = map.get(key) {
                        pre.push((child, Some(index)));
                    }
                }
            }
            _ => {}
        }
    }
    let mut results: Vec<Option<Value>> = vec![None; arena.len()];
    for &index in order.iter().rev() {
        let (is_array, is_object, keys) = {
            let node = &arena[index];
            (
                matches!(node.value, Value::Array(_)),
                matches!(node.value, Value::Object(_)),
                node.keys.clone(),
            )
        };
        if !is_array && !is_object {
            results[index] = Some(leaf_value(arena[index].value, &active, &redaction));
            continue;
        }
        if is_array {
            let children = std::mem::take(&mut arena[index].children);
            let mut out = Vec::with_capacity(children.len());
            for child in children {
                let value = results[child].take().unwrap_or(Value::Null);
                out.push(value);
            }
            results[index] = Some(Value::Array(out.into()));
        } else {
            let children = std::mem::take(&mut arena[index].children);
            let mut child_values = Vec::with_capacity(children.len());
            for child in children {
                child_values.push(results[child].take().unwrap_or(Value::Null));
            }
            let safe_keys: Vec<JsString> = keys
                .iter()
                .map(|key| redact_js(key, &active, &redaction))
                .collect();
            let used: HashSet<JsString> = keys.iter().cloned().collect();
            let mut seen: HashSet<JsString> = HashSet::new();
            let mut suffixes: HashMap<JsString, usize> = HashMap::new();
            let mut copy = Map::with_capacity(keys.len());
            for (position, key) in keys.iter().enumerate() {
                let safe_key = safe_keys
                    .get(position)
                    .cloned()
                    .unwrap_or_else(|| key.clone());
                let mut target = safe_key.clone();
                if safe_key != *key {
                    let mut suffix = suffixes.get(&safe_key).copied().unwrap_or(1);
                    while used.contains(&target) || seen.contains(&target) {
                        // Keep lone surrogates exact: append `#n` by code units,
                        // as `` `${safeKey}#${suffix++}` `` does in TypeScript.
                        let mut suffixed = safe_key.clone();
                        suffixed.push_str("#");
                        suffixed.push_str(&suffix.to_string());
                        target = suffixed;
                        suffix += 1;
                    }
                    suffixes.insert(safe_key, suffix);
                }
                seen.insert(target.clone());
                let value = child_values.get(position).cloned().unwrap_or(Value::Null);
                copy.insert(target, value);
            }
            results[index] = Some(Value::Object(copy));
        }
    }
    results
        .into_iter()
        .next()
        .and_then(|value| value)
        .unwrap_or(Value::Null)
}

fn leaf_value(data: &Value, secrets: &[JsString], redaction: &JsString) -> Value {
    match data {
        Value::String(text) => Value::String(redact_js(text, secrets, redaction)),
        _ => data.clone(),
    }
}

/// `String.prototype.split(secret).join(redaction)` over UTF-16 code units,
/// so lone surrogates compare as units and never conflate.
fn redact_js(text: &JsString, secrets: &[JsString], redaction: &JsString) -> JsString {
    let mut current: Vec<u16> = text.units().collect();
    let replacement: Vec<u16> = redaction.units().collect();
    let mut changed = false;
    for secret in secrets {
        let needle: Vec<u16> = secret.units().collect();
        if needle.is_empty() {
            continue;
        }
        if find_subslice(&current, &needle).is_none() {
            continue;
        }
        current = replace_all(&current, &needle, &replacement);
        changed = true;
    }
    if !changed {
        return text.clone();
    }
    JsString::from_units(&current)
}

fn find_subslice(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn replace_all(haystack: &[u16], needle: &[u16], replacement: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(haystack.len());
    let mut index = 0;
    while index < haystack.len() {
        if index + needle.len() <= haystack.len()
            && haystack[index..index + needle.len()] == *needle
        {
            out.extend_from_slice(replacement);
            index += needle.len();
        } else {
            out.push(haystack[index]);
            index += 1;
        }
    }
    out
}

/// Whether a frame's JSON text holds a lease secret, so the tree behind it must be walked
/// (`frame-redaction.ts:127`-`:132`): a secret JSON would escape is always walked for,
/// because the text may spell it either way; so is a line that spells a character as an
/// escape `JSON.stringify` never writes (`\/` for `/`, any `\uXXXX`), since the raw text
/// then holds the secret without spelling it. Every other frame is one search.
pub fn text_holds_secret(text: &str, secrets: &[String]) -> bool {
    // A slash or a character the agent wrote escaped decodes to a plain character, so the
    // secret may be in the line while the line does not contain it.
    let spells_escapes = text.contains("\\/") || text.contains("\\u");
    secrets.iter().any(|secret| {
        if secret.is_empty() {
            return false;
        }
        let escaped = ace_json::ser::to_string(secret)
            .map(|quoted| {
                if quoted.len() >= 2 {
                    quoted[1..quoted.len() - 1].to_owned()
                } else {
                    String::new()
                }
            })
            .unwrap_or_default();
        spells_escapes || escaped != *secret || text.contains(secret)
    })
}

#[cfg(test)]
mod tests {
    use super::{LEASE_REDACTION, redact_lease, text_holds_secret};
    use ace_json::{Value, json};

    fn nested(depth: usize, leaf: Value) -> Value {
        let mut value = leaf;
        for level in 0..depth {
            value = json!({"level": level, "keep": "unrelated", "child": value});
        }
        value
    }

    #[test]
    fn deep_nesting_keeps_unrelated_values_and_loses_only_the_secret() {
        let secret = "lease-0123456789abcdef".to_owned();
        let frame = nested(
            200,
            json!({"token": format!("Bearer {secret}"), "name": "deep"}),
        );
        let redacted = redact_lease(&frame, &[secret]);
        let expected = nested(
            200,
            json!({"token": format!("Bearer {LEASE_REDACTION}"), "name": "deep"}),
        );
        assert_eq!(redacted, expected);
        let text = ace_json::ser::to_string(&redacted).unwrap_or_default();
        assert!(!text.contains("[depth limit]"));
    }

    #[test]
    fn secret_key_is_redacted_without_overwriting_an_existing_field() {
        let secret = "lease-0123456789abcdef".to_owned();
        let mut input_map = ace_json::Map::new();
        input_map.insert(secret.clone(), Value::from(1));
        input_map.insert(LEASE_REDACTION.to_owned(), Value::from(2));
        input_map.insert("other".to_owned(), json!([secret.clone(), "x"]));
        let frame = Value::Object(input_map);
        let redacted = redact_lease(&frame, &[secret]);
        let mut expected_map = ace_json::Map::new();
        expected_map.insert(LEASE_REDACTION.to_owned(), Value::from(2));
        expected_map.insert(format!("{LEASE_REDACTION}#1"), Value::from(1));
        expected_map.insert("other".to_owned(), json!([LEASE_REDACTION, "x"]));
        assert_eq!(redacted, Value::Object(expected_map));
    }

    #[test]
    fn a_frame_without_a_secret_is_never_walked() {
        let secret = "lease-0123456789abcdef".to_owned();
        let text = r#"{"method":"session/update","params":{"update":{"text":"hello"}}}"#;
        assert!(!text_holds_secret(text, &[secret]));
        assert!(!text_holds_secret(text, &[]));
        assert!(!text_holds_secret(text, &[String::new()]));
    }

    #[test]
    fn a_secret_the_line_spells_with_json_escapes_is_walked() {
        // The agent may write a slash as `\/` and any character as `\uXXXX`, neither of
        // which `JSON.stringify` writes: the raw line never spells the secret, and only a
        // walk can see it.
        let slash = "lease/0123456789abcdef".to_owned();
        let escaped_slash = r#"{"params":{"value":"lease\/0123456789abcdef"}}"#;
        assert!(text_holds_secret(
            escaped_slash,
            std::slice::from_ref(&slash)
        ));
        let letters = "lease-0123456789abcdef".to_owned();
        let escaped_letters = r#"{"params":{"value":"le\u0061se-0123456789abcdef"}}"#;
        assert!(text_holds_secret(
            escaped_letters,
            std::slice::from_ref(&letters)
        ));
        // A line with no escape that could hide a character is still one search.
        let plain = r#"{"params":{"value":"a line with a \n in it"}}"#;
        assert!(!text_holds_secret(plain, std::slice::from_ref(&letters)));
    }

    #[test]
    fn a_frame_holding_a_secret_even_one_json_escapes_is_walked() {
        let secret = "lease-0123456789abcdef".to_owned();
        for key in [secret, "lease\"with\\quote".to_owned()] {
            let value = format!("token {key}");
            let text =
                ace_json::ser::to_string(&json!({"params": {"value": value}})).unwrap_or_default();
            assert!(text_holds_secret(&text, std::slice::from_ref(&key)));
            // An escaped secret's text never spells it, and the walk is asked for anyway.
            let raw = format!(r#"{{"params":{{"value":"token {key}"}}}}"#);
            assert!(text_holds_secret(&raw, std::slice::from_ref(&key)));
        }
    }
}
