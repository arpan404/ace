//! The `distribution` part's regions: the signed version manifest's label from
//! `spade_core::package::signed`, and the scenario file's fields from the types
//! `spade_core::package::scenario` reads it into, with their own words.

use serde_json::Value;

use super::markdown::{cell, table};
use crate::package::{scenario, signed};

pub fn regions() -> Vec<(&'static str, String)> {
    vec![
        (
            "label",
            format!(
                "The signature is Ed25519 over the label `{}`, a newline, and the body's \
                 canonical JSON (keys sorted at every depth, no spaces).\n",
                signed::MANIFEST_LABEL
            ),
        ),
        ("scenario", scenario_fields()),
        (
            "scenario-bounds",
            format!(
                "A scenario scripts at most {} model steps.\n",
                scenario::MOST_STEPS
            ),
        ),
    ]
}

/// Each object of a scenario file and its fields, from the reader's own types.
fn scenario_fields() -> String {
    let schema = schemars::schema_for!(scenario::Scenario);
    let schema = schema.as_value();
    let mut out = String::new();
    out.push_str(&object("The file", schema, schema));
    let defs = schema["$defs"].as_object().cloned().unwrap_or_default();
    for (name, def) in &defs {
        out.push('\n');
        if def.get("properties").is_some() {
            out.push_str(&object(&format!("`{}`", lower(name)), def, schema));
        } else {
            out.push_str(&format!("`{}` is {}.\n", lower(name), kind(def, schema)));
        }
    }
    out
}

fn lower(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn object(title: &str, def: &Value, root: &Value) -> String {
    let required: Vec<&str> = def["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let rows = def["properties"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(field, about)| {
            let words = about["description"].as_str().unwrap_or_default();
            vec![
                format!("`{field}`"),
                kind(about, root),
                if required.contains(&field.as_str()) {
                    "MUST".to_owned()
                } else {
                    "MAY".to_owned()
                },
                cell(&words.replace('\n', " ")),
            ]
        });
    format!(
        "{title}, which holds no field but these:\n\n{}",
        table(&["Field", "Holds", "Present", "What it is"], rows)
    )
}

/// What a field holds, in a few words.
fn kind(about: &Value, root: &Value) -> String {
    if let Some(reference) = about["$ref"].as_str() {
        let name = reference.rsplit('/').next().unwrap_or_default();
        return format!("`{}`", lower(name));
    }
    if let Some(all) = about["allOf"].as_array().and_then(|all| all.first()) {
        return kind(all, root);
    }
    if let Some(any) = about["anyOf"].as_array() {
        let kinds: Vec<String> = any
            .iter()
            .filter(|one| one["type"] != "null")
            .map(|one| match kind(one, root).as_str() {
                "string" => "a string".to_owned(),
                other => other.to_owned(),
            })
            .collect();
        return kinds.join(" or ");
    }
    match &about["type"] {
        Value::String(kind) if kind == "array" => {
            format!("a list of {}", kind_of(&about["items"], root))
        }
        Value::String(kind) if kind == "object" && about.get("additionalProperties").is_some() => {
            format!(
                "an object of {}",
                kind_of(&about["additionalProperties"], root)
            )
        }
        Value::String(kind) => kind.clone(),
        Value::Array(kinds) => kinds
            .iter()
            .filter_map(Value::as_str)
            .filter(|kind| *kind != "null")
            .collect::<Vec<_>>()
            .join(" or "),
        _ => "any JSON".to_owned(),
    }
}

fn kind_of(value: &Value, root: &Value) -> String {
    let kind = kind(value, root);
    match kind.as_str() {
        "string" => "strings".to_owned(),
        _ => kind,
    }
}
