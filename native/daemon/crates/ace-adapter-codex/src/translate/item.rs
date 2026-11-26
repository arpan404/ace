// SPDX-License-Identifier: Apache-2.0
//! Items: content parts, tool drafts and item drafts, same JSON as TypeScript.

use ace_json::{Map, Value, utf16_len};

use super::command::command_detail;
use super::content::{content, file_change, raw_array, raw_for};
use super::helpers::{list_of, obj_map, str_empty};

pub fn tool_draft(
    detail: Value,
    title: &str,
    data: &Value,
    status: &str,
    item_type: &str,
    name: Option<&Value>,
) -> Value {
    let complete = !matches!(status, "running" | "pending" | "awaiting_approval");
    let detail_kind = obj_map(&detail)
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let mut call = Map::with_capacity(6);
    call.insert("kind".to_owned(), Value::from(detail_kind));
    call.insert("title".to_owned(), Value::from(title.to_owned()));
    call.insert("detail".to_owned(), detail);
    call.insert("status".to_owned(), Value::from(status.to_owned()));
    call.insert("raw".to_owned(), raw_for(item_type, data, name));
    if item_type == "mcpToolCall" {
        let message = obj_map(data)
            .get("error")
            .map(obj_map)
            .and_then(|m| m.get("message"))
            .and_then(Value::as_js_str)
            .filter(|message| !message.is_empty());
        if let Some(message) = message {
            let truncated = message.slice_units(0, 4096);
            call.insert("error".to_owned(), Value::from(truncated));
        }
    }
    let mut draft = Map::with_capacity(3);
    draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(complete));
    draft.insert("call".to_owned(), Value::Object(call));
    Value::Object(draft)
}

/// `itemDraft(item, complete)`: the same draft JSON the TypeScript builds.
pub fn item_draft(item: &Map, complete: bool, item_value: &Value) -> Value {
    let item_type = str_empty(item.get("type"));
    if item_type == "userMessage" {
        let client_id = str_empty(item.get("clientId"));
        let mut draft = Map::with_capacity(6);
        draft.insert("type".to_owned(), Value::from("message".to_owned()));
        draft.insert("role".to_owned(), Value::from("user".to_owned()));
        if !client_id.is_empty() && utf16_len(client_id) <= 256 {
            draft.insert("nativeId".to_owned(), Value::from(client_id.to_owned()));
        }
        draft.insert("parts".to_owned(), content(item.get("content")));
        draft.insert("complete".to_owned(), Value::Bool(complete));
        draft.insert("raw".to_owned(), raw_array(item_type, item_value, None));
        return Value::Object(draft);
    }
    if item_type == "agentMessage" {
        let delivery = str_empty(item.get("delivery"));
        if delivery == "async" && !list_of(item.get("questions")).is_empty() {
            let text = str_empty(item.get("text"));
            let title = if text.is_empty() { "Question" } else { text };
            let status = if complete { "succeeded" } else { "running" };
            let mut detail = Map::with_capacity(1);
            detail.insert("kind".to_owned(), Value::from("ask_user".to_owned()));
            return tool_draft(
                Value::Object(detail),
                title,
                item_value,
                status,
                item_type,
                None,
            );
        }
        let mut draft = Map::with_capacity(5);
        draft.insert("type".to_owned(), Value::from("message".to_owned()));
        draft.insert("role".to_owned(), Value::from("assistant".to_owned()));
        let mut part = Map::with_capacity(2);
        part.insert("type".to_owned(), Value::from("text".to_owned()));
        part.insert(
            "text".to_owned(),
            Value::from(str_empty(item.get("text")).to_owned()),
        );
        draft.insert("parts".to_owned(), Value::from(vec![Value::Object(part)]));
        draft.insert("complete".to_owned(), Value::Bool(complete));
        draft.insert("raw".to_owned(), raw_array(item_type, item_value, None));
        return Value::Object(draft);
    }
    if item_type == "reasoning" {
        let mut texts: Vec<&str> = Vec::new();
        for v in list_of(item.get("summary")) {
            if let Value::String(s) = v {
                texts.push(s.as_str());
            }
        }
        for v in list_of(item.get("content")) {
            if let Value::String(s) = v {
                texts.push(s.as_str());
            }
        }
        let mut draft = Map::with_capacity(5);
        draft.insert("type".to_owned(), Value::from("reasoning".to_owned()));
        draft.insert("text".to_owned(), Value::from(texts.join("\n")));
        draft.insert("summary".to_owned(), Value::Bool(true));
        draft.insert("complete".to_owned(), Value::Bool(complete));
        draft.insert("raw".to_owned(), raw_array(item_type, item_value, None));
        return Value::Object(draft);
    }
    let native_status = str_empty(item.get("status"));
    let success_false = matches!(item.get("success"), Some(Value::Bool(false)));
    let status = if !complete {
        "running"
    } else if native_status == "failed" || success_false {
        "failed"
    } else if native_status == "declined" {
        "declined"
    } else {
        "succeeded"
    };
    let mut title = item_type.to_owned();
    let mut name: Option<&Value> = item.get("name");
    let detail = if item_type == "commandExecution" {
        let detail = command_detail(item, item_value);
        let command = if obj_map(&detail).get("kind").and_then(|v| v.as_str()) == Some("shell") {
            str_empty(obj_map(&detail).get("command")).to_owned()
        } else {
            let first = list_of(item.get("commandActions")).first().map(obj_map);
            let first_command = first
                .and_then(|m| m.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if first_command.is_empty() {
                str_empty(item.get("command")).to_owned()
            } else {
                first_command.to_owned()
            }
        };
        title = format!("Run {command}");
        detail
    } else if item_type == "fileChange" {
        let changes: Vec<Value> = list_of(item.get("changes"))
            .iter()
            .map(file_change)
            .collect();
        let kind = changes
            .first()
            .map(obj_map)
            .and_then(|m| m.get("kind"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let detail_kind = match kind {
            "add" => "file.write",
            "delete" => "file.delete",
            "move" => "file.move",
            _ => "file.edit",
        };
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::from(detail_kind.to_owned()));
        detail.insert("changes".to_owned(), Value::from(changes));
        Value::Object(detail)
    } else if item_type == "mcpToolCall" {
        name = item.get("tool");
        let mut detail = Map::with_capacity(4);
        detail.insert("kind".to_owned(), Value::from("mcp".to_owned()));
        detail.insert(
            "server".to_owned(),
            Value::from(str_empty(item.get("server")).to_owned()),
        );
        detail.insert("tool".to_owned(), Value::from(str_empty(name).to_owned()));
        detail.insert(
            "arguments".to_owned(),
            item.get("arguments").cloned().unwrap_or(Value::Null),
        );
        Value::Object(detail)
    } else if item_type == "collabAgentToolCall" {
        name = item.get("tool");
        let tool = str_empty(name).to_owned();
        let child = list_of(item.get("receiverThreadIds"))
            .first()
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        title = tool.clone();
        if tool == "spawnAgent" {
            let mut detail = Map::with_capacity(3);
            detail.insert("kind".to_owned(), Value::from("agent.spawn".to_owned()));
            if !child.is_empty() {
                detail.insert("childAgent".to_owned(), Value::from(child));
            }
            detail.insert(
                "prompt".to_owned(),
                Value::from(str_empty(item.get("prompt")).to_owned()),
            );
            Value::Object(detail)
        } else {
            let mut detail = Map::with_capacity(3);
            detail.insert("kind".to_owned(), Value::from("agent.message".to_owned()));
            if !child.is_empty() {
                detail.insert("targetAgent".to_owned(), Value::from(child));
            }
            detail.insert(
                "message".to_owned(),
                Value::from(str_empty(item.get("prompt")).to_owned()),
            );
            Value::Object(detail)
        }
    } else if item_type == "plan" {
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::from("plan".to_owned()));
        detail.insert(
            "markdown".to_owned(),
            Value::from(str_empty(item.get("text")).to_owned()),
        );
        Value::Object(detail)
    } else if item_type == "webSearch" {
        let action = item.get("action").map(obj_map);
        let action_type = action
            .and_then(|m| m.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if action_type == "search" {
            let query = action
                .and_then(|m| m.get("query"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let queries: Vec<&str> = action
                .map(|m| list_of(m.get("queries")))
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            let joined = queries.join(";");
            let query = if query.is_empty() {
                joined
            } else {
                query.to_owned()
            };
            let mut detail = Map::with_capacity(2);
            detail.insert("kind".to_owned(), Value::from("web.search".to_owned()));
            detail.insert("query".to_owned(), Value::from(query));
            Value::Object(detail)
        } else {
            let url = action
                .and_then(|m| m.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            let mut detail = Map::with_capacity(2);
            detail.insert("kind".to_owned(), Value::from("web.fetch".to_owned()));
            detail.insert("url".to_owned(), Value::from(url));
            Value::Object(detail)
        }
    } else if item_type == "imageView" || item_type == "imageGeneration" {
        let path = if item_type == "imageView" {
            str_empty(item.get("path"))
        } else {
            str_empty(item.get("savedPath"))
        }
        .to_owned();
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::from("image".to_owned()));
        if !path.is_empty() {
            detail.insert("path".to_owned(), Value::from(path));
        }
        title = if item_type == "imageView" {
            "Viewed image".to_owned()
        } else {
            "Generated image".to_owned()
        };
        Value::Object(detail)
    } else {
        if item_type == "dynamicToolCall" {
            name = item.get("tool");
        }
        let mut detail = Map::with_capacity(1);
        detail.insert("kind".to_owned(), Value::from("custom".to_owned()));
        Value::Object(detail)
    };
    tool_draft(detail, &title, item_value, status, item_type, name)
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn an_mcp_tool_error_can_end_with_half_an_emoji() {
        for prefix in [4094, 4095] {
            let message = format!("{}😀", "x".repeat(prefix));
            let data = ace_json::json!({"error": {"message": message}});
            let draft = tool_draft(Value::Null, "mcp", &data, "failed", "mcpToolCall", None);
            let error = draft
                .get("call")
                .and_then(|call| call.get("error"))
                .and_then(Value::as_js_str)
                .expect("error");
            assert_eq!(error.len_utf16(), 4096);
            assert_eq!(
                error.units().last(),
                Some(if prefix == 4094 { 0xde00 } else { 0xd83d })
            );
        }
    }
}
