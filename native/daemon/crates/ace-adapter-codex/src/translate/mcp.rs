// SPDX-License-Identifier: Apache-2.0
//! Codex MCP tool approvals: a yes/no approval, never a form.

use ace_json::{Map, Value};

use super::helpers::{list_of, obj_map, str_empty};

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn valid_tool_name(name: &str) -> bool {
    let units = name.encode_utf16().count();
    (1..=256).contains(&units)
}

fn extract_tool_name(message: &str) -> Option<String> {
    // `run tool "name"` with 1..256 chars, as the TypeScript regex does.
    let prefix = "run tool \"";
    let start = message.find(prefix)?;
    let rest = &message[start + prefix.len()..];
    let end = rest.find('"')?;
    let name = &rest[..end];
    if name.encode_utf16().count() >= 1 && name.encode_utf16().count() <= 256 {
        Some(name.to_owned())
    } else {
        None
    }
}

/// The tool a Codex MCP approval is for: metadata, else the name in its message.
fn tool_name(server: &str, message: &str, meta: &Map) -> Option<String> {
    let _ = server;
    if let Some(Value::String(name)) = meta.get("tool_name")
        && valid_tool_name(name)
    {
        return Some(String::from(name.clone()));
    }
    extract_tool_name(message)
}

fn approval_target(tool: &str, params: Option<&Value>) -> Option<Value> {
    if tool.encode_utf16().count() < 1 || tool.encode_utf16().count() > 256 {
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
        Some(Value::String(s)) if utf16_len(s) >= 1 && utf16_len(s) <= 256 => s.clone(),
        _ => return None,
    };
    let message = match map.get("message") {
        Some(Value::String(s)) if s.len() <= 8192 => s.clone(),
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
    if let Some(Value::String(title)) = meta.get("tool_title")
        && title.encode_utf16().count() > 1024
    {
        return None;
    }
    let tool_params = meta.get("tool_params").cloned();
    let tool = tool_name(&server, &message, meta);
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
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .or(tool.clone())
        .unwrap_or_else(|| String::from(message.clone()));
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
