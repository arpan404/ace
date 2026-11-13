//! Pure mapping from MCP tool listings and call results to Spade's own types. No I/O.

use serde_json::{Map, Value};

/// How much a tool can change. Spade's approval gate asks before `Write` and `Destructive`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Risk {
    /// Only reads. The server said so (`readOnlyHint: true`).
    Read,
    /// May change something. What an unlabelled tool is.
    Write,
    /// May delete or overwrite something (`destructiveHint: true`).
    Destructive,
}

/// One tool a server lists, as Spade offers it to a model.
#[derive(Debug, Clone, PartialEq)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    /// The tool's JSON Schema for its arguments, as the server sent it.
    pub input_schema: Value,
    pub risk: Risk,
    /// The server sent annotations for it at all. A tool that says nothing about itself is one
    /// Spade can't classify (ADR 0144).
    pub annotated: bool,
    /// `openWorldHint`: it reaches beyond the server's own data.
    pub open_world: Option<bool>,
}

/// One piece of a tool's answer. `extra` holds every field of the block besides the ones read
/// (`_meta`, `annotations`, fields added later), as sent.
#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text {
        text: String,
        extra: Map<String, Value>,
    },
    /// Base64 data with its MIME type, as sent.
    Image {
        mime_type: String,
        data: String,
        extra: Map<String, Value>,
    },
    /// Anything else (audio, resources, links, kinds added later, malformed blocks), as sent.
    Other(Value),
}

impl Part {
    /// A text part with no other fields.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            extra: Map::new(),
        }
    }
}

/// What a tool call returned. `is_error` means the tool ran and reported a failure; the model
/// should see the parts. Protocol and transport failures are `ToolsError`s instead.
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolResult {
    pub parts: Vec<Part>,
    pub is_error: bool,
    /// `structuredContent`, when the tool sent one.
    pub structured: Option<Value>,
    /// Every other field of the result (`_meta`, extensions, fields added later), as sent.
    pub extra: Map<String, Value>,
}

/// Annotations are hints from the server. Destructive wins over read-only when a server sends
/// both, and a tool that says nothing is a write.
pub fn risk(read_only: Option<bool>, destructive: Option<bool>) -> Risk {
    match (read_only, destructive) {
        (_, Some(true)) => Risk::Destructive,
        (Some(true), _) => Risk::Read,
        _ => Risk::Write,
    }
}

pub(crate) fn tool(tool: &rmcp::model::Tool) -> McpTool {
    let annotations = tool.annotations.as_ref();
    McpTool {
        name: tool.name.to_string(),
        description: tool
            .description
            .as_deref()
            .or(tool.title.as_deref())
            .unwrap_or_default()
            .to_owned(),
        input_schema: Value::Object(tool.input_schema.as_ref().clone()),
        risk: risk(
            annotations.and_then(|a| a.read_only_hint),
            annotations.and_then(|a| a.destructive_hint),
        ),
        annotated: annotations.is_some_and(|a| {
            a.read_only_hint.is_some()
                || a.destructive_hint.is_some()
                || a.open_world_hint.is_some()
        }),
        open_world: annotations.and_then(|a| a.open_world_hint),
    }
}

/// Reads a `tools/call` result from its JSON. Unknown content kinds and malformed blocks become
/// `Part::Other`, and unread fields stay in `extra`; nothing is dropped.
pub fn call_result(value: Value) -> McpToolResult {
    let Value::Object(mut object) = value else {
        return McpToolResult {
            parts: vec![Part::Other(value)],
            is_error: false,
            structured: None,
            extra: Map::new(),
        };
    };
    let is_error = match object.remove("isError") {
        Some(Value::Bool(flag)) => flag,
        Some(other) => {
            object.insert("isError".into(), other);
            false
        }
        None => false,
    };
    let structured = object.remove("structuredContent");
    let parts = match object.remove("content") {
        Some(Value::Array(blocks)) => blocks.into_iter().map(part).collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(other) => vec![Part::Other(other)],
    };
    McpToolResult {
        parts,
        is_error,
        structured,
        extra: object,
    }
}

fn part(block: Value) -> Part {
    let Value::Object(mut fields) = block else {
        return Part::Other(block);
    };
    let kind = fields
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match kind.as_deref() {
        Some("text") if is_text(&fields, "text") => {
            let text = take_text(&mut fields, "text");
            fields.remove("type");
            Part::Text {
                text,
                extra: fields,
            }
        }
        Some("image") if is_text(&fields, "mimeType") && is_text(&fields, "data") => {
            let mime_type = take_text(&mut fields, "mimeType");
            let data = take_text(&mut fields, "data");
            fields.remove("type");
            Part::Image {
                mime_type,
                data,
                extra: fields,
            }
        }
        _ => Part::Other(Value::Object(fields)),
    }
}

fn is_text(fields: &Map<String, Value>, key: &str) -> bool {
    fields.get(key).is_some_and(Value::is_string)
}

fn take_text(fields: &mut Map<String, Value>, key: &str) -> String {
    match fields.remove(key) {
        Some(Value::String(text)) => text,
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hints_decide_risk_and_silence_means_write() {
        let cases = [
            (None, None, Risk::Write),
            (Some(false), None, Risk::Write),
            (Some(true), None, Risk::Read),
            (Some(true), Some(false), Risk::Read),
            (None, Some(true), Risk::Destructive),
            (Some(false), Some(true), Risk::Destructive),
            (Some(true), Some(true), Risk::Destructive),
            (None, Some(false), Risk::Write),
        ];
        for (read_only, destructive, expected) in cases {
            assert_eq!(
                risk(read_only, destructive),
                expected,
                "{read_only:?} {destructive:?}"
            );
        }
    }

    #[test]
    fn unknown_and_malformed_content_is_kept_raw() {
        let result = call_result(json!({
            "content": [
                {"type": "text", "text": "hi"},
                {"type": "image", "mimeType": "image/png", "data": "iVBO"},
                {"type": "hologram", "beam": 3},
                {"type": "text"},
                {"type": "image", "data": "x"},
                {"type": "audio", "mimeType": "audio/wav", "data": "UklG"},
                7
            ],
            "isError": true,
            "structuredContent": {"ok": false}
        }));
        assert!(result.is_error);
        assert_eq!(result.structured, Some(json!({"ok": false})));
        assert_eq!(
            result.parts,
            vec![
                Part::text("hi"),
                Part::Image {
                    mime_type: "image/png".into(),
                    data: "iVBO".into(),
                    extra: Map::new(),
                },
                Part::Other(json!({"type": "hologram", "beam": 3})),
                Part::Other(json!({"type": "text"})),
                Part::Other(json!({"type": "image", "data": "x"})),
                Part::Other(json!({"type": "audio", "mimeType": "audio/wav", "data": "UklG"})),
                Part::Other(json!(7)),
            ]
        );
    }

    #[test]
    fn a_result_without_content_or_not_an_object_still_reads() {
        assert_eq!(call_result(json!({})).parts, vec![]);
        assert_eq!(
            call_result(json!({"content": "loose"})).parts,
            vec![Part::Other(json!("loose"))]
        );
        assert_eq!(
            call_result(json!("odd")).parts,
            vec![Part::Other(json!("odd"))]
        );
    }
}
