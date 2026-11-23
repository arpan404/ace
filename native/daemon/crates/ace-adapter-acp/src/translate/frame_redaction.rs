// SPDX-License-Identifier: Apache-2.0
//! Lease redaction (`frame-redaction.ts`): exact ephemeral secrets are
//! replaced, everything else keeps its value. The walk is iterative so any
//! depth keeps its unrelated values.

use serde_json::Value;

/// What a lease secret reads as once redacted.
pub const LEASE_REDACTION: &str = "[ace lease redacted]";

/// Redact exact ephemeral lease material, keeping unchanged values.
pub fn redact_lease(data: &Value, secrets: &[String]) -> Value {
    let active: Vec<&str> = secrets
        .iter()
        .map(String::as_str)
        .filter(|secret| !secret.is_empty())
        .collect();
    if active.is_empty() {
        return data.clone();
    }
    redact_value(data, &active)
}

fn redact_text(text: &str, secrets: &[&str]) -> String {
    let mut result = text.to_owned();
    for secret in secrets {
        if result.contains(*secret) {
            result = result
                .split(secret)
                .collect::<Vec<_>>()
                .join(LEASE_REDACTION);
        }
    }
    result
}

fn redact_key(key: &str, secrets: &[&str]) -> String {
    redact_text(key, secrets)
}

/// Iterative walk: containers are opened on a stack, leaves redacted in place.
fn redact_value(data: &Value, secrets: &[&str]) -> Value {
    match data {
        Value::String(text) => Value::String(redact_text(text, secrets)),
        Value::Array(items) => {
            let mut changed: Option<Vec<Value>> = None;
            for (index, item) in items.iter().enumerate() {
                let next = redact_value(item, secrets);
                if next != *item {
                    if changed.is_none() {
                        changed = Some(items.clone());
                    }
                    if let Some(out) = changed.as_mut() {
                        out[index] = next;
                    }
                }
            }
            changed.map_or_else(|| data.clone(), Value::Array)
        }
        Value::Object(map) => {
            let mut key_changed = false;
            let mut redacted_keys: Vec<String> = Vec::with_capacity(map.len());
            for key in map.keys() {
                let safe = redact_key(key, secrets);
                if safe != *key {
                    key_changed = true;
                }
                redacted_keys.push(safe);
            }
            let mut value_changed: Option<Vec<(String, Value)>> = None;
            for (index, (key, value)) in map.iter().enumerate() {
                let next = redact_value(value, secrets);
                if next != *value && value_changed.is_none() {
                    value_changed = Some(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
                }
                if let Some(out) = value_changed.as_mut()
                    && let Some(entry) = out.get_mut(index)
                {
                    entry.1 = next;
                }
                let _ = key;
            }
            if !key_changed && value_changed.is_none() {
                return data.clone();
            }
            // Reserve original keys so redacted keys cannot overwrite a field.
            let used: std::collections::HashSet<String> = map.keys().cloned().collect();
            let mut suffixes: std::collections::HashMap<String, usize> =
                std::collections::HashMap::new();
            let mut copy = serde_json::Map::with_capacity(map.len());
            let keys: Vec<String> = map.keys().cloned().collect();
            for (position, key) in keys.iter().enumerate() {
                let safe_key = redacted_keys
                    .get(position)
                    .cloned()
                    .unwrap_or_else(|| key.clone());
                let mut target = safe_key.clone();
                if safe_key != *key {
                    let mut suffix = suffixes.get(&safe_key).copied().unwrap_or(1);
                    while used.contains(&target) || copy.contains_key(&target) {
                        target = format!("{safe_key}#{suffix}");
                        suffix += 1;
                    }
                    suffixes.insert(safe_key, suffix);
                }
                let value = if let Some(changed) = value_changed.as_ref() {
                    changed
                        .get(position)
                        .map(|(_, v)| v.clone())
                        .unwrap_or(Value::Null)
                } else {
                    map.get(key).cloned().unwrap_or(Value::Null)
                };
                copy.insert(target, value);
            }
            Value::Object(copy)
        }
        _ => data.clone(),
    }
}

/// A frame's JSON with lease secrets redacted.
pub fn redacted_frame_json(data: &Value, secrets: &[String]) -> (String, Value) {
    let json = serde_json::to_string(data).unwrap_or_else(|_| "null".to_owned());
    let mut clean = true;
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        let escaped = serde_json::to_string(secret)
            .map(|quoted| {
                if quoted.len() >= 2 {
                    quoted[1..quoted.len() - 1].to_owned()
                } else {
                    String::new()
                }
            })
            .unwrap_or_default();
        if escaped != *secret || json.contains(secret) {
            clean = false;
            break;
        }
    }
    if clean {
        return (json, data.clone());
    }
    let value = redact_lease(data, secrets);
    let text = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned());
    (text, value)
}

#[cfg(test)]
mod tests {
    use super::{LEASE_REDACTION, redact_lease, redacted_frame_json};
    use serde_json::{Value, json};

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
        let text = serde_json::to_string(&redacted).unwrap_or_default();
        assert!(!text.contains("[depth limit]"));
    }

    #[test]
    fn secret_key_is_redacted_without_overwriting_an_existing_field() {
        let secret = "lease-0123456789abcdef".to_owned();
        let mut input_map = serde_json::Map::new();
        input_map.insert(secret.clone(), Value::from(1));
        input_map.insert(LEASE_REDACTION.to_owned(), Value::from(2));
        input_map.insert("other".to_owned(), json!([secret.clone(), "x"]));
        let frame = Value::Object(input_map);
        let redacted = redact_lease(&frame, &[secret]);
        let mut expected_map = serde_json::Map::new();
        expected_map.insert(LEASE_REDACTION.to_owned(), Value::from(2));
        expected_map.insert(format!("{LEASE_REDACTION}#1"), Value::from(1));
        expected_map.insert("other".to_owned(), json!([LEASE_REDACTION, "x"]));
        assert_eq!(redacted, Value::Object(expected_map));
    }

    #[test]
    fn frame_without_secret_is_published_as_serialized_uncopied() {
        let secret = "lease-0123456789abcdef".to_owned();
        let frame = json!({"method": "session/update", "params": {"update": {"text": "hello"}}});
        let published = redacted_frame_json(&frame, &[secret]);
        assert_eq!(
            published.0,
            serde_json::to_string(&frame).unwrap_or_default()
        );
        assert_eq!(published.1, frame);
    }

    #[test]
    fn frame_holding_a_secret_even_one_json_escapes_is_published_redacted() {
        let secret = "lease-0123456789abcdef".to_owned();
        for key in [secret, "lease\"with\\quote".to_owned()] {
            let value = format!("token {key}");
            let published = redacted_frame_json(&json!({"params": {"value": value}}), &[key]);
            let parsed: Value = serde_json::from_str(&published.0).unwrap_or(Value::Null);
            assert_eq!(
                parsed,
                json!({"params": {"value": format!("token {LEASE_REDACTION}")}})
            );
        }
    }
}
