// SPDX-License-Identifier: Apache-2.0
//! Tool status and detail (`tools.ts`).

use crate::translate::data::{list, object, string};
use crate::translate::mcp::{mcp_arguments, mcp_envelope};
use crate::translate::quirks::QuirksKind;
use crate::translate::tool_text::todos;
use ace_json::{Map, Value};

/// The tool status an update reports, keeping the previous when unmentioned.
pub fn tool_status(update: &Value, previous: &str) -> String {
    let update_map = update.as_object();
    let status = update_map
        .and_then(|m| m.get("status"))
        .and_then(Value::as_str);
    let output = object(update.get("rawOutput").unwrap_or(&Value::Null));
    if status == Some("completed") {
        if output.get("rejected").is_some_and(is_truthy) {
            return "declined".to_owned();
        }
        let failed = output.get("error").is_some_and(is_truthy)
            || output.get("permissionDenied").is_some_and(is_truthy)
            || output
                .get("exitCode")
                .and_then(numeric_value)
                .is_some_and(|code| code != 0.0);
        if failed {
            return "failed".to_owned();
        }
        return "succeeded".to_owned();
    }
    match status {
        Some("pending") => "pending".to_owned(),
        Some("in_progress") => "running".to_owned(),
        Some("failed") => "failed".to_owned(),
        Some("cancelled") => "cancelled".to_owned(),
        _ => previous.to_owned(),
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn numeric_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

/// A tool's interpreted detail.
pub fn tool_detail(update: &Value, quirks: QuirksKind) -> Value {
    let input = object(update.get("rawInput").unwrap_or(&Value::Null));
    let output = object(update.get("rawOutput").unwrap_or(&Value::Null));
    let kind_field = string(update.get("kind").unwrap_or(&Value::Null));
    let mut kind = if let Some(mapped) = quirks.tool_kind(update) {
        mapped
    } else {
        let meta = object(update.get("_meta").unwrap_or(&Value::Null));
        let mcp = object(meta.get("mcp").unwrap_or(&Value::Null));
        if mcp
            .get("server")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
            && mcp
                .get("tool")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
        {
            "mcp".to_owned()
        } else {
            match kind_field {
                "execute" => "shell".to_owned(),
                "read" => "file.read".to_owned(),
                "edit" => "file.edit".to_owned(),
                "delete" => "file.delete".to_owned(),
                "move" => "file.move".to_owned(),
                "search" => "search".to_owned(),
                "fetch" => "web.fetch".to_owned(),
                _ => "custom".to_owned(),
            }
        }
    };
    // File edits that only add read as writes, as TypeScript does.
    if kind == "file.edit" {
        let changes: Vec<Value> = list(update.get("content").unwrap_or(&Value::Null))
            .iter()
            .map(object)
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("diff"))
            .map(|c| {
                let mut map = Map::with_capacity(4);
                map.insert(
                    "path".to_owned(),
                    Value::from(string(c.get("path").unwrap_or(&Value::Null)).to_owned()),
                );
                let old_text = c.get("oldText").unwrap_or(&Value::Null);
                map.insert(
                    "kind".to_owned(),
                    Value::from(if old_text.is_null() {
                        "add".to_owned()
                    } else {
                        "update".to_owned()
                    }),
                );
                map.insert(
                    "oldText".to_owned(),
                    match old_text {
                        Value::String(text) => Value::String(text.clone()),
                        _ => Value::Null,
                    },
                );
                map.insert(
                    "newText".to_owned(),
                    Value::from(string(c.get("newText").unwrap_or(&Value::Null)).to_owned()),
                );
                Value::Object(map)
            })
            .collect();
        if !changes.is_empty()
            && changes
                .iter()
                .all(|c| object(c).get("kind").and_then(Value::as_str) == Some("add"))
        {
            kind = "file.write".to_owned();
        }
        if matches!(
            kind.as_str(),
            "file.edit" | "file.write" | "file.delete" | "file.move"
        ) {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from(kind.clone()));
            map.insert(
                "changes".to_owned(),
                Value::from(changes_for_kind(update, &kind)),
            );
            return Value::Object(map);
        }
    }
    match kind.as_str() {
        "shell" => {
            let mut map = Map::with_capacity(4);
            map.insert("kind".to_owned(), Value::from("shell".to_owned()));
            map.insert(
                "command".to_owned(),
                Value::from(first_string(
                    input,
                    &["command", "CommandLine", "commandLine", "command_line"],
                )),
            );
            let cwd = first_string(input, &["Cwd", "cwd", "working_dir", "workingDir"]);
            if !cwd.is_empty() {
                map.insert("cwd".to_owned(), Value::from(cwd));
            }
            if let Some(code) = output.get("exitCode").and_then(numeric_value)
                && code.fract() == 0.0
                && code >= (i64::MIN as f64)
                && code <= (i64::MAX as f64)
            {
                // Preserve the provider's encoding: integers stay integers.
                if let Some(Value::Number(original)) = output.get("exitCode") {
                    map.insert("exitCode".to_owned(), Value::Number(original.clone()));
                }
            }
            Value::Object(map)
        }
        "file.read" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("file.read".to_owned()));
            let direct = first_string(input, &["path", "TargetFile", "file_path"]);
            let via_locations = string(
                object(
                    list(update.get("locations").unwrap_or(&Value::Null))
                        .first()
                        .unwrap_or(&Value::Null),
                )
                .get("path")
                .unwrap_or(&Value::Null),
            )
            .to_owned();
            map.insert(
                "path".to_owned(),
                Value::from(if direct.is_empty() {
                    via_locations
                } else {
                    direct
                }),
            );
            Value::Object(map)
        }
        "file.edit" | "file.write" | "file.delete" | "file.move" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from(kind.clone()));
            map.insert(
                "changes".to_owned(),
                Value::from(changes_for_kind(update, &kind)),
            );
            Value::Object(map)
        }
        "search" => {
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::from("search".to_owned()));
            let pattern = string(input.get("pattern").unwrap_or(&Value::Null));
            let query = string(input.get("query").unwrap_or(&Value::Null));
            let search_dir = string(input.get("SearchDirectory").unwrap_or(&Value::Null));
            let text = if !pattern.is_empty() {
                pattern
            } else if !query.is_empty() {
                query
            } else {
                search_dir
            };
            map.insert("query".to_owned(), Value::from(text.to_owned()));
            if let Some(Value::Number(total)) = output.get("totalFiles")
                && total.as_f64().is_some_and(|f| f.fract() == 0.0)
            {
                map.insert("matches".to_owned(), Value::Number(total.clone()));
            }
            Value::Object(map)
        }
        "web.search" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("web.search".to_owned()));
            let query = string(input.get("query").unwrap_or(&Value::Null));
            let fallback = string(input.get("Query").unwrap_or(&Value::Null));
            map.insert(
                "query".to_owned(),
                Value::from(if query.is_empty() {
                    fallback.to_owned()
                } else {
                    query.to_owned()
                }),
            );
            Value::Object(map)
        }
        "web.fetch" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("web.fetch".to_owned()));
            let url = string(input.get("url").unwrap_or(&Value::Null));
            let fallback = string(input.get("Url").unwrap_or(&Value::Null));
            map.insert(
                "url".to_owned(),
                Value::from(if url.is_empty() {
                    fallback.to_owned()
                } else {
                    url.to_owned()
                }),
            );
            Value::Object(map)
        }
        "mcp" => {
            let meta = object(update.get("_meta").unwrap_or(&Value::Null));
            let mcp = object(meta.get("mcp").unwrap_or(&Value::Null));
            let envelope = mcp_envelope(input);
            let server = {
                let direct = string(mcp.get("server").unwrap_or(&Value::Null));
                if !direct.is_empty() {
                    direct.to_owned()
                } else {
                    envelope
                        .as_ref()
                        .and_then(|env| env.get("providerIdentifier"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned()
                }
            };
            let tool = {
                let direct = string(mcp.get("tool").unwrap_or(&Value::Null));
                if !direct.is_empty() {
                    direct.to_owned()
                } else {
                    envelope
                        .as_ref()
                        .and_then(|env| env.get("toolName"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned()
                }
            };
            let mut map = Map::with_capacity(4);
            map.insert("kind".to_owned(), Value::from("mcp".to_owned()));
            map.insert("server".to_owned(), Value::from(server));
            map.insert("tool".to_owned(), Value::from(tool));
            map.insert("arguments".to_owned(), mcp_arguments(input));
            Value::Object(map)
        }
        "agent.spawn" => {
            let mut map = Map::with_capacity(4);
            map.insert("kind".to_owned(), Value::from("agent.spawn".to_owned()));
            map.insert(
                "description".to_owned(),
                Value::from(string(input.get("description").unwrap_or(&Value::Null)).to_owned()),
            );
            map.insert(
                "prompt".to_owned(),
                Value::from(string(input.get("prompt").unwrap_or(&Value::Null)).to_owned()),
            );
            let subagent = object(input.get("subagentType").unwrap_or(&Value::Null));
            let agent_type = subagent.keys().next().map(|key| key.to_string()).unwrap_or_default();
            map.insert("agentType".to_owned(), Value::from(agent_type));
            Value::Object(map)
        }
        "plan" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("plan".to_owned()));
            map.insert(
                "markdown".to_owned(),
                Value::from(string(input.get("plan").unwrap_or(&Value::Null)).to_owned()),
            );
            Value::Object(map)
        }
        "todo" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from("todo".to_owned()));
            map.insert(
                "todos".to_owned(),
                Value::from(todos(input.get("todos").unwrap_or(&Value::Null))),
            );
            Value::Object(map)
        }
        _ => {
            let mut map = Map::with_capacity(1);
            map.insert("kind".to_owned(), Value::from(kind));
            Value::Object(map)
        }
    }
}

fn changes_for_kind(update: &Value, kind: &str) -> Vec<Value> {
    let _ = kind;
    list(update.get("content").unwrap_or(&Value::Null))
        .iter()
        .map(object)
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("diff"))
        .map(|c| {
            let mut map = Map::with_capacity(4);
            map.insert(
                "path".to_owned(),
                Value::from(string(c.get("path").unwrap_or(&Value::Null)).to_owned()),
            );
            let old_text = c.get("oldText").unwrap_or(&Value::Null);
            map.insert(
                "kind".to_owned(),
                Value::from(if old_text.is_null() {
                    "add".to_owned()
                } else {
                    "update".to_owned()
                }),
            );
            map.insert(
                "oldText".to_owned(),
                match old_text {
                    Value::String(text) => Value::String(text.clone()),
                    _ => Value::Null,
                },
            );
            map.insert(
                "newText".to_owned(),
                Value::from(string(c.get("newText").unwrap_or(&Value::Null)).to_owned()),
            );
            Value::Object(map)
        })
        .collect()
}

fn first_string(input: &Map, keys: &[&str]) -> String {
    for key in keys {
        if let Some(Value::String(text)) = input.get(*key) {
            return String::from(text.clone());
        }
    }
    String::new()
}
