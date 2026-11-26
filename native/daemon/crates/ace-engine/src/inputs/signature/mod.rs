// SPDX-License-Identifier: Apache-2.0
//! The input journal's signature and the text helpers it reads (`input-journal.ts:42`-`:66`,
//! E5.4b): SHA-256 of the text parts of `withoutPortableHandoff(parts)` joined by `"\n"`,
//! lowercase hex. The handoff envelope is measured and sliced in UTF-16 code units, as
//! JavaScript holds strings (`packages/handoff/src/envelope.ts:25`).
//!
//! The provider renderings are the adapters' own modules; only their text reaches the hash.

use ace_adapter_api::util::{is_js_space, native_command_inputs};
use ace_json::Value;
use sha2::{Digest, Sha256};

use crate::EngineError;

mod manifest;

pub use manifest::valid_portable_handoff;

/// The plain-text handoff block scoreboard tag.
pub const HANDOFF_TAG: &str = "ace_context_handoff";
/// The longest envelope whose content is removed.
pub const MAX_ENVELOPE: usize = 512 * 1024;

/// `text.replace(/^(?:\r?\n)+/, "")`: every leading line break goes.
fn without_leading_breaks(text: &str) -> &str {
    let mut rest = text;
    loop {
        if let Some(after) = rest.strip_prefix("\r\n") {
            rest = after;
        } else if let Some(after) = rest.strip_prefix('\n') {
            rest = after;
        } else {
            return rest;
        }
    }
}

/// Whether `units` starts with the handoff's opening tag and ends its match after it.
///
/// `^<ace_context_handoff source_thread="[^"\n]{1,256}" through_seq="\d{1,16}">\n`
fn open_tag_len(units: &[u16]) -> Option<usize> {
    let prefix: Vec<u16> = format!("<{HANDOFF_TAG} source_thread=\"")
        .encode_utf16()
        .collect();
    if !units.starts_with(&prefix) {
        return None;
    }
    let mut at = prefix.len();
    let source = units.get(at..)?;
    let end = source
        .iter()
        .position(|unit| *unit == u16::from(b'"') || *unit == u16::from(b'\n'))?;
    if !(1..=256).contains(&end) {
        return None;
    }
    at += end;
    let middle: Vec<u16> = "\" through_seq=\"".encode_utf16().collect();
    if units.get(at..)?.starts_with(&middle) {
        at += middle.len();
    } else {
        return None;
    }
    let digits = units
        .get(at..)?
        .iter()
        .take_while(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(*unit))
        .count();
    if !(1..=16).contains(&digits) {
        return None;
    }
    at += digits;
    let close: Vec<u16> = "\">\n".encode_utf16().collect();
    if units.get(at..)?.starts_with(&close) {
        Some(at + close.len())
    } else {
        None
    }
}

/// `text` without ace's leading handoff block, or `None` when it doesn't start with one.
pub fn without_handoff_envelope(text: &str) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = units
        .iter()
        .position(|unit| !is_js_space(u16_char(*unit)))
        .unwrap_or(units.len());
    let trimmed = &units[start..];
    if trimmed.len() > MAX_ENVELOPE + 64 * 1024 {
        return None;
    }
    if open_tag_len(trimmed).is_some() {
        let close: Vec<u16> = format!("\n</{HANDOFF_TAG}>").encode_utf16().collect();
        let end = trimmed
            .windows(close.len())
            .position(|window| window == close.as_slice())?;
        if end > MAX_ENVELOPE {
            return None;
        }
        let rest = from_units(&trimmed[end + close.len()..]);
        return Some(without_leading_breaks(&rest).to_owned());
    }
    without_json_manifest(&from_units(trimmed))
}

/// A single UTF-16 unit as the char it spells (lone surrogates become U+FFFD).
fn u16_char(unit: u16) -> char {
    char::decode_utf16([unit])
        .next()
        .and_then(Result::ok)
        .unwrap_or(char::REPLACEMENT_CHARACTER)
}

/// UTF-16 units rendered as a string, pairs paired as JavaScript pairs them.
fn from_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// The version 1 envelope: the manifest itself as JSON, validated before it is removed.
fn without_json_manifest(text: &str) -> Option<String> {
    if !starts_like_manifest(text) || text.encode_utf16().count() > MAX_ENVELOPE {
        return None;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut depth: i64 = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (at, unit) in units.iter().enumerate() {
        let unit = *unit;
        if quoted {
            if escaped {
                escaped = false;
            } else if unit == u16::from(b'\\') {
                escaped = true;
            } else if unit == u16::from(b'"') {
                quoted = false;
            }
        } else if unit == u16::from(b'"') {
            quoted = true;
        } else if unit == u16::from(b'{') {
            depth += 1;
        } else if unit == u16::from(b'}') {
            depth -= 1;
            if depth == 0 {
                let manifest = ace_json::parse(&from_units(&units[..=at])).ok()?;
                if !valid_portable_handoff(&manifest) {
                    return None;
                }
                let rest = from_units(&units[at + 1..]);
                return Some(without_leading_breaks(&rest).to_owned());
            }
        }
    }
    None
}

/// `/^\{\s*"version"\s*:\s*1\s*,/` over the text's code units.
fn starts_like_manifest(text: &str) -> bool {
    let trimmed = text.trim_start_matches(is_js_space);
    let Some(rest) = trimmed.strip_prefix('{') else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_space);
    let Some(rest) = rest.strip_prefix("\"version\"") else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_space);
    let Some(rest) = rest.strip_prefix(':') else {
        return false;
    };
    let rest = rest.trim_start_matches(is_js_space);
    let Some(rest) = rest.strip_prefix('1') else {
        return false;
    };
    rest.trim_start_matches(is_js_space).starts_with(',')
}

/// `withoutPortableHandoff` (`packages/projection/src/portable-input.ts:5`).
pub fn without_portable_handoff(parts: &[Value]) -> Vec<Value> {
    let Some(first) = parts.first() else {
        return Vec::new();
    };
    if first.get("type").and_then(Value::as_str) != Some("text") {
        return parts.to_vec();
    }
    let text = first
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(rest) = without_handoff_envelope(text) else {
        return parts.to_vec();
    };
    let mut kept = Vec::with_capacity(parts.len());
    if !rest.is_empty() {
        let mut block = ace_json::Map::new();
        block.insert("type", Value::from("text"));
        block.insert("text", Value::from(rest.as_str()));
        kept.push(Value::Object(block));
    }
    kept.extend(parts[1..].iter().cloned());
    kept
}

/// `signature(parts)`: SHA-256 hex of the text parts, joined by `"\n"`.
pub fn signature(parts: &[Value]) -> String {
    let kept = without_portable_handoff(parts);
    let joined: Vec<&str> = kept
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default())
        .collect();
    let hex = Sha256::digest(joined.join("\n").as_bytes());
    let mut text = String::with_capacity(hex.len() * 2);
    for byte in hex {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// `providerInput(parts, provider)` (`input-journal.ts:52`): what the provider's own rendering
/// signs, not the person's parts. Only Claude's first admission and Pi's message reach it.
pub fn provider_input(parts: &[Value], provider: Option<&str>) -> Result<Vec<Value>, EngineError> {
    if provider == Some("pi") {
        let native = native_command_inputs(parts)
            .map_err(|error| EngineError::Records(error.to_string()))?;
        let message = ace_adapter_pi::input::pi_input(&native[0])
            .map_err(|error| EngineError::Records(error.to_string()))?;
        return Ok(text_parts(&[message.message]));
    }
    if provider != Some("claude") {
        return Ok(parts.to_vec());
    }
    let texts = ace_adapter_claude::input::signature_parts(parts)
        .map_err(|error| EngineError::Records(error.to_string()))?;
    Ok(text_parts(&texts))
}

fn text_parts(texts: &[String]) -> Vec<Value> {
    texts
        .iter()
        .map(|text| {
            let mut block = ace_json::Map::new();
            block.insert("type", Value::from("text"));
            block.insert("text", Value::from(text.as_str()));
            Value::Object(block)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(text: &str) -> Vec<Value> {
        ace_json::parse(text)
            .expect("a parts array")
            .as_array()
            .expect("an array")
            .to_vec()
    }

    fn envelope(text: &str) -> String {
        format!(
            "<{HANDOFF_TAG} source_thread=\"thread_1\" through_seq=\"12\">\n{text}\n</{HANDOFF_TAG}>"
        )
    }

    #[test]
    fn the_plain_text_envelope_and_the_json_manifest_are_both_removed() {
        assert_eq!(
            without_handoff_envelope(&envelope("carried")),
            Some(String::new())
        );
        let manifest = r#"{"version":1,"sourceThreadId":"t","throughSeq":0,"lossy":true,"policy":"conversation-first","excerpts":[],"omittedItems":0,"history":{"type":"items.page","threadId":"t","before":5,"limit":50},"limitations":"Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments."}"#;
        assert_eq!(
            without_handoff_envelope(&format!("\r\n{manifest}\n\nwords")),
            Some("words".into())
        );
    }

    #[test]
    fn an_untagged_manifest_a_too_long_envelope_and_a_multi_byte_source_keep_their_text() {
        assert_eq!(without_handoff_envelope("{\"version\":2}"), None);
        let manifest = r#"{"version":1,"sourceThreadId":"","throughSeq":0,"lossy":true,"policy":"conversation-first","excerpts":[],"omittedItems":0,"history":{"type":"items.page","threadId":"t","before":5,"limit":50},"limitations":"Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments."}"#;
        assert_eq!(without_handoff_envelope(manifest), None);
        let long = format!(
            "<{HANDOFF_TAG} source_thread=\"t\" through_seq=\"1\">\n{}\n</{HANDOFF_TAG}>",
            "x".repeat(600 * 1024)
        );
        assert_eq!(without_handoff_envelope(&long), None);
        // A source id counts code units: a two-unit character in its place still fits 256.
        let wide = format!(
            "<{HANDOFF_TAG} source_thread=\"{}\" through_seq=\"1\">\necho\n</{HANDOFF_TAG}>",
            "\u{1f600}".repeat(128)
        );
        assert_eq!(without_handoff_envelope(&wide), Some(String::new()));
        let too_wide = format!(
            "<{HANDOFF_TAG} source_thread=\"{}\" through_seq=\"1\">\necho\n</{HANDOFF_TAG}>",
            "\u{1f600}".repeat(129)
        );
        assert_eq!(without_handoff_envelope(&too_wide), None);
    }

    #[test]
    fn the_signature_is_the_text_parts_joined_by_a_newline_after_the_envelope_goes() {
        let signed = parts(
            r#"[{"type":"text","text":"one"},{"type":"image","mimeType":"image/png","url":"data:image/png;base64,QQ=="},{"type":"text","text":"two"}]"#,
        );
        assert_eq!(
            signature(&signed),
            signature(&parts(
                r#"[{"type":"text","text":"one"},{"type":"text","text":"two"}]"#
            ))
        );
        let carried_text = format!("{}\nwords", envelope("carried"));
        let mut carried = ace_json::Map::new();
        carried.insert("type", Value::from("text"));
        carried.insert("text", Value::from(carried_text.as_str()));
        assert_eq!(
            signature(&[Value::Object(carried)]),
            signature(&parts(r#"[{"type":"text","text":"words"}]"#))
        );
        assert_eq!(
            signature(&parts(r#"[{"type":"text","text":"a\nb"}]"#)),
            signature(&parts(
                r#"[{"type":"text","text":"a"},{"type":"text","text":"b"}]"#
            ))
        );
    }

    #[test]
    fn the_json_manifest_reports_an_invalid_manifest_without_throwing() {
        assert!(!valid_portable_handoff(&ace_json::parse("null").unwrap()));
        assert!(valid_portable_handoff(
            &ace_json::parse(r#"{"version":1,"sourceThreadId":"t","throughSeq":0,"lossy":true,"policy":"conversation-first","excerpts":[],"omittedItems":0,"history":{"type":"items.page","threadId":"t","before":1,"limit":50},"limitations":"Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments."}"#).unwrap()
        ));
    }
}
