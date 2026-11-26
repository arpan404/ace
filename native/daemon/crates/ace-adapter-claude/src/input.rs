// SPDX-License-Identifier: Apache-2.0
//! The Claude input rendering the engine's journal re-signs with
//! (`packages/adapter-claude/src/input.ts:30`-`:99`, E5.4b): `content` and `admissions`. The
//! session's own use of these stays TypeScript until the Claude session moves (ADR 0223).
//!
//! Only a part's text reaches the journal's signature, so a block records whether it carries
//! text. Every other rendering is still validated, in the TypeScript's order with its bytes.

use ace_adapter_api::util::{base64_data_url, native_command_inputs};
use ace_json::Value;
use thiserror::Error;

/// The input errors the TypeScript throws, byte for byte.
#[derive(Debug, Error)]
pub enum ClaudeInputError {
    #[error("Unresolved Claude mention")]
    UnresolvedMention,
    #[error("Claude image inputs require a matching base64 data URL")]
    ImageDataUrl,
    #[error("Unresolved command mention")]
    UnresolvedCommand,
}

/// One rendered content block: its text when it has any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeBlock {
    Text(String),
    /// A document or an image block: rendered and validated, never part of a signature.
    Attachment,
}

/// One rendered admission: a bare string, or content blocks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeAdmission {
    Text(String),
    Blocks(Vec<ClaudeBlock>),
}

/// The image media types the Claude input accepts (`ImageMime`).
const IMAGE_MIME: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

fn kind(part: &Value) -> &str {
    part.get("type").and_then(Value::as_str).unwrap_or_default()
}

fn text<'a>(part: &'a Value, key: &str) -> Option<&'a str> {
    part.get(key).and_then(Value::as_str)
}

/// The JSON text of a string value, as `JSON.stringify` prints it.
fn quoted(value: &str) -> String {
    ace_json::to_string(&Value::from(value))
}

/// `content`: every part as a content block, or the refusal the TypeScript raises.
pub fn content(input: &[Value]) -> Result<Vec<ClaudeBlock>, ClaudeInputError> {
    let mut blocks = Vec::with_capacity(input.len());
    for part in input {
        match kind(part) {
            "mention" => return Err(ClaudeInputError::UnresolvedMention),
            "text" => blocks.push(ClaudeBlock::Text(
                text(part, "text").unwrap_or_default().into(),
            )),
            "file" => {
                let encoding = part
                    .get("content")
                    .and_then(|content| content.get("encoding"))
                    .and_then(Value::as_str);
                let mime_type = text(part, "mimeType");
                if (mime_type == Some("application/pdf") && encoding == Some("base64"))
                    || encoding == Some("text")
                {
                    // A PDF or a text file is a document: no text block of its own.
                    blocks.push(ClaudeBlock::Attachment);
                } else {
                    let shown = mime_type.unwrap_or("application/octet-stream");
                    let path = text(part, "path").unwrap_or_default();
                    blocks.push(ClaudeBlock::Text(format!(
                        "File ({shown}): {}",
                        quoted(path)
                    )));
                }
            }
            _ => {
                // An image: its media type must be one Claude takes, and its base64 data URL
                // must carry that same media type and some data.
                let mime_type = text(part, "mimeType").unwrap_or_default();
                let data = text(part, "url").and_then(base64_data_url);
                let valid = IMAGE_MIME.contains(&mime_type)
                    && data
                        .as_ref()
                        .is_some_and(|url| !url.data.is_empty() && url.mime_type == mime_type);
                if !valid {
                    return Err(ClaudeInputError::ImageDataUrl);
                }
                blocks.push(ClaudeBlock::Attachment);
            }
        }
    }
    Ok(blocks)
}

/// `admissions`: one user message per selected command, the first standing for the message.
pub fn admissions(input: &[Value]) -> Result<Vec<ClaudeAdmission>, ClaudeInputError> {
    if !input.iter().any(|part| kind(part) == "mention") {
        return Ok(vec![ClaudeAdmission::Blocks(content(input)?)]);
    }
    let native = native_command_inputs(input).map_err(|_| ClaudeInputError::UnresolvedCommand)?;
    native
        .into_iter()
        .map(|parts| {
            if parts.iter().all(|part| kind(part) == "text") {
                let joined: String = parts
                    .iter()
                    .map(|part| text(part, "text").unwrap_or_default())
                    .collect();
                Ok(ClaudeAdmission::Text(joined))
            } else {
                Ok(ClaudeAdmission::Blocks(content(&parts)?))
            }
        })
        .collect()
}

/// `providerInput(parts, "claude")` (`input-journal.ts:60`-`:64`): the first admission's text
/// parts become the journal's signature input.
pub fn signature_parts(input: &[Value]) -> Result<Vec<String>, ClaudeInputError> {
    let first = admissions(input)?.into_iter().next();
    Ok(match first {
        Some(ClaudeAdmission::Text(text)) => vec![text],
        Some(ClaudeAdmission::Blocks(blocks)) => blocks
            .into_iter()
            .filter_map(|block| match block {
                ClaudeBlock::Text(text) => Some(text),
                ClaudeBlock::Attachment => None,
            })
            .collect(),
        None => Vec::new(),
    })
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
    fn a_selected_command_is_sent_as_one_string_with_the_message_as_context() {
        let input = parts(
            r#"[{"type":"mention","entryId":"e","kind":"command","name":"Review","arguments":"now","invocation":{"type":"slash","name":"review"}},{"type":"text","text":"look"}]"#,
        );
        let admissions = admissions(&input).unwrap();
        assert_eq!(
            admissions,
            vec![ClaudeAdmission::Text(
                "/review now\n\nMessage context:\n[Review]look".into()
            )]
        );
    }

    #[test]
    fn a_pdf_and_a_text_file_render_as_documents_and_an_unknown_file_keeps_its_path_line() {
        let input = parts(
            r#"[{"type":"file","path":"/tmp/report.pdf","mimeType":"application/pdf","content":{"encoding":"base64","data":"QQ=="}},{"type":"file","path":"/tmp/notes.txt","content":{"encoding":"text","data":"hi"}},{"type":"file","path":"/tmp/blob.bin"}]"#,
        );
        assert_eq!(
            signature_parts(&input).unwrap(),
            vec!["File (application/octet-stream): \"/tmp/blob.bin\""]
        );
    }

    #[test]
    fn an_image_needs_a_matching_base64_data_url() {
        let good = parts(
            r#"[{"type":"image","mimeType":"image/png","url":"data:image/png;base64,QQ=="}]"#,
        );
        assert_eq!(signature_parts(&good).unwrap(), Vec::<String>::new());
        let bad = parts(r#"[{"type":"image","mimeType":"image/png","url":"https://x/y.png"}]"#);
        assert_eq!(
            signature_parts(&bad).unwrap_err().to_string(),
            "Claude image inputs require a matching base64 data URL"
        );
    }

    #[test]
    fn a_mention_the_command_runner_did_not_resolve_is_refused_with_its_bytes() {
        let refused = parts(r#"[{"type":"mention","entryId":"e","kind":"skill","name":"Review"}]"#);
        assert_eq!(
            content(&refused).unwrap_err().to_string(),
            "Unresolved Claude mention"
        );
    }
}
