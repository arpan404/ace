// SPDX-License-Identifier: Apache-2.0
//! Codex MCP tool approvals: a yes/no approval, never a form.

use ace_json::{JsString, Map, Value, utf16_len};

use super::helpers::{list_of, obj_map, str_empty};

fn extract_tool_name(message: &str) -> Option<String> {
    // `run tool "name"` with 1..256 chars, as the TypeScript regex does.
    let prefix = "run tool \"";
    let start = message.find(prefix)?;
    let rest = &message[start + prefix.len()..];
    let end = rest.find('"')?;
    let name = &rest[..end];
    if (1..=256).contains(&utf16_len(name)) {
        Some(name.to_owned())
    } else {
        None
    }
}

/// The tool a Codex MCP approval is for: metadata, else the name in its message.
fn tool_name(message: &str, meta: &Map) -> Option<JsString> {
    match meta.get("tool_name") {
        Some(Value::String(name)) => Some(name.clone()),
        _ => extract_tool_name(message).map(JsString::from),
    }
}

fn approval_target(tool: &JsString, params: Option<&Value>) -> Option<Value> {
    if !(1..=256).contains(&tool.len_code_points()) {
        return None;
    }
    let mut map = Map::with_capacity(3);
    map.insert("tool".to_owned(), Value::from(tool.to_owned()));
    map.insert("access".to_owned(), Value::from("unknown".to_owned()));
    if let Some(input) = params {
        map.insert("input".to_owned(), input.clone());
    }
    Some(Value::Object(map))
}

/// A Codex MCP tool approval as an ace approval request; else an elicitation.
pub fn mcp_tool_approval(params: &Value) -> Option<Value> {
    let map = obj_map(params);
    let server = match map.get("serverName") {
        Some(Value::String(s)) if (1..=256).contains(&s.len_code_points()) => s.clone(),
        _ => return None,
    };
    let message = match map.get("message") {
        Some(Value::String(s)) if s.len_code_points() <= 8192 => s.clone(),
        _ => return None,
    };
    let meta_value = map.get("_meta")?;
    let meta = obj_map(meta_value);
    if str_empty(meta.get("codex_approval_kind")) != "mcp_tool_call" {
        return None;
    }
    let persist: Vec<String> = match meta.get("persist") {
        None => Vec::new(),
        Some(Value::String(s)) if s == "session" || s == "always" => vec![String::from(s.clone())],
        Some(Value::Array(items)) => {
            if items.len() > 8 {
                return None;
            }
            let mut out = Vec::new();
            for item in items {
                match item {
                    Value::String(s) => out.push(s.to_string()),
                    _ => return None,
                }
            }
            out
        }
        _ => return None,
    };
    match meta.get("tool_name") {
        None => {}
        Some(Value::String(name)) if (1..=256).contains(&name.len_code_points()) => {}
        _ => return None,
    }
    match meta.get("tool_title") {
        None => {}
        Some(Value::String(title)) if title.len_code_points() <= 1024 => {}
        _ => return None,
    }
    let tool_params = meta.get("tool_params").cloned();
    let tool = tool_name(&message, meta);
    let scopes_has_session = persist.iter().any(|s| s == "session");
    let mut options = Vec::with_capacity(4);
    options.push(approval_option("accept", "Allow once", "allow_once"));
    if scopes_has_session {
        options.push(approval_option(
            "accept_session",
            "Allow for this thread",
            "allow_session",
        ));
    }
    options.push(approval_option("decline", "Deny", "deny"));
    options.push(approval_option("cancel", "Cancel", "cancel"));
    let title = meta
        .get("tool_title")
        .and_then(Value::as_js_str)
        .cloned()
        .or(tool.clone())
        .unwrap_or_else(|| message.clone());
    let mut request = Map::with_capacity(6);
    request.insert("kind".to_owned(), Value::from("approval".to_owned()));
    request.insert("title".to_owned(), Value::from(title));
    request.insert("description".to_owned(), Value::String(message));
    if let Some(tool) = tool
        && let Some(target) = approval_target(&tool, tool_params.as_ref())
    {
        request.insert("target".to_owned(), target);
    }
    request.insert("options".to_owned(), Value::from(options));
    let mut mcp_server = Map::with_capacity(2);
    mcp_server.insert("name".to_owned(), Value::String(server));
    mcp_server.insert("source".to_owned(), Value::from("codex".to_owned()));
    request.insert("mcpServer".to_owned(), Value::Object(mcp_server));
    Some(Value::Object(request))
}

fn approval_option(id: &str, label: &str, kind: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("id".to_owned(), Value::from(id.to_owned()));
    map.insert("label".to_owned(), Value::from(label.to_owned()));
    map.insert("kind".to_owned(), Value::from(kind.to_owned()));
    Value::Object(map)
}

pub fn is_mcp_approval_request(method: &str, params: &Value) -> bool {
    if method != "mcpServer/elicitation/request" {
        return false;
    }
    mcp_tool_approval(params).is_some()
}

/// Whether `list` holds only strings for the tool-title path (unused helper).
#[allow(dead_code)]
pub fn _list_strings(value: Option<&Value>) -> bool {
    list_of(value).iter().all(|v| v.is_string())
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn mcp_approval_metadata_bounds_count_code_points() {
        for (field, limit) in [
            ("serverName", 256),
            ("message", 8192),
            ("tool_name", 256),
            ("tool_title", 1024),
        ] {
            for length in [limit, limit + 1] {
                let mut approval = ace_json::parse(r#"{"serverName":"srv","message":"run tool \"name\"","_meta":{"codex_approval_kind":"mcp_tool_call"}}"#).expect("approval");
                let map = approval.as_object_mut().expect("object");
                let target = if field.starts_with("tool_") {
                    map.get_mut("_meta")
                        .and_then(Value::as_object_mut)
                        .expect("metadata")
                } else {
                    map
                };
                target.insert(field, Value::from("😀".repeat(length)));
                let request = mcp_tool_approval(&approval);
                assert_eq!(request.is_some(), length == limit, "{field}");
                if let Some(request) = request
                    && field == "tool_name"
                {
                    assert_eq!(
                        request.get("target").and_then(|target| target.get("tool")),
                        Some(&Value::from("😀".repeat(length)))
                    );
                }
            }
        }
    }
}
