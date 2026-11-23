// SPDX-License-Identifier: Apache-2.0
//! Tool kinds, statuses and detail drafts (`tools.ts`).

use serde_json::{Value, json};

use super::envelope::{object, string};

/// The normalized kind of a native tool name.
pub fn tool_kind(name: &str) -> &'static str {
    match name.to_lowercase().as_str() {
        "shell" => "shell",
        "read" => "file.read",
        "edit" => "file.edit",
        "write" => "file.write",
        "delete" => "file.delete",
        "grep" | "glob" | "ls" | "sem_search" | "semsearch" => "search",
        "mcp" => "mcp",
        "task" => "agent.spawn",
        "generateimage" => "image",
        "recordscreen" => "browser",
        "update_todos" | "updatetodos" => "todo",
        "create_plan" | "createplan" => "plan",
        "ask_question" => "ask_user",
        _ => "custom",
    }
}

/// The call status from the SDK's terminal word and its stored result.
pub fn tool_status(status: &str, result: &Value) -> &'static str {
    let data = object(result);
    let value = object(data.get("value").unwrap_or(&Value::Null));
    if status == "error"
        || data.get("status") == Some(&Value::String("error".to_owned()))
        || data.get("status") == Some(&Value::String("rejected".to_owned()))
        || data.get("status") == Some(&Value::String("denied".to_owned()))
        || value.get("permissionDenied") == Some(&Value::Bool(true))
        || value.get("rejected") == Some(&Value::Bool(true))
        || value.get("isError") == Some(&Value::Bool(true))
        || matches!(value.get("exitCode"), Some(Value::Number(code)) if code.as_i64().is_some_and(|code| code != 0))
    {
        return "failed";
    }
    if status == "completed" {
        "succeeded"
    } else {
        "running"
    }
}

fn todo_entry(value: &Value) -> Option<Value> {
    let map = match value {
        Value::Object(map) => map,
        _ => return None,
    };
    let content = string(map.get("content")?)?;
    let status = string(map.get("status")?)?;
    let status = match status {
        "inProgress" => "in_progress",
        "pending" | "in_progress" | "completed" | "cancelled" => status,
        _ => return None,
    };
    let mut entry = json!({ "content": content, "status": status });
    if let Some(id) = string(map.get("id").unwrap_or(&Value::Null)) {
        entry["id"] = Value::String(id.to_owned());
    }
    Some(entry)
}

fn todo_list(args: &Value, result_value: &Value) -> Value {
    let source = match args.get("todos").or_else(|| result_value.get("todos")) {
        Some(Value::Array(todos)) if todos.len() <= 128 => todos,
        _ => return Value::Array(Vec::new()),
    };
    let mut todos = Vec::new();
    for todo in source {
        let map = match todo {
            Value::Object(map) => map,
            _ => return Value::Array(Vec::new()),
        };
        if string(map.get("content").unwrap_or(&Value::Null)).is_none()
            || string(map.get("status").unwrap_or(&Value::Null)).is_none()
        {
            return Value::Array(Vec::new());
        }
        let Some(entry) = todo_entry(todo) else {
            return Value::Array(Vec::new());
        };
        todos.push(entry);
    }
    Value::Array(todos)
}

/// The normalized detail draft for a tool call's input and stored result.
pub fn tool_detail(name: &str, args: &Value, result: &Value) -> Value {
    let kind = tool_kind(name);
    let input = object(args);
    let value = object(object(result).get("value").unwrap_or(&Value::Null));
    let path = string(input.get("path").unwrap_or(&Value::Null))
        .or_else(|| string(input.get("filePath").unwrap_or(&Value::Null)))
        .unwrap_or("");
    match kind {
        "shell" => {
            let mut detail = json!({
                "kind": kind,
                "command": string(input.get("command").unwrap_or(&Value::Null)).unwrap_or(""),
            });
            if let Some(cwd) = string(input.get("workingDirectory").unwrap_or(&Value::Null)) {
                detail["cwd"] = Value::String(cwd.to_owned());
            }
            if let Some(Value::Number(code)) = value.get("exitCode")
                && code.as_i64().is_some()
            {
                detail["exitCode"] = value["exitCode"].clone();
            }
            detail
        }
        "file.read" => json!({ "kind": kind, "path": path }),
        "file.edit" | "file.write" | "file.delete" => {
            let change_kind = if kind == "file.write" {
                "add"
            } else if kind == "file.delete" {
                "delete"
            } else {
                "update"
            };
            let mut change = json!({ "path": path, "kind": change_kind });
            if let Some(old) = string(input.get("oldString").unwrap_or(&Value::Null)) {
                change["oldText"] = Value::String(old.to_owned());
            }
            let new = string(input.get("fileText").unwrap_or(&Value::Null))
                .or_else(|| string(input.get("newString").unwrap_or(&Value::Null)));
            if let Some(new) = new {
                change["newText"] = Value::String(new.to_owned());
            }
            let diff = string(value.get("diffString").unwrap_or(&Value::Null))
                .or_else(|| string(value.get("diff").unwrap_or(&Value::Null)));
            if let Some(diff) = diff {
                change["diff"] = Value::String(diff.to_owned());
            }
            json!({ "kind": kind, "changes": [change] })
        }
        "search" => {
            let query = string(input.get("pattern").unwrap_or(&Value::Null))
                .or_else(|| string(input.get("query").unwrap_or(&Value::Null)))
                .unwrap_or(path);
            json!({ "kind": kind, "query": query })
        }
        "mcp" => {
            let mut detail = json!({
                "kind": kind,
                "server": string(input.get("providerIdentifier").unwrap_or(&Value::Null))
                    .or_else(|| string(input.get("server").unwrap_or(&Value::Null)))
                    .unwrap_or("unknown"),
                "tool": string(input.get("tool").unwrap_or(&Value::Null))
                    .or_else(|| string(input.get("toolName").unwrap_or(&Value::Null)))
                    .unwrap_or(name),
            });
            let arguments = input.get("args").or_else(|| input.get("arguments"));
            if let Some(arguments) = arguments {
                detail["arguments"] = arguments.clone();
            }
            detail
        }
        "agent.spawn" => {
            let mut detail = json!({ "kind": kind });
            if let Some(description) = string(input.get("description").unwrap_or(&Value::Null)) {
                detail["description"] = Value::String(description.to_owned());
            }
            if let Some(prompt) = string(input.get("prompt").unwrap_or(&Value::Null)) {
                detail["prompt"] = Value::String(prompt.to_owned());
            }
            detail
        }
        "todo" => json!({ "kind": kind, "todos": todo_list(args, &Value::Object(value.clone())) }),
        "plan" => {
            let mut detail = json!({ "kind": kind });
            let markdown = string(input.get("plan").unwrap_or(&Value::Null))
                .or_else(|| string(input.get("markdown").unwrap_or(&Value::Null)));
            if let Some(markdown) = markdown {
                detail["markdown"] = Value::String(markdown.to_owned());
            }
            detail
        }
        "ask_user" | "image" | "browser" => json!({ "kind": kind }),
        _ => json!({ "kind": "custom" }),
    }
}
