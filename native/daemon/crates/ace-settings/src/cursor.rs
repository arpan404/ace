// SPDX-License-Identifier: Apache-2.0
//! `cursor-configuration.ts`: the Cursor SDK instance id that replaced the retired CLI
//! default, and the row rewrite that only touches Cursor rows.

use serde_json::{Map, Value};

/// The Cursor SDK instance id older selections called the CLI default.
pub const CURSOR_DEFAULT_INSTANCE_ID: &str = "cursor-sdk-default";

/// SDK-specific Cursor preferences win a collision with a retired CLI default. Only Cursor
/// rows are rewritten: another provider's executable path stays exactly as stored.
pub fn cursor_configuration(rows: &Value) -> Value {
    let Some(rows) = rows.as_array() else {
        return rows.clone();
    };
    let mut next: Vec<Value> = Vec::with_capacity(rows.len());
    for value in rows {
        let Some(row) = value.as_object() else {
            next.push(value.clone());
            continue;
        };
        if row.get("provider").and_then(Value::as_str) != Some("cursor") {
            next.push(value.clone());
            continue;
        }
        let instance = row.get("instance").and_then(Value::as_str);
        let migrated = instance == Some("cursor-cli-default");
        let target = match instance {
            Some("cursor-cli-default") => Some(CURSOR_DEFAULT_INSTANCE_ID.to_owned()),
            other => other.map(str::to_owned),
        };
        if migrated
            && target.as_ref().is_some_and(|target| {
                rows.iter().any(|other| {
                    let other = other.as_object();
                    other
                        .and_then(|other| other.get("provider"))
                        .and_then(Value::as_str)
                        == Some("cursor")
                        && other
                            .and_then(|other| other.get("instance"))
                            .and_then(Value::as_str)
                            == Some(target.as_str())
                })
            })
        {
            continue;
        }
        let mut kept = Map::new();
        for (name, field) in row {
            if name == "binaryPath" {
                continue;
            }
            kept.insert(name.clone(), field.clone());
        }
        match target {
            Some(target) => {
                kept.insert("instance".to_owned(), Value::String(target));
            }
            None => {
                kept.remove("instance");
            }
        }
        next.push(Value::Object(kept));
    }
    Value::Array(next)
}

/// `validateValue`'s extra step: an assignment or override of the provider rows is written
/// already migrated, so the file never holds the retired CLI default.
pub fn normalize_assignment(key: &str, value: Value) -> Value {
    if key == "providers.configuration" {
        cursor_configuration(&value)
    } else {
        value
    }
}

/// Whether two values serialize to the same JSON text, as the TypeScript's
/// `JSON.stringify` comparison does (property order counts).
pub fn same_json(left: &Value, right: &Value) -> bool {
    match (serde_json::to_string(left), serde_json::to_string(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}
