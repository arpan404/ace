// SPDX-License-Identifier: Apache-2.0
//! Tool text: errors, titles, todos, merge (`tools.ts` text half).

use crate::translate::data::{list, object, string};
use ace_json::{Map, Value};

const ERROR_LIMIT: usize = 16 * 1024;

pub fn tool_error(update: &Value) -> Option<String> {
    let output = update.get("rawOutput").unwrap_or(&Value::Null);
    let error_text = match output {
        Value::String(text) => Some(text.to_string()),
        _ => {
            let output_map = object(output);
            match output_map.get("error").unwrap_or(&Value::Null) {
                Value::String(text) => Some(text.to_string()),
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
            out.insert("content".to_owned(), Value::from(content.to_owned()));
            out.insert("status".to_owned(), Value::from(status.to_owned()));
            Some(Value::Object(out))
        })
        .collect()
}

/// Carry interpreted fields between partial refreshes.
pub fn merge_tool_data(data: &mut Map, update: &Value) {
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
