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
    use crate::json_io::{Json, Map};

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

    #[test]
    fn handoff_models_and_origin_titles_use_the_protocols_code_point_bounds() {
        for (field, limit) in [("model", 256), ("title", 256)] {
            for length in [limit, limit + 1] {
                let text = "😀".repeat(length);
                let (model, title) = if field == "model" {
                    (text.as_str(), "title")
                } else {
                    ("model", text.as_str())
                };
                let item = ace_json::parse(&format!(r#"{{"type":"message","id":"i","agentId":"a","createdAt":0,"complete":true,"role":"user","parts":[{{"type":"text","text":"hi"}}],"origin":{{"kind":"handoff","sources":[{{"provider":"codex","model":"{model}"}}],"via":{{"threadId":"thread","title":"{title}"}}}}}}"#)).expect("item");
                assert_eq!(
                    matches!(
                        validate_merged_item(item.as_object().expect("object")),
                        ItemCheck::Ok
                    ),
                    length == limit,
                    "{field}"
                );
            }
        }
    }

    fn ok(item: &Json) -> bool {
        match item {
            Json::Object(map) => matches!(validate_merged_item(map), ItemCheck::Ok),
            _ => panic!("the candidate is an object"),
        }
    }

    #[test]
    fn asked_note_detail_and_device_names_count_code_points() {
        for length in [512, 513] {
            let text = "😀".repeat(length);
            let item = ace_json::json!({
                "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"notice",
                "level":"info","text":"t",
                "asked":{
                    "about":"a",
                    "to":[{"to":{"kind":"agent","threadId":"t","title":"t"},"state":"sent","detail":text}],
                    "devices":[],"share":"thread","shares":[]
                }
            });
            assert_eq!(ok(&item), length == 512, "detail");
        }
        for (field, limit) in [("id", 256), ("name", 256), ("os", 64), ("model", 256)] {
            for length in [limit, limit + 1] {
                let text = "😀".repeat(length);
                let mut device = ace_json::json!({
                    "type":"device","id":"d","name":"n","kind":"laptop",
                    "machine":{"id":"m","name":"m","here":true},"online":true
                });
                device
                    .as_object_mut()
                    .expect("device")
                    .insert(field, Json::from(text));
                let item = ace_json::json!({
                    "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"notice",
                    "level":"info","text":"t",
                    "asked":{
                        "about":"a",
                        "to":[{"to":{"kind":"agent","threadId":"t","title":"t"},"state":"sent"}],
                        "devices":[device],"share":"thread","shares":[]
                    }
                });
                assert_eq!(ok(&item), length == limit, "{field}");
            }
        }
    }

    #[test]
    fn base_native_id_and_speaker_face_bounds_count_code_points() {
        for length in [256, 257] {
            let item = ace_json::json!({
                "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"message",
                "role":"user","nativeId":"😀".repeat(length),
                "parts":[{"type":"text","text":"hi"}]
            });
            assert_eq!(ok(&item), length == 256, "nativeId");
        }
        for (key, value, limit, expected) in [
            ("k".repeat(32), "v".to_owned(), 32, true),
            ("k".repeat(33), "v".to_owned(), 33, false),
            ("k".to_owned(), "😀".repeat(256), 256, true),
            ("k".to_owned(), "😀".repeat(257), 257, false),
        ] {
            let mut face = Map::new();
            face.insert(key.as_str(), Json::from(value));
            let item = ace_json::json!({
                "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"message",
                "role":"assistant","parts":[{"type":"text","text":"hi"}],
                "speaker":{"kind":"bot","id":"b","name":"b","about":"a","avatar":face}
            });
            assert_eq!(ok(&item), expected, "{limit}");
        }
    }

    #[test]
    fn attachment_names_count_code_points() {
        for (field, limit) in [("mimeType", 128), ("name", 255)] {
            for length in [limit, limit + 1] {
                let text = "😀".repeat(length);
                let mut attachment = ace_json::json!({
                    "sha256":"0".repeat(64),"bytes":1,"mimeType":"image/png","name":"n"
                });
                attachment
                    .as_object_mut()
                    .expect("attachment")
                    .insert(field, Json::from(text));
                let item = ace_json::json!({
                    "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"message",
                    "role":"user","parts":[{"type":"text","text":"hi"}],"attachments":[attachment]
                });
                assert_eq!(ok(&item), length == limit, "{field}");
            }
        }
    }

    #[test]
    fn delegation_failure_code_and_result_count_code_points() {
        for (field, limit) in [("code", 64), ("result", 4096)] {
            for length in [limit, limit + 1] {
                let text = "😀".repeat(length);
                let mut outcome = ace_json::json!({
                    "threadId":"t","outcome":"failed","result":"r","truncated":false,
                    "failure":{"code":"code","message":"m"}
                });
                let map = outcome.as_object_mut().expect("outcome");
                if field == "code" {
                    map.get_mut("failure")
                        .and_then(Json::as_object_mut)
                        .expect("failure")
                        .insert("code", Json::from(text));
                } else {
                    map.insert("result", Json::from(text));
                }
                let item = ace_json::json!({
                    "id":"i","agentId":"a","createdAt":0,"complete":true,
                    "type":"delegation.started","origin":"ace","childThreadId":"c",
                    "provider":"codex","title":"t","role":"r","phase":"settled",
                    "status":{"state":"done"},"updatedAt":0,"generation":0,"outcome":outcome
                });
                assert_eq!(ok(&item), length == limit, "{field}");
            }
        }
    }

    #[test]
    fn notice_details_code_counts_code_points() {
        for length in [256, 257] {
            let item = ace_json::json!({
                "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"notice",
                "level":"error","text":"t",
                "details":{"code":"😀".repeat(length),"provider":"codex"}
            });
            assert_eq!(ok(&item), length == 256);
        }
    }

    #[test]
    fn tool_image_paths_count_code_points() {
        for field in ["path", "sourcePath"] {
            for length in [4096, 4097] {
                let text = "😀".repeat(length);
                let mut detail = ace_json::json!({"kind":"image","path":"p"});
                detail
                    .as_object_mut()
                    .expect("detail")
                    .insert(field, Json::from(text));
                let item = ace_json::json!({
                    "id":"i","agentId":"a","createdAt":0,"complete":true,"type":"tool_call",
                    "call":{
                        "id":"i","agentId":"a","kind":"image","title":"image",
                        "status":"pending","startedAt":0,"detail":detail,"raw":[]
                    }
                });
                assert_eq!(ok(&item), length == 4096, "{field}");
            }
        }
    }
}
