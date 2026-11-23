// SPDX-License-Identifier: Apache-2.0
//! Tool status and detail (`tools.ts`).

use crate::translate::data::{list, object, string};
use crate::translate::quirks::QuirksKind;
use serde_json::{Map, Value};

/// The failure text a terminal update carries, bounded.
const ERROR_LIMIT: usize = 16 * 1024;

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
                    Value::String(string(c.get("path").unwrap_or(&Value::Null)).to_owned()),
                );
                let old_text = c.get("oldText").unwrap_or(&Value::Null);
                map.insert(
                    "kind".to_owned(),
                    Value::String(if old_text.is_null() {
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
                    Value::String(string(c.get("newText").unwrap_or(&Value::Null)).to_owned()),
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
            map.insert("kind".to_owned(), Value::String(kind.clone()));
            map.insert(
                "changes".to_owned(),
                Value::Array(changes_for_kind(update, &kind)),
            );
            return Value::Object(map);
        }
    }
    match kind.as_str() {
        "shell" => {
            let mut map = Map::with_capacity(4);
            map.insert("kind".to_owned(), Value::String("shell".to_owned()));
            map.insert(
                "command".to_owned(),
                Value::String(first_string(
                    input,
                    &["command", "CommandLine", "commandLine", "command_line"],
                )),
            );
            let cwd = first_string(input, &["Cwd", "cwd", "working_dir", "workingDir"]);
            if !cwd.is_empty() {
                map.insert("cwd".to_owned(), Value::String(cwd));
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
            map.insert("kind".to_owned(), Value::String("file.read".to_owned()));
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
                Value::String(if direct.is_empty() {
                    via_locations
                } else {
                    direct
                }),
            );
            Value::Object(map)
        }
        "file.edit" | "file.write" | "file.delete" | "file.move" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String(kind.clone()));
            map.insert(
                "changes".to_owned(),
                Value::Array(changes_for_kind(update, &kind)),
            );
            Value::Object(map)
        }
        "search" => {
            let mut map = Map::with_capacity(3);
            map.insert("kind".to_owned(), Value::String("search".to_owned()));
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
            map.insert("query".to_owned(), Value::String(text.to_owned()));
            if let Some(Value::Number(total)) = output.get("totalFiles")
                && total.as_f64().is_some_and(|f| f.fract() == 0.0)
            {
                map.insert("matches".to_owned(), Value::Number(total.clone()));
            }
            Value::Object(map)
        }
        "web.search" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("web.search".to_owned()));
            let query = string(input.get("query").unwrap_or(&Value::Null));
            let fallback = string(input.get("Query").unwrap_or(&Value::Null));
            map.insert(
                "query".to_owned(),
                Value::String(if query.is_empty() {
                    fallback.to_owned()
                } else {
                    query.to_owned()
                }),
            );
            Value::Object(map)
        }
        "web.fetch" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("web.fetch".to_owned()));
            let url = string(input.get("url").unwrap_or(&Value::Null));
            let fallback = string(input.get("Url").unwrap_or(&Value::Null));
            map.insert(
                "url".to_owned(),
                Value::String(if url.is_empty() {
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
            map.insert("kind".to_owned(), Value::String("mcp".to_owned()));
            map.insert("server".to_owned(), Value::String(server));
            map.insert("tool".to_owned(), Value::String(tool));
            map.insert("arguments".to_owned(), mcp_arguments(input));
            Value::Object(map)
        }
        "agent.spawn" => {
            let mut map = Map::with_capacity(4);
            map.insert("kind".to_owned(), Value::String("agent.spawn".to_owned()));
            map.insert(
                "description".to_owned(),
                Value::String(string(input.get("description").unwrap_or(&Value::Null)).to_owned()),
            );
            map.insert(
                "prompt".to_owned(),
                Value::String(string(input.get("prompt").unwrap_or(&Value::Null)).to_owned()),
            );
            let subagent = object(input.get("subagentType").unwrap_or(&Value::Null));
            let agent_type = subagent.keys().next().cloned().unwrap_or_default();
            map.insert("agentType".to_owned(), Value::String(agent_type));
            Value::Object(map)
        }
        "plan" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("plan".to_owned()));
            map.insert(
                "markdown".to_owned(),
                Value::String(string(input.get("plan").unwrap_or(&Value::Null)).to_owned()),
            );
            Value::Object(map)
        }
        "todo" => {
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::String("todo".to_owned()));
            map.insert(
                "todos".to_owned(),
                Value::Array(todos(input.get("todos").unwrap_or(&Value::Null))),
            );
            Value::Object(map)
        }
        _ => {
            let mut map = Map::with_capacity(1);
            map.insert("kind".to_owned(), Value::String(kind));
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
                Value::String(string(c.get("path").unwrap_or(&Value::Null)).to_owned()),
            );
            let old_text = c.get("oldText").unwrap_or(&Value::Null);
            map.insert(
                "kind".to_owned(),
                Value::String(if old_text.is_null() {
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
                Value::String(string(c.get("newText").unwrap_or(&Value::Null)).to_owned()),
            );
            Value::Object(map)
        })
        .collect()
}

fn first_string(input: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(Value::String(text)) = input.get(*key) {
            return text.clone();
        }
    }
    String::new()
}

fn mcp_envelope(input: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut keys: Vec<&String> = input.keys().filter(|key| *key != "_toolName").collect();
    keys.sort();
    if keys.is_empty() {
        return None;
    }
    let allowed = ["providerIdentifier", "toolName", "args", "arguments"];
    if !keys.iter().all(|key| allowed.contains(&key.as_str())) {
        return None;
    }
    let wrapped = input.contains_key("args") || input.contains_key("arguments");
    let named = input
        .get("providerIdentifier")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        || input
            .get("toolName")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
    if wrapped || named {
        Some(input.clone())
    } else {
        None
    }
}

/// MCP call arguments: unwrapped from a recognized envelope, else the input as sent.
pub fn mcp_arguments(input: &Map<String, Value>) -> Value {
    let Some(envelope) = mcp_envelope(input) else {
        return Value::Object(input.clone());
    };
    if let Some(args) = envelope.get("args") {
        return args.clone();
    }
    match envelope.get("arguments") {
        Some(Value::Object(_)) => envelope.get("arguments").cloned().unwrap_or(Value::Null),
        Some(_) => {
            // Non-object arguments: the whole input stays, when the key exists.
            Value::Object(input.clone())
        }
        None => {
            // No arguments key: empty when the envelope is only names, else input.
            // TypeScript: hasOwn(envelope, "arguments") ? input : {}
            // Here None means no key, so return empty object.
            Value::Object(Map::new())
        }
    }
}

/// The failure text a terminal update carries, bounded.
pub fn tool_error(update: &Value) -> Option<String> {
    let output = update.get("rawOutput").unwrap_or(&Value::Null);
    let error_text = match output {
        Value::String(text) => Some(text.clone()),
        _ => {
            let output_map = object(output);
            match output_map.get("error").unwrap_or(&Value::Null) {
                Value::String(text) => Some(text.clone()),
                _ => object(output_map.get("error").unwrap_or(&Value::Null))
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }
        }
    }?;
    let trimmed = error_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(ERROR_LIMIT).collect())
}

/// Agents title some calls with a running label that outlives the call.
pub fn tool_title(data: &Value, detail: &Value) -> String {
    let data_map = object(data);
    let title = string(data_map.get("title").unwrap_or(&Value::Null)).to_owned();
    let detail_map = object(detail);
    let kind = detail_map.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind == "file.read" {
        let path = detail_map.get("path").and_then(Value::as_str).unwrap_or("");
        if !path.is_empty() && (title.is_empty() || is_running_title(&title)) {
            return format!("Read {}", display_safe(path));
        }
    }
    title
}

fn is_running_title(title: &str) -> bool {
    if !title.starts_with("Running ") {
        return false;
    }
    let rest = title.strip_prefix("Running ").unwrap_or("");
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Escape controls and bidi overrides as `\u{hex}`.
fn display_safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        let escape = (0x0000..=0x001f).contains(&code)
            || (0x007f..=0x009f).contains(&code)
            || code == 0x061c
            || code == 0x200e
            || code == 0x200f
            || (0x2028..=0x202e).contains(&code)
            || (0x2066..=0x2069).contains(&code);
        if escape {
            out.push_str(&format!("\\u{{{code:x}}}"));
        } else {
            out.push(ch);
        }
    }
    out
}

/// Validated todo entries, unknown fields stripped.
pub fn todos(value: &Value) -> Vec<Value> {
    list(value)
        .iter()
        .filter_map(|entry| {
            let map = object(entry);
            let content = map.get("content").and_then(Value::as_str)?;
            let status = map.get("status").and_then(Value::as_str)?;
            if !["pending", "in_progress", "completed", "cancelled"].contains(&status) {
                return None;
            }
            let mut out = Map::with_capacity(3);
            if let Some(Value::String(id)) = map.get("id") {
                out.insert("id".to_owned(), Value::String(id.clone()));
            }
            out.insert("content".to_owned(), Value::String(content.to_owned()));
            out.insert("status".to_owned(), Value::String(status.to_owned()));
            Some(Value::Object(out))
        })
        .collect()
}

/// Carry interpreted fields between partial refreshes.
pub fn merge_tool_data(data: &mut Map<String, Value>, update: &Value) {
    let update_map = object(update);
    for field in [
        "kind",
        "title",
        "name",
        "rawInput",
        "rawOutput",
        "content",
        "_meta",
        "locations",
    ] {
        let Some(value) = update_map.get(field) else {
            continue;
        };
        if ["name", "title", "kind"].contains(&field) && !value.is_string() {
            continue;
        }
        if field == "rawInput" {
            if value.is_null() || !value.is_object() || value.is_array() {
                continue;
            }
            let previous = object(data.get(field).unwrap_or(&Value::Null)).clone();
            let mut retained = Map::new();
            for key in [
                "_toolName",
                "command",
                "CommandLine",
                "commandLine",
                "command_line",
                "Cwd",
                "cwd",
                "working_dir",
                "workingDir",
                "path",
                "TargetFile",
                "file_path",
                "pattern",
                "query",
                "SearchDirectory",
                "Query",
                "url",
                "Url",
                "providerIdentifier",
                "toolName",
                "args",
                "arguments",
                "description",
                "prompt",
                "subagentType",
                "plan",
                "todos",
            ] {
                if let Some(existing) = previous.get(key) {
                    retained.insert(key.to_owned(), existing.clone());
                }
            }
            for (key, next) in object(value).iter() {
                retained.insert(key.clone(), next.clone());
            }
            data.insert(field.to_owned(), Value::Object(retained));
        } else if field == "rawOutput" {
            let output = object(value);
            let mut merged = object(data.get(field).unwrap_or(&Value::Null)).clone();
            for key in ["exitCode", "totalFiles", "isBackground"] {
                if let Some(next) = output.get(key) {
                    merged.insert(key.to_owned(), next.clone());
                }
            }
            data.insert(field.to_owned(), Value::Object(merged));
        } else {
            data.insert(field.to_owned(), value.clone());
        }
    }
}
