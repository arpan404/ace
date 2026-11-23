// SPDX-License-Identifier: Apache-2.0
//! Read a decoded provider value as a JSON object without copying it.
//! Translators read native fields through this on every frame, often many
//! times per frame, so it must not copy.
//!
//! Contract (from `packages/provider-kit/src/record.ts`, which stays for the
//! daemon code that still uses it): for plain JSON objects it reads the same
//! fields the TypeScript read. The TypeScript decides plainness by prototype;
//! every `serde_json` object is plain by construction, so this returns the
//! value's map itself, never a copy, and anything else reads as the shared
//! empty map. The empty map is immutable by type: there is no frozen-copy
//! step because nothing here can mutate through the borrow.

use serde_json::{Map, Value};
use std::sync::LazyLock;

/// A decoded provider value read as a JSON object, borrowed, never copied.
pub type NativeRecord<'a> = &'a Map<String, Value>;

/// The shared empty object non-objects read as.
static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

/// The value's map if it is a JSON object, otherwise the shared empty one.
pub fn native_record(value: &Value) -> NativeRecord<'_> {
    match value {
        Value::Object(map) => map,
        _ => &EMPTY,
    }
}

#[cfg(test)]
mod tests {
    use super::native_record;
    use serde_json::{Map, Value, json};
    use std::path::PathBuf;

    /// What the adapters' record readers returned before: the object's fields,
    /// or an empty object for anything else. This mirrors the zod record
    /// parse the TypeScript cases compare against, restricted to JSON values,
    /// where every object is plain by construction.
    fn expected(value: &Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        }
    }

    fn recorded_values() -> Vec<Value> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("..")
            .join("fixtures");
        let mut values = Vec::new();
        let mut dirs = vec![root];
        while let Some(dir) = dirs.pop() {
            let entries = std::fs::read_dir(&dir).expect("fixtures dir reads");
            for entry in entries {
                let path = entry.expect("fixture entry reads").path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|ext| ext == "jsonl") {
                    let text = std::fs::read_to_string(&path).expect("fixture reads");
                    for line in text.split('\n') {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let value: Value = serde_json::from_str(line).expect("fixture line parses");
                        collect(&value, &mut values);
                    }
                }
            }
        }
        values
    }

    fn collect(value: &Value, out: &mut Vec<Value>) {
        out.push(value.clone());
        match value {
            Value::Array(items) => {
                for item in items {
                    collect(item, out);
                }
            }
            Value::Object(map) => {
                for (_, item) in map {
                    collect(item, out);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn every_recorded_provider_value_reads_as_its_fields() {
        let values = recorded_values();
        assert!(values.len() > 10_000, "fixtures hold provider traffic");
        for value in &values {
            assert_eq!(native_record(value), &expected(value));
        }
    }

    #[test]
    fn arrays_and_primitives_read_as_empty() {
        for value in [
            json!([1]),
            json!("text"),
            json!(3),
            json!(null),
            json!(true),
        ] {
            assert_eq!(native_record(&value), &Map::new());
        }
    }

    #[test]
    fn a_plain_object_is_read_whole_and_as_itself_never_copied() {
        let value = json!({"shown": 1, "__proto__": {"x": 1}, "a": 2});
        let map = value.as_object().expect("object stays an object");
        assert!(std::ptr::eq(native_record(&value), map));
        // Nothing is dropped the way the old copy dropped symbol keys,
        // non-enumerable fields and own __proto__ fields.
        assert_eq!(native_record(&value).len(), 3);
        assert!(native_record(&value).contains_key("__proto__"));
    }

    #[test]
    fn the_shared_empty_object_never_gains_fields() {
        let before = native_record(&json!(1)).len();
        assert_eq!(before, 0);
        assert_eq!(native_record(&json!([1, 2])).len(), 0);
    }
}
