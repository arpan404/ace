//! Typed output: a JSON Schema from the Rust type goes out, and the reply is parsed back into
//! that type. A reply that does not parse is an error, never repaired.

use genai::chat::JsonSpec;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;

use crate::error::ModelError;

/// The response format asking for `T`.
pub(crate) fn spec<T: JsonSchema>() -> Result<JsonSpec, ModelError> {
    let schema =
        serde_json::to_value(schemars::schema_for!(T)).map_err(|error| ModelError::Shape {
            model: String::new(),
            type_name: std::any::type_name::<T>(),
            reason: format!("schema could not be built: {error}"),
        })?;
    Ok(JsonSpec::new(spec_name::<T>(), schema))
}

/// Providers accept only `[A-Za-z0-9_-]` in a format name.
fn spec_name<T: JsonSchema>() -> String {
    let name: String = T::schema_name()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.is_empty() {
        "output".to_owned()
    } else {
        name
    }
}

pub(crate) fn parse<T: DeserializeOwned>(model: &str, text: &str) -> Result<T, ModelError> {
    serde_json::from_str(text.trim()).map_err(|error| ModelError::Shape {
        model: model.to_owned(),
        type_name: std::any::type_name::<T>(),
        reason: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, JsonSchema, PartialEq)]
    struct Verdict {
        relevant: bool,
        score: u8,
    }

    #[test]
    fn a_matching_reply_becomes_the_type() {
        let verdict = parse::<Verdict>("glm-5.3", " {\"relevant\": true, \"score\": 7}\n");
        assert_eq!(
            verdict,
            Ok(Verdict {
                relevant: true,
                score: 7
            })
        );
    }

    #[test]
    fn a_reply_missing_a_field_is_an_error() {
        let verdict = parse::<Verdict>("glm-5.3", r#"{"relevant": true}"#);
        assert!(
            matches!(verdict, Err(ModelError::Shape { reason, .. }) if reason.contains("score"))
        );
    }

    #[test]
    fn prose_around_the_json_is_not_accepted() {
        let verdict = parse::<Verdict>("glm-5.3", "Sure! {\"relevant\": true, \"score\": 7}");
        assert!(matches!(verdict, Err(ModelError::Shape { .. })));
    }

    #[test]
    fn the_schema_lists_the_type_fields_as_required() -> Result<(), ModelError> {
        let spec = spec::<Verdict>()?;
        assert_eq!(spec.name, "Verdict");
        let required = spec.schema.get("required").cloned();
        assert_eq!(required, Some(serde_json::json!(["relevant", "score"])));
        Ok(())
    }
}
