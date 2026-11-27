// SPDX-License-Identifier: Apache-2.0
//! Approval requests (`interactions.ts` approval half).

use crate::translate::data::{list, object, string};
use crate::translate::frame_redaction::LEASE_REDACTION;
use crate::translate::mcp::mcp_arguments;
use crate::translate::quirks::QuirksKind;
use crate::translate::tools::tool_detail;
use ace_json::{JsString, Map, Value};

pub(crate) fn approval_request(call: &Value, options: &[Map], quirks: QuirksKind) -> Value {
    let detail = tool_detail(object(call), quirks);
    let input = object(object(call).get("rawInput").unwrap_or(&Value::Null)).clone();
    let paths: Vec<Value> = list(object(call).get("locations").unwrap_or(&Value::Null))
        .iter()
        .map(object)
        .map(|location| string(location.get("path").unwrap_or(&Value::Null)).to_owned())
        .filter(|path| !path.is_empty() && path.len() <= 4096)
        .take(128)
        .map(Value::from)
        .collect();
    let detail_map = object(&detail);
    let mcp = if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "mcp")
        && detail_map
            .get("server")
            .and_then(Value::as_str)
            .is_some_and(|server| !server.is_empty())
        && detail_map
            .get("tool")
            .and_then(Value::as_str)
            .is_some_and(|tool| !tool.is_empty())
    {
        Some((
            detail_map
                .get("server")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            detail_map
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ))
    } else {
        None
    };
    let tool_name = if let Some((server, tool)) = mcp.clone() {
        format!("mcp__{server}__{tool}")
    } else if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "shell")
    {
        "shell".to_owned()
    } else {
        let kind = string(object(call).get("kind").unwrap_or(&Value::Null));
        format!("acp/{}", if kind.is_empty() { "other" } else { kind })
    };
    let mut target = Map::with_capacity(6);
    target.insert(
        "tool".to_owned(),
        Value::from(tool_name.chars().take(256).collect::<String>()),
    );
    let access = if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "shell")
    {
        "execute"
    } else {
        match string(object(call).get("kind").unwrap_or(&Value::Null)) {
            "read" => "read",
            "edit" | "delete" | "move" => "write",
            "execute" => "execute",
            _ => "unknown",
        }
    };
    target.insert("access".to_owned(), Value::from(access.to_owned()));
    target.insert(
        "input".to_owned(),
        if mcp.is_some() {
            mcp_arguments(&input)
        } else {
            object(call).get("rawInput").cloned().unwrap_or(Value::Null)
        },
    );
    if detail_map
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "shell")
    {
        if let Some(command) = detail_map.get("command").and_then(Value::as_str)
            && !command.is_empty()
        {
            target.insert("command".to_owned(), Value::from(bounded_command(command)));
        }
        if let Some(cwd) = detail_map.get("cwd").and_then(Value::as_str)
            && !cwd.is_empty()
        {
            target.insert(
                "cwd".to_owned(),
                Value::from(cwd.chars().take(4096).collect::<String>()),
            );
        }
    }
    target.insert("paths".to_owned(), Value::from(paths));
    let mut map = Map::with_capacity(6);
    map.insert("kind".to_owned(), Value::from("approval".to_owned()));
    map.insert(
        "title".to_owned(),
        Value::from({
            let title = string(object(call).get("title").unwrap_or(&Value::Null));
            if title.is_empty() {
                tool_name.clone()
            } else {
                title.to_owned()
            }
        }),
    );
    map.insert("target".to_owned(), Value::Object(target));
    if let Some((server, _)) = mcp {
        let mut mcp_server = Map::with_capacity(2);
        mcp_server.insert(
            "name".to_owned(),
            Value::from(server.chars().take(256).collect::<String>()),
        );
        mcp_server.insert("source".to_owned(), Value::from("acp".to_owned()));
        map.insert("mcpServer".to_owned(), Value::Object(mcp_server));
    }
    let option_values: Vec<Value> = options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            let mut entry = Map::with_capacity(3);
            entry.insert("id".to_owned(), Value::from(local_option_id(option, index)));
            entry.insert(
                "label".to_owned(),
                Value::from(string(option.get("name").unwrap_or(&Value::Null)).to_owned()),
            );
            entry.insert(
                "kind".to_owned(),
                Value::from(option_kind(string(
                    option.get("kind").unwrap_or(&Value::Null),
                ))),
            );
            Value::Object(entry)
        })
        .collect();
    map.insert("options".to_owned(), Value::from(option_values));
    Value::Object(map)
}

fn bounded_command(command: &str) -> String {
    const LIMIT: usize = 32768;
    if command.len() <= LIMIT {
        return command.to_owned();
    }
    let truncation_note =
        |hidden: usize| format!("\n[command truncated: {hidden} more characters not shown]");
    let mut kept = LIMIT.saturating_sub(truncation_note(command.len()).len());
    kept = LIMIT.saturating_sub(truncation_note(command.len().saturating_sub(kept)).len());
    let kept_text: String = command.chars().take(kept).collect();
    format!("{kept_text}{}", truncation_note(command.len() - kept))
}

pub(crate) fn local_option_id(option: &Map, index: usize) -> String {
    let id = string(option.get("optionId").unwrap_or(&Value::Null));
    if id.contains(LEASE_REDACTION) {
        format!("ace-option:{index}")
    } else {
        id.to_owned()
    }
}

pub(crate) fn native_option_id(published: &[Map], native: &[Map], local: &str) -> Option<String> {
    let index = published
        .iter()
        .enumerate()
        .find(|(position, option)| local_option_id(option, *position) == *local)
        .map(|(position, _)| position)?;
    native
        .get(index)
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(crate) fn published_option_id(options: &[Map], native_id: &str) -> String {
    let index = options
        .iter()
        .position(|option| {
            option
                .get("optionId")
                .and_then(Value::as_str)
                .is_some_and(|id| id == native_id)
        })
        .unwrap_or(usize::MAX);
    if index == usize::MAX {
        return native_id.to_owned();
    }
    local_option_id(&options[index], index)
}

fn option_kind(kind: &str) -> String {
    match kind {
        "allow_once" => "allow_once",
        "allow_session" => "allow_session",
        "allow_always" => "allow_always",
        "reject_once" | "deny" => "deny",
        "reject_always" | "deny_always" => "deny_always",
        "cancel" => "cancel",
        _ => "other",
    }
    .to_owned()
}

/// Stable process-local request key.
pub fn interaction_key(id: &crate::translate::data::RpcId) -> JsString {
    let mut key = JsString::from("request:");
    key.push_str(id.typeof_name());
    key.push_str(":");
    key.push_js(&id.display());
    key
}
