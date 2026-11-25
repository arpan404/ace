// SPDX-License-Identifier: Apache-2.0
//! The thread settings an engine selection may carry (`selection.ts`): only the
//! documented Codex settings, never arbitrary provider config or credentials.

use ace_json::{JsString, Map, Value};

/// A validated selection's options.
///
/// Each field keeps zod's three states: absent (`None`), `null` (a deliberate
/// clear, `Some(None)`) and a chosen value. A cleared setting is still sent, so
/// `null` can never be read as "leave the previous one".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub effort: Option<Option<String>>,
    pub summary: Option<Option<String>>,
    pub service_tier: Option<Option<String>>,
}

/// The summaries Codex names.
const SUMMARIES: [&str; 4] = ["auto", "concise", "detailed", "none"];
/// `z.string().max(64)`, in UTF-16 units, as zod counts.
const TEXT_MAX: usize = 64;

/// `CodexSelectionOptions.parse(value)`: a strict object of the three settings.
pub fn parse_selection(value: &Value) -> Result<Selection, String> {
    let Some(options) = value.as_object() else {
        return Err("Codex selection options must be an object".to_owned());
    };
    for key in options.keys() {
        if !matches!(key.as_str(), "effort" | "summary" | "serviceTier") {
            return Err(format!(
                "Unrecognized key \"{key}\" in Codex selection options"
            ));
        }
    }
    let summary = match option(options.get("summary"))? {
        None => None,
        Some(None) => Some(None),
        Some(Some(text)) => {
            if !SUMMARIES.contains(&text.as_str()) {
                return Err(format!(
                    "Codex selection summary must be one of {}, not \"{text}\"",
                    SUMMARIES.join(", ")
                ));
            }
            Some(Some(text))
        }
    };
    Ok(Selection {
        effort: option(options.get("effort"))?,
        summary,
        service_tier: option(options.get("serviceTier"))?,
    })
}

/// One setting: absent, `null`, or a string of at most 64 UTF-16 units.
fn option(value: Option<&Value>) -> Result<Option<Option<String>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        Value::Null => Ok(Some(None)),
        Value::String(text) => {
            if text.len_utf16() > TEXT_MAX {
                return Err(format!(
                    "Codex selection value must be at most {TEXT_MAX} characters"
                ));
            }
            Ok(Some(Some(text.as_str().to_owned())))
        }
        _ => Err("Codex selection value must be a string or null".to_owned()),
    }
}

/// The object form of a selection, in the shape the generated params take.
pub fn selection_options(selection: &Selection) -> Map {
    let mut options = Map::new();
    for (key, value) in [
        ("effort", &selection.effort),
        ("summary", &selection.summary),
        ("serviceTier", &selection.service_tier),
    ] {
        let Some(value) = value else {
            continue;
        };
        let value = match value {
            Some(text) => Value::String(JsString::from(text.as_str())),
            None => Value::Null,
        };
        options.insert(key, value);
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        ace_json::parse(text).expect("fixture parses")
    }

    #[test]
    fn the_documented_settings_keep_absent_null_and_chosen_apart() {
        let selection =
            parse_selection(&json(r#"{"effort":"high","summary":null}"#)).expect("valid");
        assert_eq!(selection.effort, Some(Some("high".to_owned())));
        assert_eq!(selection.summary, Some(None));
        assert_eq!(selection.service_tier, None);
        assert_eq!(
            selection_options(&selection),
            json(r#"{"effort":"high","summary":null}"#)
                .as_object()
                .cloned()
                .expect("an object")
        );
    }

    #[test]
    fn arbitrary_provider_config_is_refused() {
        assert_eq!(
            parse_selection(&json(r#"{"effort":"high","apiKey":"sk"}"#)),
            Err("Unrecognized key \"apiKey\" in Codex selection options".to_owned())
        );
    }

    #[test]
    fn a_setting_outside_its_bound_or_enum_is_refused() {
        let long = format!(r#"{{"effort":"{}"}}"#, "e".repeat(65));
        assert_eq!(
            parse_selection(&json(&long)),
            Err("Codex selection value must be at most 64 characters".to_owned())
        );
        assert_eq!(
            parse_selection(&json(r#"{"summary":"brief"}"#)),
            Err(
                "Codex selection summary must be one of auto, concise, detailed, none, not \"brief\""
                    .to_owned()
            )
        );
    }
}
