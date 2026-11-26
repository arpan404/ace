// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! `TransitionMetadata`'s schema (`transition-state.ts:20`-`:47`, `admitTransitionMetadata`):
//! the durable handoff, fork, selection and merge context a transition carries, in the schema's
//! key order and with unknown keys dropped. A handoff or fallback envelope is kept as written:
//! its own schema is `PortableHandoff`, which E5.9 owns with the transitions that build one.

use ace_json::Value;

use crate::EngineError;

/// `maxMessageBytes`, which sizes the merge context (`model/message-limits.ts:8`).
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// The most merge summaries one context carries (`transition-state.ts:34`).
const MAX_CONTEXT: usize = 8;
/// The metadata's whole JSON, in bytes (`transition-state.ts:40`).
const MAX_METADATA_BYTES: usize = 4 * MAX_MESSAGE_BYTES;

/// `TransitionMetadata` with the schema's keys in its order (`transition-state.ts:20`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TransitionMetadata {
    pub selection: Option<Value>,
    pub fork: Option<Value>,
    pub handoff: Option<Value>,
    pub marker: Option<String>,
    pub fallback: Option<Value>,
    pub context: Vec<String>,
}

pub(super) fn invalid(what: &str) -> EngineError {
    EngineError::Records(format!("Invalid transition metadata: {what}"))
}

/// `Metadata.parse`: the known fields in schema order, unknown keys dropped, `context` defaulted.
pub(crate) fn parse_metadata(input: &Value) -> Result<TransitionMetadata, EngineError> {
    let Some(object) = input.as_object() else {
        return Err(invalid("expected an object"));
    };
    let selection = match object.get("selection") {
        None => None,
        Some(value) => Some(parse_selection(value)?),
    };
    let fork = match object.get("fork") {
        None => None,
        Some(value) => Some(parse_fork(value)?),
    };
    let handoff = match object.get("handoff") {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| invalid("handoff is not an object"))?
                .clone()
                .into(),
        ),
    };
    let marker = match object.get("marker") {
        None => None,
        Some(value) => {
            let text = value
                .as_str()
                .ok_or_else(|| invalid("marker is not a string"))?;
            // A zod string bound counts code points (rule 17).
            let points = text.chars().count();
            if points == 0 || points > 512 {
                return Err(invalid("marker is out of bounds"));
            }
            Some(text.to_owned())
        }
    };
    let fallback = match object.get("fallback") {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| invalid("fallback is not an object"))?
                .clone()
                .into(),
        ),
    };
    let context = match object.get("context") {
        None => Vec::new(),
        Some(value) => {
            let items = value
                .as_array()
                .ok_or_else(|| invalid("context is not an array"))?;
            if items.len() > MAX_CONTEXT {
                return Err(invalid("context holds too many entries"));
            }
            let mut texts = Vec::with_capacity(items.len());
            for item in items {
                let entry = item
                    .as_str()
                    .ok_or_else(|| invalid("context entry is not a string"))?;
                if entry.chars().count() > 2 * MAX_MESSAGE_BYTES {
                    return Err(invalid("context entry is too long"));
                }
                texts.push(entry.to_owned());
            }
            texts
        }
    };
    Ok(TransitionMetadata {
        selection,
        fork,
        handoff,
        marker,
        fallback,
        context,
    })
}

/// `ExecutionSelection.parse`: the schema's keys, its provider and its default options.
pub(crate) fn parse_selection(value: &Value) -> Result<Value, EngineError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("selection is not an object"));
    };
    let provider = object
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("selection has no provider"))?;
    if !providers().contains(&provider) {
        return Err(invalid("selection names an unknown provider"));
    }
    let mut selection = ace_json::Map::new();
    for key in ["provider", "model", "instanceId"] {
        if let Some(field) = object.get(key) {
            let text = field
                .as_str()
                .ok_or_else(|| invalid("selection field is not a string"))?;
            // `model` and `instanceId` are `z.string().min(1).max(256)`: code points (rule 17).
            let points = text.chars().count();
            if key != "provider" && (points == 0 || points > 256) {
                return Err(invalid("selection field is out of bounds"));
            }
            selection.insert(key.to_owned(), Value::from(text));
        }
    }
    let options = match object.get("options") {
        None => Value::Object(ace_json::Map::new()),
        Some(value) => parse_options(value)?,
    };
    selection.insert("options", options);
    Ok(Value::Object(selection))
}

/// `ExecutionOptions.parse`: at most 32 provider options, each name at most 128 characters and
/// each value a string of at most 1024, a finite number, a boolean or null.
pub(crate) fn parse_options(value: &Value) -> Result<Value, EngineError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("options is not an object"))?;
    if object.len() > 32 {
        return Err(invalid("options holds too many entries"));
    }
    let mut options = ace_json::Map::new();
    for (name, value) in object {
        if name.chars().count() > 128 {
            return Err(invalid("option name is out of bounds"));
        }
        let kept = match value {
            Value::Null | Value::Bool(_) => value.clone(),
            Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => value.clone(),
            Value::String(text) if text.chars().count() <= 1024 => value.clone(),
            _ => return Err(invalid("option value is out of bounds")),
        };
        options.insert(name.clone(), kept);
    }
    Ok(Value::Object(options))
}

/// `NativeFork.parse`: the native session, its point and whether it is an inherited fork, in
/// the schema's key order with unknown keys dropped.
pub(crate) fn parse_fork(value: &Value) -> Result<Value, EngineError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("fork is not an object"));
    };
    let native_session = object
        .get("nativeSessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("fork has no native session"))?;
    let point = object
        .get("point")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("fork has no point"))?;
    let kind = point
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(kind, "turn" | "item" | "end") {
        return Err(invalid("fork point is unknown"));
    }
    let native_id = point
        .get("nativeId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("fork point has no native id"))?;
    let points = native_id.chars().count();
    if points == 0 || points > 256 {
        return Err(invalid("fork point id is out of bounds"));
    }
    let mut fork = ace_json::Map::new();
    fork.insert("nativeSessionId", Value::from(native_session));
    let mut point_out = ace_json::Map::new();
    point_out.insert("type", Value::from(kind));
    point_out.insert("nativeId", Value::from(native_id));
    fork.insert("point", Value::Object(point_out));
    if let Some(inherited) = object.get("inherited") {
        if inherited.as_bool() != Some(true) {
            return Err(invalid("inherited is not true"));
        }
        fork.insert("inherited", Value::Bool(true));
    }
    Ok(Value::Object(fork))
}

/// `admitTransitionMetadata`: the metadata, refused when its JSON passes the budget.
pub fn admit_metadata(input: &Value) -> Result<TransitionMetadata, EngineError> {
    let metadata = parse_metadata(input)?;
    let bytes = ace_json::to_string(&Value::Object(metadata_json(&metadata))).len();
    if bytes > MAX_METADATA_BYTES {
        return Err(EngineError::Records(
            "Transition context capacity exceeded".to_owned(),
        ));
    }
    Ok(metadata)
}

pub(crate) fn metadata_json(metadata: &TransitionMetadata) -> ace_json::Map {
    let mut value = ace_json::Map::new();
    if let Some(selection) = &metadata.selection {
        value.insert("selection", selection.clone());
    }
    if let Some(fork) = &metadata.fork {
        value.insert("fork", fork.clone());
    }
    if let Some(handoff) = &metadata.handoff {
        value.insert("handoff", handoff.clone());
    }
    if let Some(marker) = &metadata.marker {
        value.insert("marker", Value::from(marker.as_str()));
    }
    if let Some(fallback) = &metadata.fallback {
        value.insert("fallback", fallback.clone());
    }
    value.insert(
        "context",
        Value::Array(
            metadata
                .context
                .iter()
                .map(|entry| Value::from(entry.as_str()))
                .collect(),
        ),
    );
    value
}

/// The providers an `ExecutionSelection` names (`ProviderKind`).
pub(crate) fn providers() -> [&'static str; 7] {
    [
        "claude",
        "codex",
        "opencode",
        "cursor",
        "pi",
        "acp",
        "antigravity",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn a_stored_selection_is_bounded_as_the_schemas_bound_it() {
        let long_model = format!(
            r#"{{"provider":"codex","model":"{}","options":{{}}}}"#,
            "m".repeat(257)
        );
        assert!(admit_metadata(&value(&format!(r#"{{"selection":{long_model}}}"#))).is_err());
        let empty = value(r#"{"selection":{"provider":"codex","model":"","options":{}}}"#);
        assert!(admit_metadata(&empty).is_err());
        let many = format!(
            r#"{{"selection":{{"provider":"codex","options":{{{}}}}}}}"#,
            (0..33)
                .map(|index| format!(r#""o{index}":true"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(admit_metadata(&value(&many)).is_err());
        let nested = value(r#"{"selection":{"provider":"codex","options":{"x":{"y":1}}}}"#);
        assert!(admit_metadata(&nested).is_err());
        let long_name = format!(
            r#"{{"selection":{{"provider":"codex","options":{{"{}":1}}}}}}"#,
            "k".repeat(129)
        );
        assert!(admit_metadata(&value(&long_name)).is_err());
        // A zod bound counts code points: 256 emoji fit where 512 UTF-16 units would not.
        let emoji = "\u{1f600}".repeat(256);
        let fits = value(&format!(
            r#"{{"selection":{{"provider":"codex","model":"{emoji}","options":{{}}}}}}"#
        ));
        assert!(admit_metadata(&fits).is_ok());
        let too = format!("{emoji}\u{1f600}");
        let too_long = value(&format!(
            r#"{{"selection":{{"provider":"codex","model":"{too}","options":{{}}}}}}"#
        ));
        assert!(admit_metadata(&too_long).is_err());
        let marker = "\u{1f600}".repeat(512);
        assert!(admit_metadata(&value(&format!(r#"{{"marker":"{marker}"}}"#))).is_ok());
        let too_marker = format!("{marker}\u{1f600}");
        assert!(admit_metadata(&value(&format!(r#"{{"marker":"{too_marker}"}}"#))).is_err());
        // A valid selection keeps the schema order and fills the default options.
        let kept = admit_metadata(&value(
            r#"{"selection":{"instanceId":"i","provider":"codex","model":"m"}}"#,
        ))
        .expect("a valid selection");
        let selection = kept.selection.expect("selection");
        assert_eq!(
            ace_json::to_string(&selection),
            r#"{"provider":"codex","model":"m","instanceId":"i","options":{}}"#
        );
    }
}
