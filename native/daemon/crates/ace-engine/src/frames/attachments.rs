// SPDX-License-Identifier: Apache-2.0
//! Attachment echoes (`attachment-echo.ts`). Only verified, thread-owned uploads replace provider
//! paths and inline image echoes; native envelopes stay available, with just the matched payload
//! fields replaced by content ids.

use crate::EngineError;
use crate::frames::attachment_payload::attachment_payload;
use ace_adapter_api::util::binary_elision::elided_digest;
use ace_adapter_api::util::data_url::{base64_data_url, is_base64};
use ace_json::{JsString, Value};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// The SHA-256 digest of an upload's bytes, as a file name ends with it (`attachment-echo.ts:8`).
pub fn path_hash(text: &JsString) -> Option<String> {
    let units: Vec<u16> = text.units().collect();
    let mut end = units.len();
    // The optional extension is a `.` and one or more lowercase letters at the end.
    if let Some(dot) = units.iter().rposition(|unit| *unit == u16::from(b'.')) {
        let suffix = units.get(dot + 1..)?;
        if !suffix.is_empty() && suffix.iter().all(|unit| (0x61..=0x7a).contains(unit)) {
            end = dot;
        }
    }
    let start = end.checked_sub(64)?;
    let hash = units.get(start..end)?;
    if !hash
        .iter()
        .all(|unit| matches!(unit, 0x30..=0x39 | 0x61..=0x66))
    {
        return None;
    }
    if start > 0 && !matches!(units[start - 1], 0x2f | 0x5c) {
        return None;
    }
    String::from_utf16(hash).ok()
}

/// The digest an image value stands for (`attachment-echo.ts:11`).
pub fn image_hash(text: &JsString) -> Option<String> {
    let value = text.as_well_formed()?;
    // Adapters keep attachment bytes out of frames; the marker carries the bytes' digest, and a
    // translator may have rebuilt a data URL around it.
    let marked = if let Some(rest) = value.strip_prefix("data:") {
        value.get(5 + rest.find(',')?..).unwrap_or(value)
    } else {
        value
    };
    if let Some(digest) = elided_digest(marked) {
        return Some(digest.to_string());
    }
    let data = if value.starts_with("data:") {
        base64_data_url(value)?.data
    } else {
        value
    };
    if data.is_empty() || data.encode_utf16().count() > 6 * 1024 * 1024 || !is_base64(data) {
        return None;
    }
    let bytes = decode_base64(data)?;
    Some(hex(&Sha256::digest(&bytes)))
}

/// Node's `Buffer.from(text, "base64")`: padding optional, trailing bits ignored.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(text).ok()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(name),
        _ => None,
    }
}

fn text_field<'a>(value: &'a Value, name: &str) -> Option<&'a JsString> {
    match field(value, name) {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

fn content_hash(part: &Value) -> Option<String> {
    match text_field(part, "type").map(JsString::as_str) {
        Some("file") => path_hash(text_field(part, "path")?),
        Some("image") => image_hash(text_field(part, "url")?),
        _ => None,
    }
}

/// Only a user message's upsert or reconciliation is touched: only they carry uploads.
fn is_user_message(fact: &Value) -> bool {
    if !matches!(
        text_field(fact, "type").map(JsString::as_str),
        Some("item.upsert" | "item.reconciled")
    ) {
        return false;
    }
    let Some(draft) = field(fact, "draft") else {
        return false;
    };
    text_field(draft, "type").map(JsString::as_str) == Some("message")
        && text_field(draft, "role").map(JsString::as_str) == Some("user")
}

#[allow(clippy::too_many_arguments)]
fn find(
    hash: Option<String>,
    lookup: &mut dyn FnMut(&str) -> Result<Option<Value>, EngineError>,
    verified: &mut HashMap<String, Option<Value>>,
    found: &mut Vec<(String, Value)>,
) -> Result<Option<Value>, EngineError> {
    let Some(hash) = hash else {
        return Ok(None);
    };
    if !verified.contains_key(&hash) {
        let attachment = lookup(&hash)?;
        verified.insert(hash.clone(), attachment);
    }
    let attachment = verified.get(&hash).cloned().flatten();
    if let Some(attachment) = &attachment
        && !found.iter().any(|(key, _)| key == &hash)
    {
        found.push((hash.clone(), attachment.clone()));
    }
    Ok(attachment)
}

/// Replace verified uploads' paths and echoes with content ids, appending the attachments.
pub fn attachment_echo(
    fact: Value,
    lookup: &mut dyn FnMut(&str) -> Result<Option<Value>, EngineError>,
) -> Result<Value, EngineError> {
    if !is_user_message(&fact) {
        return Ok(fact);
    }
    let mut verified: HashMap<String, Option<Value>> = HashMap::new();
    let mut found: Vec<(String, Value)> = Vec::new();
    let draft = field(&fact, "draft").cloned().unwrap_or(Value::Null);
    let mut parts: Vec<Value> = Vec::new();
    if let Some(Value::Array(given)) = field(&draft, "parts") {
        for part in given.iter() {
            if find(content_hash(part), lookup, &mut verified, &mut found)?.is_none() {
                parts.push(part.clone());
            }
        }
    }
    let mut sanitize = |key: &str, value: &JsString| -> Result<JsString, EngineError> {
        let hash = match key {
            "path" => path_hash(value),
            "url" | "uri" => path_hash(value).or_else(|| image_hash(value)),
            "data" => image_hash(value),
            _ => None,
        };
        // A busy lookup is retried by the fold: swallowing it would echo the original path.
        match find(hash, lookup, &mut verified, &mut found)? {
            Some(attachment) => match text_field(&attachment, "sha256") {
                Some(sha256) => {
                    let mut id = JsString::from("attachment:");
                    id.push_js(sha256);
                    Ok(id)
                }
                None => Ok(value.clone()),
            },
            None => Ok(value.clone()),
        }
    };
    let raw = match field(&draft, "raw") {
        Some(Value::Array(entries)) => {
            let mut out = Vec::with_capacity(entries.len());
            for entry in entries.iter() {
                if field(entry, "data").is_none() {
                    out.push(entry.clone());
                    continue;
                }
                let data = attachment_payload(
                    field(entry, "data").unwrap_or(&Value::Null),
                    &mut sanitize,
                )?;
                let mut copy = match entry.clone() {
                    Value::Object(map) => map,
                    other => {
                        out.push(other);
                        continue;
                    }
                };
                copy.insert("data", data);
                out.push(Value::Object(copy));
            }
            Some(Value::Array(out.into()))
        }
        _ => None,
    };
    if found.is_empty() {
        return Ok(fact);
    }
    let Value::Object(mut map) = fact else {
        return Ok(Value::Null);
    };
    let mut draft_map = match draft {
        Value::Object(map) => map,
        _ => return Ok(Value::Object(map)),
    };
    // Each replacement is in place when the key exists and appended when it does not.
    draft_map.insert("parts", Value::Array(parts.into()));
    let attachments: Vec<Value> = found
        .into_iter()
        .map(|(_, attachment)| attachment)
        .collect();
    draft_map.insert("attachments", Value::Array(attachments.into()));
    if let Some(raw) = raw {
        draft_map.insert("raw", raw);
    }
    map.insert("draft", Value::Object(draft_map));
    Ok(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::{attachment_echo, image_hash, path_hash};
    use ace_json::{JsString, Value, json};

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn upload() -> Value {
        json!({"sha256": HASH, "bytes": 3, "mimeType": "image/png", "kind": "image"})
    }

    fn lookup_upload(hash: &str) -> Result<Option<Value>, crate::EngineError> {
        Ok((hash == HASH).then(upload))
    }

    #[test]
    fn an_echo_with_no_thread_owned_upload_is_returned_untouched() {
        let fact = json!({
            "type": "item.upsert", "agent": "root", "item": "m1",
            "draft": {
                "type": "message", "role": "user", "complete": true,
                "parts": [{"type": "file", "path": format!("/tmp/{HASH}.png")}],
                "raw": [{"type": "image", "data": {"path": format!("/tmp/{HASH}.png")}}],
            },
        });
        let untouched = attachment_echo(fact.clone(), &mut |_hash| Ok(None)).expect("a fact");
        assert_eq!(ace_json::to_string(&untouched), ace_json::to_string(&fact));
    }

    #[test]
    fn a_matched_part_is_removed_and_the_attachment_appended_in_first_match_order() {
        let fact = json!({
            "type": "item.upsert", "agent": "root", "item": "m1",
            "draft": {
                "type": "message", "role": "user", "complete": true,
                "parts": [{"type": "file", "path": format!("/tmp/{HASH}.png")}],
            },
        });
        let echoed = attachment_echo(fact, &mut lookup_upload).expect("a fact");
        let draft = match &echoed {
            Value::Object(map) => map.get("draft").cloned().unwrap_or(Value::Null),
            _ => Value::Null,
        };
        assert_eq!(
            ace_json::to_string(&draft),
            format!(
                "{{\"type\":\"message\",\"role\":\"user\",\"complete\":true,\"parts\":[],\"attachments\":[{}]}}",
                ace_json::to_string(&upload())
            )
        );
    }

    #[test]
    fn a_base64_value_without_padding_hashes_as_node_decodes_it() {
        // "QUJD" is "ABC"; without its padding Node still decodes it.
        assert_eq!(
            image_hash(&JsString::from("QUJD")).as_deref(),
            Some("b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78"),
        );
        assert_eq!(
            image_hash(&JsString::from("data:image/png;base64,QUJD")).as_deref(),
            Some("b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78"),
        );
    }

    #[test]
    fn a_path_hash_is_the_last_64_hex_segment_before_an_extension() {
        assert_eq!(
            path_hash(&JsString::from(format!("/tmp/uploads/{HASH}.png").as_str())).as_deref(),
            Some(HASH)
        );
        assert_eq!(path_hash(&JsString::from(HASH)).as_deref(), Some(HASH));
        assert_eq!(path_hash(&JsString::from("0123.png")), None);
        assert_eq!(path_hash(&JsString::from(format!("x{HASH}.png"))), None);
    }

    #[test]
    fn a_deeply_nested_raw_field_is_walked_without_recursion() {
        let mut value = json!({"path": format!("/tmp/{HASH}.png")});
        for _ in 0..100_000 {
            value = Value::Array(vec![value].into());
        }
        let fact = json!({
            "type": "item.upsert", "agent": "root", "item": "m1",
            "draft": {"type": "message", "role": "user", "raw": [{"type": "x", "data": value}]},
        });
        let echoed = attachment_echo(fact, &mut lookup_upload).expect("a fact");
        let text = ace_json::to_string(&echoed);
        assert!(text.contains("attachment:"), "the deep path was replaced");
    }

    #[test]
    fn a_raw_payload_echoing_two_uploads_lists_them_in_the_type_scripts_visiting_order() {
        let second = "1111111111111111111111111111111111111111111111111111111111111111";
        let mut lookup = |hash: &str| {
            if hash == HASH {
                return Ok(Some(json!({"sha256": HASH})));
            }
            Ok((hash == second).then(|| json!({"sha256": second})))
        };
        let fact = json!({
            "type": "item.upsert", "agent": "root", "item": "m1",
            "draft": {
                "type": "message", "role": "user",
                "raw": [{"type": "x", "data": {
                    "first": {"path": format!("/tmp/{HASH}")},
                    "second": {"path": format!("/tmp/{second}")},
                }}],
            },
        });
        let echoed = attachment_echo(fact, &mut lookup).expect("a fact");
        let attestations = match &echoed {
            Value::Object(map) => match map.get("draft").and_then(|draft| match draft {
                Value::Object(draft) => draft.get("attachments"),
                _ => None,
            }) {
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| match item {
                        Value::Object(map) => match map.get("sha256") {
                            Some(Value::String(text)) => text.to_string_lossy().into_owned(),
                            _ => String::new(),
                        },
                        _ => String::new(),
                    })
                    .collect::<Vec<String>>(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        assert_eq!(attestations, vec![second.to_string(), HASH.to_string()]);
    }
}
