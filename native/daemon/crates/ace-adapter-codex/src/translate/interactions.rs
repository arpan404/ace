// SPDX-License-Identifier: Apache-2.0
//! Interaction requests: approvals, questions and elicitations.

use ace_core::RawFact;
use ace_json::{JsString, Map, Value};

use super::facts::{fact, raw_payload};
use super::helpers::{command_actions_match, list_of, obj_map, str_empty};
use super::item::tool_draft;
use super::mcp::mcp_tool_approval;

fn valid_path(path: &JsString) -> bool {
    let units = path.len_code_points();
    (1..=4096).contains(&units)
}

fn file_changes(value: Option<&Value>) -> Option<Vec<(JsString, Option<JsString>)>> {
    let items = list_of(value);
    if items.is_empty() || items.len() > 128 {
        return None;
    }
    let mut out = Vec::with_capacity(items.len());
    for entry in items {
        let map = obj_map(entry);
        let path = match map.get("path") {
            Some(Value::String(s)) if valid_path(s) => s.clone(),
            _ => return None,
        };
        let kind = match map.get("kind") {
            Some(value) => obj_map(value),
            _ => return None,
        };
        let kind_type = str_empty(kind.get("type"));
        if kind_type != "add" && kind_type != "update" {
            return None;
        }
        let move_path = match kind.get("move_path") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if valid_path(s) => Some(s.clone()),
            _ => return None,
        };
        out.push((path, move_path));
    }
    Some(out)
}

fn approval_target_value(
    tool: &str,
    access: &str,
    command: Option<&Value>,
    cwd: Option<&Value>,
    paths: Option<Vec<JsString>>,
    input: &Value,
) -> Option<Value> {
    if tool.is_empty() || tool.chars().count() > 256 {
        return None;
    }
    if !matches!(access, "read" | "write" | "execute" | "unknown") {
        return None;
    }
    if let Some(Value::String(s)) = command {
        if s.len_code_points() > 32768 {
            return None;
        }
    } else if command.is_some() {
        return None;
    }
    if let Some(Value::String(s)) = cwd {
        if s.len_code_points() > 4096 {
            return None;
        }
    } else if cwd.is_some() {
        return None;
    }
    if let Some(paths) = &paths {
        if paths.len() > 128 {
            return None;
        }
        for path in paths {
            if !valid_path(path) {
                return None;
            }
        }
    }
    let mut map = Map::with_capacity(6);
    map.insert("tool".to_owned(), Value::from(tool.to_owned()));
    if let Some(Value::String(s)) = command {
        map.insert("command".to_owned(), Value::String(s.clone()));
    }
    if let Some(Value::String(s)) = cwd {
        map.insert("cwd".to_owned(), Value::String(s.clone()));
    }
    if let Some(paths) = paths {
        map.insert(
            "paths".to_owned(),
            Value::Array(paths.into_iter().map(Value::from).collect()),
        );
    }
    map.insert("access".to_owned(), Value::from(access.to_owned()));
    map.insert("input".to_owned(), input.clone());
    Some(Value::Object(map))
}

fn option_entry(id: &str, label: &str, kind: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("id".to_owned(), Value::from(id.to_owned()));
    map.insert("label".to_owned(), Value::from(label.to_owned()));
    map.insert("kind".to_owned(), Value::from(kind.to_owned()));
    Value::Object(map)
}

fn decisions(value: Option<&Value>) -> Value {
    let defaults = vec![
        Value::from("accept".to_owned()),
        Value::from("acceptForSession".to_owned()),
        Value::from("decline".to_owned()),
        Value::from("cancel".to_owned()),
    ];
    let entries: Vec<Value> = match value {
        None | Some(Value::Null) => defaults,
        Some(Value::Array(items)) => items.to_vec(),
        Some(_) => Vec::new(),
    };
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = if let Value::String(s) = &entry {
            s.to_string()
        } else if let Value::Object(map) = &entry {
            map.keys()
                .next()
                .map(|key| key.to_string())
                .unwrap_or("cancel".to_owned())
        } else {
            "cancel".to_owned()
        };
        let kind = if id == "accept" {
            "allow_once"
        } else if id == "acceptForSession" {
            "allow_session"
        } else if id.starts_with("acceptWith") {
            "allow_always"
        } else if id == "decline" {
            "deny"
        } else {
            "cancel"
        };
        out.push(option_entry(&id, &id, kind));
    }
    Value::from(out)
}

fn question_option(value: &Value) -> Value {
    let native = obj_map(value);
    let label = match value {
        Value::String(s) => s.to_string(),
        _ => str_empty(native.get("label")).to_owned(),
    };
    let id = match native.get("id") {
        Some(Value::String(s)) => s.to_string(),
        _ => label.clone(),
    };
    let mut map = Map::with_capacity(3);
    map.insert("id".to_owned(), Value::from(id));
    map.insert("label".to_owned(), Value::from(label));
    if let Some(Value::String(description)) = native.get("description") {
        map.insert("description".to_owned(), Value::String(description.clone()));
    }
    Value::Object(map)
}

pub fn async_questions(item: &Value) -> Value {
    questions(obj_map(item).get("questions"), true)
}

fn questions(value: Option<&Value>, is_async: bool) -> Value {
    let mut out = Vec::new();
    for (i, entry) in list_of(value).iter().enumerate() {
        let q = obj_map(entry);
        let id = match q.get("id") {
            Some(Value::String(s)) => s.to_string(),
            _ => format!("q{i}"),
        };
        let text = {
            let t = str_empty(q.get("question"));
            if t.is_empty() {
                str_empty(q.get("title")).to_owned()
            } else {
                t.to_owned()
            }
        };
        let options: Vec<Value> = list_of(q.get("options"))
            .iter()
            .map(question_option)
            .collect();
        let multi = matches!(q.get("multiSelect"), Some(Value::Bool(true)));
        let allow_other = is_async || matches!(q.get("isOther"), Some(Value::Bool(true)));
        let secret = matches!(q.get("isSecret"), Some(Value::Bool(true)));
        let mut map = Map::with_capacity(7);
        map.insert("id".to_owned(), Value::from(id));
        map.insert("text".to_owned(), Value::from(text));
        map.insert("options".to_owned(), Value::from(options));
        map.insert("multiSelect".to_owned(), Value::Bool(multi));
        map.insert("allowOther".to_owned(), Value::Bool(allow_other));
        map.insert("secret".to_owned(), Value::Bool(secret));
        if let Some(Value::String(header)) = q.get("header") {
            map.insert("header".to_owned(), Value::String(header.clone()));
        }
        out.push(Value::Object(map));
    }
    Value::from(out)
}

pub fn open_request(
    agent: &str,
    key: &str,
    method: &str,
    p: &Map,
    p_value: &Value,
    known_item: bool,
    native_item: Option<&Map>,
) -> Vec<RawFact> {
    let mut facts = Vec::new();
    let item = str_empty(p.get("itemId")).to_owned();
    if !item.is_empty() && !known_item {
        let detail = if method.ends_with("requestUserInput") {
            let mut detail = Map::with_capacity(1);
            detail.insert("kind".to_owned(), Value::from("ask_user".to_owned()));
            Value::Object(detail)
        } else {
            let mut detail = Map::with_capacity(1);
            detail.insert("kind".to_owned(), Value::from("custom".to_owned()));
            Value::Object(detail)
        };
        let draft = tool_draft(detail, method, p_value, "running", method, None);
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::from(agent.to_owned()));
        body.insert("item".to_owned(), Value::from(item.clone()));
        body.insert("draft".to_owned(), draft);
        facts.push(fact("item.upsert", body));
    }
    let request = if method.ends_with("requestUserInput") {
        let mut map = Map::with_capacity(2);
        map.insert("kind".to_owned(), Value::from("question".to_owned()));
        map.insert("questions".to_owned(), questions(p.get("questions"), false));
        Value::Object(map)
    } else if method == "mcpServer/elicitation/request" {
        match mcp_tool_approval(p_value) {
            Some(approval) => approval,
            None => {
                let mut map = Map::with_capacity(5);
                map.insert("kind".to_owned(), Value::from("elicitation".to_owned()));
                map.insert(
                    "server".to_owned(),
                    Value::from(str_empty(p.get("serverName")).to_owned()),
                );
                map.insert(
                    "message".to_owned(),
                    Value::from(str_empty(p.get("message")).to_owned()),
                );
                map.insert(
                    "schema".to_owned(),
                    p.get("requestedSchema").cloned().unwrap_or(Value::Null),
                );
                if let Some(Value::String(url)) = p.get("url") {
                    map.insert("url".to_owned(), Value::String(url.clone()));
                }
                Value::Object(map)
            }
        }
    } else {
        let title = {
            let command = str_empty(p.get("command"));
            if command.is_empty() {
                method.to_owned()
            } else {
                command.to_owned()
            }
        };
        let target = if method == "item/fileChange/requestApproval"
            && p.get("grantRoot").is_none_or(Value::is_null)
            && p.get("networkApprovalContext").is_none()
            && p.get("additionalPermissions").is_none()
            && native_item.is_some_and(|item| str_empty(item.get("type")) == "fileChange")
        {
            let changes = native_item.and_then(|item| file_changes(item.get("changes")));
            changes.and_then(|changes| {
                let mut paths: Vec<JsString> = Vec::new();
                for (path, move_path) in changes {
                    paths.push(path);
                    if let Some(move_path) = move_path {
                        paths.push(move_path);
                    }
                }
                approval_target_value(method, "write", None, None, Some(paths), p_value)
            })
        } else {
            let tool = if p.get("networkApprovalContext").is_some()
                || p.get("additionalPermissions").is_some()
            {
                "codex-permissions-escalation"
            } else {
                method
            };
            let command_value = p.get("command");
            let access = if matches!(command_value, Some(Value::String(_)))
                && command_actions_match(str_empty(command_value), p.get("commandActions"))
            {
                "execute"
            } else {
                "unknown"
            };
            approval_target_value(tool, access, command_value, p.get("cwd"), None, p_value)
        };
        let options = if method == "item/permissions/requestApproval" {
            decisions(Some(&Value::from(vec![
                Value::from("accept".to_owned()),
                Value::from("decline".to_owned()),
                Value::from("cancel".to_owned()),
            ])))
        } else {
            decisions(p.get("availableDecisions"))
        };
        let mut map = Map::with_capacity(5);
        map.insert("kind".to_owned(), Value::from("approval".to_owned()));
        map.insert("title".to_owned(), Value::from(title));
        if let Some(target) = target {
            map.insert("target".to_owned(), target);
        }
        map.insert("options".to_owned(), options);
        Value::Object(map)
    };
    let mut body = Map::with_capacity(6);
    body.insert("agent".to_owned(), Value::from(agent.to_owned()));
    body.insert("interaction".to_owned(), Value::from(key.to_owned()));
    body.insert("blocking".to_owned(), Value::Bool(true));
    body.insert("request".to_owned(), request);
    if !item.is_empty() {
        body.insert("item".to_owned(), Value::from(item));
    }
    body.insert(
        "raw".to_owned(),
        Value::from(vec![raw_payload(method, p_value, None)]),
    );
    facts.push(fact("interaction.opened", body));
    facts
}

pub fn turn_error(value: &Value) -> (String, String) {
    let map = obj_map(value);
    let codex_info = map.get("codexErrorInfo");
    let info = match codex_info {
        Some(Value::String(s)) => s.to_string(),
        Some(Value::Object(m)) => m
            .keys()
            .next()
            .map(|key| key.to_string())
            .unwrap_or_default(),
        _ => String::new(),
    };
    let message = match map.get("message") {
        Some(Value::String(s)) => s.to_string(),
        _ => "Codex turn failed".to_owned(),
    };
    let kind = super::helpers::turn_error_kind(&info, &message).to_owned();
    (kind, message)
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn a_file_change_path_counts_code_points_at_the_approval_targets_limit() {
        for length in [4096, 4097] {
            let path = Value::from("😀".repeat(length));
            let item = ace_json::json!({
                "type":"fileChange",
                "changes":[{"path":path, "kind":{"type":"add"}}]
            });
            let facts = open_request(
                "agent",
                "key",
                "item/fileChange/requestApproval",
                &Map::new(),
                &Value::Null,
                false,
                item.as_object(),
            );
            let target = facts
                .iter()
                .find_map(|fact| fact.data.to_value().pointer("/request/target").cloned());
            assert_eq!(target.is_some(), length == 4096, "{length}");
            if let Some(target) = target {
                assert_eq!(target.get("paths"), Some(&Value::from(vec![path])));
            }
        }
    }

    #[test]
    fn an_approval_target_accepts_astral_command_and_working_directory_at_their_limits() {
        for (field, limit) in [("command", 32768), ("cwd", 4096)] {
            for length in [limit, limit + 1] {
                let value = Value::from("😀".repeat(length));
                let command = (field == "command").then_some(&value);
                let cwd = (field == "cwd").then_some(&value);
                let target =
                    approval_target_value("tool", "execute", command, cwd, None, &Value::Null);
                assert_eq!(target.is_some(), length == limit, "{field}");
                if let Some(target) = target {
                    assert_eq!(target.get(field), Some(&value));
                }
            }
        }
    }
}
