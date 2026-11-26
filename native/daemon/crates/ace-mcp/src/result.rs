// SPDX-License-Identifier: Apache-2.0
//! A tool call's result as the MCP wire carries it: text content, optional structured content and
//! the error flag. Written with `ace-json` in the order `registry.ts` builds it.

use ace_json::{JsString, Map, Value};

/// One content block. Only text is produced today; images arrive with the image families.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Content {
    pub kind: &'static str,
    pub text: String,
}

impl Content {
    pub fn text(text: impl Into<String>) -> Content {
        Content {
            kind: "text",
            text: text.into(),
        }
    }
}

/// `CallToolResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct CallToolResult {
    pub is_error: bool,
    pub content: Vec<Content>,
    pub structured: Option<Value>,
}

impl CallToolResult {
    /// A structured success: the text is the exact JSON of the checked value.
    pub fn success(structured: Value) -> CallToolResult {
        CallToolResult {
            is_error: false,
            content: vec![Content::text(ace_json::to_string(&structured))],
            structured: Some(structured),
        }
    }

    /// A structured result, failed when the tool's own `failed` rule says so.
    pub fn structured(is_error: bool, structured: Value) -> CallToolResult {
        CallToolResult {
            is_error,
            content: vec![Content::text(ace_json::to_string(&structured))],
            structured: Some(structured),
        }
    }

    /// A failure the agent reads, and the client shows as failed.
    pub fn failure(text: impl Into<String>) -> CallToolResult {
        CallToolResult {
            is_error: true,
            content: vec![Content::text(text)],
            structured: None,
        }
    }

    /// `{isError?, content, structuredContent?}`, in the TypeScript's key order.
    pub fn to_json(&self) -> Value {
        let mut map = Map::with_capacity(3);
        if self.is_error {
            map.insert("isError", Value::Bool(true));
        }
        map.insert(
            "content",
            Value::Array(
                self.content
                    .iter()
                    .map(|content| {
                        let mut block = Map::with_capacity(2);
                        block.insert("type", Value::from(content.kind));
                        block.insert("text", Value::String(JsString::from(content.text.as_str())));
                        Value::Object(block)
                    })
                    .collect::<Vec<_>>()
                    .into(),
            ),
        );
        if let Some(structured) = &self.structured {
            map.insert("structuredContent", structured.clone());
        }
        Value::Object(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_json::parse;

    #[test]
    fn a_success_carries_its_structured_value_as_exact_json_text() {
        let structured = parse("{\"value\":\"accepted\"}").expect("json");
        let result = CallToolResult::success(structured);
        assert_eq!(
            result.to_json(),
            parse("{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"value\\\":\\\"accepted\\\"}\"}],\"structuredContent\":{\"value\":\"accepted\"}}")
                .expect("json")
        );
        assert!(!result.is_error);
    }

    #[test]
    fn a_failure_puts_is_error_first_and_carries_no_structured_content() {
        let result = CallToolResult::failure("no");
        assert_eq!(
            ace_json::to_string(&result.to_json()),
            "{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"no\"}]}"
        );
    }
}
