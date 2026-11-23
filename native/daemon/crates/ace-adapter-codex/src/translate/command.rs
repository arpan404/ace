// SPDX-License-Identifier: Apache-2.0
//! Command details: shell commands and their parsed read/search actions.

use serde_json::{Map, Value};

use super::helpers::{list_of, obj_map, str_empty, unwrap_shell_command};

fn action_detail(action: &Map<String, Value>) -> Option<Value> {
    let action_type = str_empty(action.get("type"));
    if action_type == "read" {
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::String("file.read".to_owned()));
        detail.insert(
            "path".to_owned(),
            Value::String(str_empty(action.get("path")).to_owned()),
        );
        return Some(Value::Object(detail));
    }
    if action_type == "search" || action_type == "listFiles" {
        let mut detail = Map::with_capacity(3);
        detail.insert("kind".to_owned(), Value::String("search".to_owned()));
        let query = str_empty(action.get("query"));
        let command = str_empty(action.get("command"));
        let query = if query.is_empty() { command } else { query };
        detail.insert("query".to_owned(), Value::String(query.to_owned()));
        if let Some(Value::String(path)) = action.get("path") {
            detail.insert("path".to_owned(), Value::String(path.clone()));
        }
        return Some(Value::Object(detail));
    }
    None
}

pub fn command_detail(item: &Map<String, Value>, _item_value: &Value) -> Value {
    let actions = list_of(item.get("commandActions"));
    let raw_command = str_empty(item.get("command")).to_owned();
    let decoded = unwrap_shell_command(&raw_command)
        .map(|(inner, _)| inner)
        .unwrap_or(raw_command.clone());
    let mut commands: Vec<Option<&str>> = Vec::with_capacity(actions.len());
    for value in actions {
        let command = obj_map(value).get("command").and_then(|v| v.as_str());
        commands.push(command);
    }
    let exact: Vec<&str> = commands.iter().filter_map(|c| *c).collect();
    let command = if !commands.is_empty() && exact.len() == commands.len() {
        exact.join(" && ")
    } else {
        decoded
    };
    if actions.len() == 1
        && let Some(detail) = action_detail(obj_map(&actions[0]))
    {
        return detail;
    }
    let mut detail = Map::with_capacity(5);
    detail.insert("kind".to_owned(), Value::String("shell".to_owned()));
    detail.insert("command".to_owned(), Value::String(command.clone()));
    if command != raw_command {
        detail.insert("rawCommand".to_owned(), Value::String(raw_command.clone()));
    }
    detail.insert(
        "cwd".to_owned(),
        Value::String(str_empty(item.get("cwd")).to_owned()),
    );
    if let Some(exit_code) = item.get("exitCode")
        && exit_code.is_number()
    {
        detail.insert("exitCode".to_owned(), exit_code.clone());
    }
    Value::Object(detail)
}

/// Each parsed read/search gets its own structured detail.
pub fn command_action_items(item: &Map<String, Value>, complete: bool) -> Vec<(String, Value)> {
    let actions = list_of(item.get("commandActions"));
    if !complete || actions.len() < 2 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (index, value) in actions.iter().enumerate() {
        let action = obj_map(value);
        if let Some(detail) = action_detail(action) {
            let key = format!("{}:action:{index}", str_empty(item.get("id")));
            let status = if !complete {
                "running"
            } else if str_empty(item.get("status")) == "failed" {
                "failed"
            } else {
                "succeeded"
            };
            let mut call = Map::with_capacity(5);
            let kind = obj_map(&detail)
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            call.insert("kind".to_owned(), Value::String(kind));
            call.insert(
                "title".to_owned(),
                Value::String(str_empty(action.get("command")).to_owned()),
            );
            call.insert("detail".to_owned(), detail);
            call.insert("status".to_owned(), Value::String(status.to_owned()));
            let mut raw = Map::with_capacity(2);
            raw.insert("type".to_owned(), Value::String("commandAction".to_owned()));
            raw.insert("data".to_owned(), Value::Object(action.clone()));
            call.insert("raw".to_owned(), Value::Array(vec![Value::Object(raw)]));
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(complete));
            draft.insert("call".to_owned(), Value::Object(call));
            out.push((key, Value::Object(draft)));
        }
    }
    out
}
