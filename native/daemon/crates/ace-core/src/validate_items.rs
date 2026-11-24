// SPDX-License-Identifier: Apache-2.0
//! The item preflight of `validate.ts` (`itemError`): identity fields belong
//! to core, owners must match, tool references use native keys, legacy
//! output must extend the stream, and the merged candidate must form a
//! canonical item with no unknown fields.
//!
//! One module per validation stage:
//!
//! - [`preflight`] checks the incoming draft against the thread state.
//! - [`base`] checks the fields every item carries.
//! - [`kinds`] dispatches on the item kind and holds the shared raw and
//!   visualization fields.
//! - [`content`] checks message content, [`tools`] tool calls, [`messages`]
//!   message items, [`delegation`] delegation items and [`notices`] notices.
//! - [`people`] and [`asked`] check the people a notice or message names.
//! - [`keys`] holds the screen-key table.

mod asked;
mod base;
mod content;
mod delegation;
mod keys;
mod kinds;
mod messages;
mod notices;
mod people;
mod preflight;
mod tools;

use crate::json_io::{Json, Map};

pub use keys::SCREEN_KEYS;
pub(crate) use keys::screen_key_valid;
pub use preflight::item_error;

pub(crate) use content::valid_attachment;

/// Whether the merged candidate validates.
pub enum ItemCheck {
    /// The candidate forms a canonical item.
    Ok,
    /// A field has the wrong shape.
    Invalid,
    /// Unknown fields would be stripped.
    UnknownFields,
}

fn as_map(value: &Json) -> Option<&Map> {
    match value {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn get_str<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|value| value.as_str())
}

fn is_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(_)))
}

fn optional_string(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::String(_)))
}

/// Whether the merged candidate validates: a strict pass first (like
/// `safeParse`), then a stripped re-validation to tell unknown fields apart
/// from misshapen ones (like `preservesFields`).
pub fn validate_merged_item(candidate: &Map) -> ItemCheck {
    if base::valid_base(candidate) && kinds::valid_item_shape(candidate) {
        return ItemCheck::Ok;
    }
    let (stripped, removed) = crate::validate_unknown::strip_item_unknowns(candidate);
    if removed && base::valid_base(&stripped) && kinds::valid_item_shape(&stripped) {
        ItemCheck::UnknownFields
    } else {
        ItemCheck::Invalid
    }
}

#[cfg(test)]
mod tests {
    use super::{ItemCheck, validate_merged_item};
    use crate::json_io::Json;

    /// A canonical tool_call item; `gaps` supplies the measurement's hitch keys.
    fn measured_item(gaps: &str) -> Json {
        let text = format!(
            r#"{{
  "id": "item_1",
  "agentId": "agent_1",
  "createdAt": 100,
  "type": "tool_call",
  "call": {{
    "id": "item_1",
    "agentId": "agent_1",
    "kind": "shell",
    "title": "shell",
    "status": "pending",
    "startedAt": 100,
    "raw": [],
    "detail": {{ "kind": "shell", "command": "ls" }}
  }},
  "measurement": {{
    "source": "browser-trace",
    "target": {{ "kind": "window", "bundleId": "com.apple.Safari", "windowId": 41 }},
    "refreshHz": 120,
    "windowMs": 2000,
    "frames": 80,
    {gaps},
    "verdict": "smooth",
    "confidence": "high",
    "notes": []
  }}
}}"#
        );
        match crate::json_io::parse_untrusted(&text) {
            Ok(item) => item,
            Err(error) => panic!("the candidate is JSON: {error}"),
        }
    }

    fn check(item: &Json) -> ItemCheck {
        match item {
            Json::Object(map) => validate_merged_item(map),
            _ => panic!("the candidate is an object"),
        }
    }

    #[test]
    fn a_measurement_gap_keeps_extra_fields_visible_as_unknown_item_fields() {
        for (field, gaps) in [
            (
                "hitches",
                r#""hitches": [{"atMs":10,"durationMs":20,"gapField":"kept"}]"#,
            ),
            (
                "longTasks",
                r#""hitches": [], "longTasks": [{"atMs":10,"durationMs":20,"gapField":"kept"}]"#,
            ),
        ] {
            let item = measured_item(gaps);
            assert!(
                matches!(check(&item), ItemCheck::UnknownFields),
                "{field} gap extras must be unknown fields, never a misshapen item"
            );
        }
    }
}
