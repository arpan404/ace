// SPDX-License-Identifier: Apache-2.0
//! The Pi input rendering the engine's journal re-signs with (`packages/adapter-pi/src/input.ts`,
//! E5.4b): `piInput` validates and budgets the caller's parts before a native command is
//! assembled. The session's own use stays TypeScript until E3's Pi session moves (ADR 0223).
//!
//! The errors fire in the TypeScript's order with its bytes; only the message reaches the
//! journal's signature.

use ace_adapter_api::util::{base64_data_url, is_base64, is_js_space};
use ace_json::Value;
use thiserror::Error;

/// The input errors the TypeScript throws, byte for byte.
#[derive(Debug, Error)]
pub enum PiInputError {
    #[error("Unresolved Pi mention")]
    UnresolvedMention,
    #[error("Pi input exceeds frame budget")]
    FrameBudget,
    #[error("Pi images require a matching base64 data URL")]
    ImageDataUrl,
    #[error("Reserved Pi control command")]
    ReservedCommand,
}

/// One image the message carries after the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiImage {
    pub data: String,
    pub mime_type: String,
}

/// The native message and its images.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PiInput {
    pub message: String,
    pub images: Vec<PiImage>,
}

/// The frame budget: 1 MiB per value, and 256 bytes of framing per part.
const MAX_VALUE_UTF16: usize = 1024 * 1024;
const PART_OVERHEAD: usize = 256;

fn kind(part: &Value) -> &str {
    part.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn text<'a>(part: &'a Value, key: &str) -> Option<&'a str> {
    part.get(key).and_then(Value::as_str)
}

/// `/^\/ace-(?:rollback|context)(?:\s|$)/` over `message.trimStart()`.
fn reserved_command(message: &str) -> bool {
    let trimmed = message.trim_start_matches(is_js_space);
    for command in ["/ace-rollback", "/ace-context"] {
        let Some(rest) = trimmed.strip_prefix(command) else {
            continue;
        };
        if rest.is_empty() || rest.starts_with(is_js_space) {
            return true;
        }
    }
    false
}

/// `piInput`: the message's text, its images, and the budget and control-command checks.
pub fn pi_input(input: &[Value]) -> Result<PiInput, PiInputError> {
    let mut text_parts: Vec<String> = Vec::new();
    let mut images: Vec<PiImage> = Vec::new();
    let mut bytes = 0usize;
    for part in input {
        let value = match kind(part) {
            "text" => text(part, "text").unwrap_or_default(),
            "file" => text(part, "path").unwrap_or_default(),
            "mention" => return Err(PiInputError::UnresolvedMention),
            _ => text(part, "url").unwrap_or_default(),
        };
        if value.encode_utf16().count() > MAX_VALUE_UTF16 {
            return Err(PiInputError::FrameBudget);
        }
        bytes += value.len() + PART_OVERHEAD;
        if bytes > MAX_VALUE_UTF16 {
            return Err(PiInputError::FrameBudget);
        }
        match kind(part) {
            "text" => text_parts.push(text(part, "text").unwrap_or_default().to_owned()),
            "file" => text_parts.push(format!("File: {}", text(part, "path").unwrap_or_default())),
            _ => {
                let mime_type = text(part, "mimeType").unwrap_or_default();
                let image = base64_data_url(value);
                let valid = match &image {
                    Some(image) => {
                        !image.data.is_empty()
                            && is_base64(image.data)
                            && image.mime_type == mime_type
                    }
                    None => false,
                };
                if !valid {
                    return Err(PiInputError::ImageDataUrl);
                }
                let data = image.map(|image| image.data.to_owned()).unwrap_or_default();
                images.push(PiImage {
                    data,
                    mime_type: mime_type.to_owned(),
                });
            }
        }
    }
    let message = text_parts.join("\n");
    if reserved_command(&message) {
        return Err(PiInputError::ReservedCommand);
    }
    Ok(PiInput { message, images })
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

    #[test]
    fn text_files_and_images_render_in_order() {
        let input = parts(
            r#"[{"type":"text","text":"look"},{"type":"file","path":"/tmp/a.txt"},{"type":"image","mimeType":"image/png","url":"data:image/png;base64,QQ=="}]"#,
        );
        let rendered = pi_input(&input).unwrap();
        assert_eq!(rendered.message, "look\nFile: /tmp/a.txt");
        assert_eq!(
            rendered.images,
            vec![PiImage {
                data: "QQ==".into(),
                mime_type: "image/png".into()
            }]
        );
    }

    #[test]
    fn an_unresolved_mention_and_a_reserved_command_are_refused_with_their_bytes() {
        let mention = parts(r#"[{"type":"mention","entryId":"e","kind":"skill","name":"Review"}]"#);
        assert_eq!(
            pi_input(&mention).unwrap_err().to_string(),
            "Unresolved Pi mention"
        );
        let reserved = parts(r#"[{"type":"text","text":"  /ace-rollback now"}]"#);
        assert_eq!(
            pi_input(&reserved).unwrap_err().to_string(),
            "Reserved Pi control command"
        );
    }

    #[test]
    fn a_megabyte_of_text_in_one_part_passes_and_a_megabyte_and_one_refuses() {
        let exact = format!(
            r#"[{{"type":"text","text":"{}"}}]"#,
            "x".repeat(MAX_VALUE_UTF16)
        );
        // The per-value check passes, and the 256-byte framing pushes the total over: the same
        // refusal the TypeScript raises.
        assert_eq!(
            pi_input(&parts(&exact)).unwrap_err().to_string(),
            "Pi input exceeds frame budget"
        );
        let one_more = format!(
            r#"[{{"type":"text","text":"{}"}}]"#,
            "x".repeat(MAX_VALUE_UTF16 + 1)
        );
        assert_eq!(
            pi_input(&parts(&one_more)).unwrap_err().to_string(),
            "Pi input exceeds frame budget"
        );
    }

    #[test]
    fn an_image_needs_a_matching_base64_data_url() {
        let bad = parts(
            r#"[{"type":"image","mimeType":"image/png","url":"data:image/jpeg;base64,QQ=="}]"#,
        );
        assert_eq!(
            pi_input(&bad).unwrap_err().to_string(),
            "Pi images require a matching base64 data URL"
        );
    }
}
