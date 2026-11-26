// SPDX-License-Identifier: Apache-2.0
//! The ace tool recognition of `ace-tools.ts`: which calls are ace's, what
//! they ran, and the redaction of private input before native evidence is
//! stored. Operates on transient JSON values (drafts), never on stored
//! state; the one exception is `normalize_ace_call` merging a previous
//! typed call.

use crate::entity_model::InteractionRequest;
use crate::item_model::{ToolCall, ToolDetail};
use crate::json_io::{Json, Map};

/// The dispatch tool that runs any ace tool by name.
pub const ACE_TOOL_DISPATCH: &str = "tools_call";
const ACE_TOOL_SEARCH: &str = "tools_find";

/// The bare name of any spelling of an ace tool.
pub fn bare_tool_name(name: &str) -> String {
    let mut bare = if let Some(rest) = name.strip_prefix("mcp__ace__") {
        rest
    } else {
        name
    };
    while let Some(rest) = bare.strip_prefix("ace_") {
        bare = rest;
    }
    bare.to_owned()
}

fn valid_tool_name(bare: &str) -> bool {
    let bytes = bare.as_bytes();
    if bytes.is_empty() || bytes.len() > 101 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn is_namespaced(name: &str) -> bool {
    name.starts_with("mcp__ace__") || name.starts_with("ace_")
}

fn bare_family(bare: &str) -> bool {
    const SCREEN: &[&str] = &[
        "open_app",
        "windows",
        "ui_tree",
        "ui_act",
        "input",
        "screenshot",
        "measure",
        "apps",
        "state",
        "act",
    ];
    const BROWSER: &[&str] = &[
        "open",
        "snapshot",
        "act",
        "wait_for",
        "find",
        "screenshot",
        "logs",
        "evaluate",
        "history",
        "settings",
        "measure",
    ];
    const SIM: &[&str] = &["list", "start", "stop", "ui", "act", "screenshot", "logs"];
    const FAMILIES: &[(&str, &[&str])] =
        &[("browser_", BROWSER), ("screen_", SCREEN), ("sim_", SIM)];
    FAMILIES.iter().any(|(prefix, names)| {
        bare.strip_prefix(prefix)
            .is_some_and(|rest| names.contains(&rest))
    })
}

/// The bare name of an un-namespaced call when it is one of ace's.
pub fn ace_tool_name(name: &str) -> Option<String> {
    let bare = bare_tool_name(name);
    if !valid_tool_name(&bare) {
        return None;
    }
    if is_namespaced(name) {
        return Some(bare);
    }
    if bare_family(&bare) {
        return Some(bare);
    }
    None
}

/// An ace MCP detail names the tool unless another server owns it.
fn ace_mcp_tool_name(server: Option<&str>, tool: Option<&str>) -> Option<String> {
    if !matches!(server.unwrap_or(""), "ace" | "unknown" | "") {
        return None;
    }
    let bare = bare_tool_name(tool.unwrap_or(""));
    if valid_tool_name(&bare) {
        Some(bare)
    } else {
        None
    }
}

fn as_object(value: &Json) -> Option<&Map> {
    match value {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn get_str<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|value| value.as_str())
}

/// The call a `tools_call` runs: its target's bare name and arguments.
pub fn dispatched_ace_call(name: &str, input: &Json) -> (String, Json) {
    if bare_tool_name(name) != ACE_TOOL_DISPATCH {
        return (name.to_owned(), input.clone());
    }
    let Some(map) = as_object(input) else {
        return (name.to_owned(), input.clone());
    };
    let Some(target) = get_str(map, "name") else {
        return (name.to_owned(), input.clone());
    };
    let bare = bare_tool_name(target);
    if bare == ACE_TOOL_DISPATCH || bare == ACE_TOOL_SEARCH {
        return (name.to_owned(), input.clone());
    }
    let args = map.get("arguments").cloned().unwrap_or(Json::Null);
    (bare, args)
}

/// The ace tool a call ran and its input.
pub fn ace_tool_input(call: &Map) -> Option<(String, Json)> {
    let (name, input) = called_ace_tool(call)?;
    Some(dispatched_ace_call(&name, &input))
}

fn called_ace_tool(call: &Map) -> Option<(String, Json)> {
    let detail = call.get("detail");
    let detail_kind = detail
        .and_then(as_object)
        .and_then(|detail| get_str(detail, "kind"));
    let call_kind = get_str(call, "kind");
    if detail_kind == Some("mcp") {
        let detail_map = detail.and_then(as_object);
        let server = detail_map.and_then(|map| get_str(map, "server"));
        let tool = detail_map.and_then(|map| get_str(map, "tool"));
        let name = ace_mcp_tool_name(server, tool)?;
        let arguments = detail_map
            .and_then(|map| map.get("arguments"))
            .cloned()
            .unwrap_or(Json::Null);
        return Some((name, arguments));
    }
    if detail_kind != Some("custom") && call_kind != Some("custom") {
        return None;
    }
    let title = get_str(call, "title").unwrap_or("");
    let mut pending: std::collections::VecDeque<(Json, usize, bool)> = call
        .get("raw")
        .and_then(|raw| raw.as_array())
        .map(|raw| {
            raw.iter()
                .rev()
                .filter_map(|payload| payload.get("data").map(|data| (data.clone(), 0, false)))
                .collect()
        })
        .unwrap_or_default();
    let mut visited = 0;
    while !pending.is_empty() && visited < 64 {
        visited += 1;
        let Some((entry, depth, input_json)) = pending.pop_front() else {
            break;
        };
        let Some(data) = as_object(&entry) else {
            continue;
        };
        let label = ["toolName", "name", "nativeName", "title", "_toolName"]
            .iter()
            .filter_map(|key| get_str(data, key))
            .find(|label| ace_tool_name(label).is_some());
        let name = label
            .and_then(ace_tool_name)
            .or_else(|| ace_tool_name(title));
        let mut input = data
            .get("arguments")
            .or_else(|| data.get("args"))
            .or_else(|| data.get("input"))
            .or_else(|| data.get("rawInput"))
            .or_else(|| data.get("currentInput"))
            .or_else(|| {
                data.get("state")
                    .and_then(as_object)
                    .and_then(|state| state.get("input"))
            })
            .cloned();
        if input.is_none()
            && name.is_some()
            && input_json
            && let Some(text) = get_str(data, "text")
            && ace_json::utf16_len(text) <= 65_536
            && let Ok(parsed) = ace_json::parse(text)
            && let Some(record) = as_object(&parsed)
        {
            input = Some(Json::Object(record.clone()));
        }
        if let (Some(name), Some(resolved)) = (name, input) {
            let returned = match as_object(&resolved) {
                Some(record) => match record.get("args") {
                    Some(args) => args.clone(),
                    None => resolved.clone(),
                },
                None => resolved.clone(),
            };
            return Some((name, returned));
        }
        if depth < 5 {
            for key in [
                "initialFrame",
                "toolCall",
                "update",
                "params",
                "body",
                "data",
            ] {
                if let Some(nested) = data.get(key) {
                    let nested_input_json = data
                        .get("type")
                        .and_then(|kind| kind.as_str())
                        .is_some_and(|kind| kind == "session.tool.input.ended");
                    pending.push_front((nested.clone(), depth + 1, nested_input_json));
                }
            }
        }
    }
    let title_name = ace_tool_name(title)?;
    Some((title_name, Json::Object(Map::new())))
}

/// Whether a call's input is typed text or markup that must never be stored.
pub fn private_ace_input(tool: &str, input: &Json) -> bool {
    let (name, resolved) = dispatched_ace_call(tool, input);
    let bare = bare_tool_name(&name);
    let payload = as_object(&resolved);
    let action = payload
        .and_then(|payload| payload.get("action").or_else(|| payload.get("interaction")))
        .and_then(as_object);
    if bare.ends_with("_measure")
        && action.is_some_and(|action| action.contains_key("text") || action.contains_key("value"))
    {
        return true;
    }
    if matches!(bare.as_str(), "html_render" | "html_preview" | "image_show") {
        return true;
    }
    if bare == "screen_act" {
        let actions = payload.and_then(|payload| payload.get("actions"));
        return actions
            .and_then(|actions| actions.as_array())
            .is_some_and(|actions| actions.iter().any(private_step));
    }
    if !["screen_input", "screen_ui_act", "sim_act", "browser_act"].contains(&bare.as_str()) {
        return false;
    }
    let Some(payload) = payload else {
        return false;
    };
    ["text", "value", "promptText"]
        .iter()
        .any(|key| payload.contains_key(*key))
}

/// Computer-use steps that carry typed text.
fn private_step(entry: &Json) -> bool {
    let Some(step) = as_object(entry) else {
        return false;
    };
    step.get("type")
        .and_then(|kind| kind.as_str())
        .is_some_and(|kind| matches!(kind, "type" | "paste" | "set_value" | "select_text"))
}

/// Redact private input, keeping the call's shape.
pub fn redact_ace_arguments(name: &str, value: &Json) -> Json {
    if !private_ace_input(name, value) {
        return value.clone();
    }
    let (call_name, call_input) = dispatched_ace_call(name, value);
    if bare_tool_name(name) == ACE_TOOL_DISPATCH && call_name != name {
        let redacted = redact_ace_arguments(&call_name, &call_input);
        let mut merged = Map::new();
        if let Some(record) = as_object(value) {
            merged.extend(record.clone());
        }
        merged.insert("arguments".to_owned(), redacted);
        return Json::Object(merged);
    }
    let Some(record) = as_object(value) else {
        return Json::Object(Map::from_iter([("redacted".to_owned(), Json::Bool(true))]));
    };
    let bare = bare_tool_name(&call_name);
    let keys: &[&str] = if bare == "image_show" {
        &["data", "alt", "caption"]
    } else {
        &["text", "value", "html", "title", "promptText"]
    };
    let mut redacted = Map::new();
    for (key, child) in record.iter() {
        if keys.contains(&key.as_str()) {
            redacted.insert(key.clone(), Json::from("[redacted]".to_owned()));
        } else {
            redacted.insert(key.clone(), child.clone());
        }
    }
    if let Some(actions) = redacted
        .get("actions")
        .and_then(|value| value.as_array())
        .cloned()
    {
        let mut cleaned = Vec::with_capacity(actions.len());
        for entry in actions {
            if !private_step(&entry) {
                cleaned.push(entry);
                continue;
            }
            let mut step = Map::new();
            if let Some(record) = as_object(&entry) {
                for (key, child) in record.iter() {
                    if ["text", "value", "prefix", "suffix"].contains(&key.as_str()) {
                        step.insert(key.clone(), Json::from("[redacted]".to_owned()));
                    } else {
                        step.insert(key.clone(), child.clone());
                    }
                }
            }
            cleaned.push(Json::Object(step));
        }
        redacted.insert("actions".to_owned(), Json::from(cleaned));
    }
    for field in ["action", "interaction"] {
        if let Some(nested) = redacted.get(field).and_then(as_object).cloned() {
            let mut cleaned = Map::new();
            for (key, child) in nested.iter() {
                if ["text", "value", "html", "title", "promptText"].contains(&key.as_str()) {
                    cleaned.insert(key.clone(), Json::from("[redacted]".to_owned()));
                } else {
                    cleaned.insert(key.clone(), child.clone());
                }
            }
            redacted.insert(field.to_owned(), Json::Object(cleaned));
        }
    }
    Json::Object(redacted)
}

/// Normalize a tool call draft: ace's own calls read as the tool they
/// dispatched, with private input redacted before storage.
pub fn normalize_ace_call(call: &Map, previous: Option<&ToolCall>) -> Map {
    let mut current = call.clone();
    if let Some(previous) = previous
        && matches!(&previous.detail, ToolDetail::Mcp { .. })
    {
        let incoming = ace_tool_input(&current);
        let mut merged = Map::new();
        merged.insert("kind".to_owned(), Json::from(previous.kind.clone()));
        merged.insert("title".to_owned(), Json::from(previous.title.clone()));
        if let Ok(text) = ace_json::ser::to_string(&previous.detail)
            && let Ok(detail) = ace_json::parse(&text)
        {
            merged.insert("detail".to_owned(), detail);
        }
        for (key, value) in current.iter() {
            merged.insert(key.clone(), value.clone());
        }
        current = merged;
        if let Some((_, input)) = incoming {
            let empty = as_object(&input).is_some_and(|record| record.is_empty());
            if empty
                && let Ok(text) = ace_json::ser::to_string(&previous.detail)
                && let Ok(detail) = ace_json::parse(&text)
            {
                current.insert("detail".to_owned(), detail);
            }
        }
    }
    let Some((tool_name, tool_input)) = ace_tool_input(&current) else {
        return current;
    };
    let redacted = redact_ace_arguments(&tool_name, &tool_input);
    let mut detail = Map::new();
    detail.insert("kind".to_owned(), Json::from("mcp".to_owned()));
    detail.insert("server".to_owned(), Json::from("ace".to_owned()));
    detail.insert("tool".to_owned(), Json::from(tool_name.clone()));
    detail.insert("arguments".to_owned(), redacted);
    current.insert("kind".to_owned(), Json::from("mcp".to_owned()));
    current.insert("detail".to_owned(), Json::Object(detail));
    if private_ace_input(&tool_name, &tool_input) {
        current.insert("title".to_owned(), Json::from(tool_name));
        if current.contains_key("error") {
            current.insert(
                "error".to_owned(),
                Json::from("Ace input failed".to_owned()),
            );
        }
        let mut private_raw = Map::new();
        private_raw.insert(
            "type".to_owned(),
            Json::from("ace.private-input".to_owned()),
        );
        private_raw.insert(
            "data".to_owned(),
            Json::Object(Map::from_iter([("redacted".to_owned(), Json::Bool(true))])),
        );
        current.insert(
            "raw".to_owned(),
            Json::from(vec![Json::Object(private_raw)]),
        );
    }
    current
}

/// Approval previews can also echo private input or nested measured actions.
pub fn redact_ace_approval(request: &mut InteractionRequest) -> bool {
    let mcp_server = request_mcp_server(request);
    let InteractionRequest::Approval { target, .. } = request else {
        return false;
    };
    let Some(target) = target else {
        return false;
    };
    let owned = target.origin.as_deref() == Some("ace")
        || target.tool.starts_with("mcp__ace__")
        || mcp_server.as_deref() == Some("ace");
    let Some(name) = (if owned {
        Some(bare_tool_name(&target.tool))
    } else {
        None
    }) else {
        return false;
    };
    let Some(input) = target.input.as_ref().and_then(|raw| vetted_json(raw).ok()) else {
        return false;
    };
    if !private_ace_input(&name, &input) {
        return false;
    }
    let redacted = redact_ace_arguments(&name, &input);
    target.input = crate::item_model::vet_json(&redacted).ok();
    target.description = Some("Input content is redacted.".to_owned());
    if let InteractionRequest::Approval {
        title, description, ..
    } = request
    {
        *title = "Approve computer input".to_owned();
        *description = Some("Input content is redacted.".to_owned());
    }
    true
}

fn request_mcp_server(request: &InteractionRequest) -> Option<String> {
    match request {
        InteractionRequest::Approval { mcp_server, .. } => {
            mcp_server.as_ref().map(|server| server.name.clone())
        }
        _ => None,
    }
}

fn vetted_json(raw: &crate::item_model::Vetted) -> Result<Json, crate::error::CoreError> {
    crate::item_model::vetted_json(&raw.0)
}
