// SPDX-License-Identifier: Apache-2.0
//! Tool kinds, statuses and detail drafts (`tools.ts`).

use super::envelope::string;
use super::text::{JsString, Value, units_eq};
use ace_json::Array;

/// The native names that fold to each normalized kind, matched case-insensitively.
const KINDS: [(&str, &str); 19] = [
    ("shell", "shell"),
    ("read", "file.read"),
    ("edit", "file.edit"),
    ("write", "file.write"),
    ("delete", "file.delete"),
    ("grep", "search"),
    ("glob", "search"),
    ("ls", "search"),
    ("sem_search", "search"),
    ("semsearch", "search"),
    ("mcp", "mcp"),
    ("task", "agent.spawn"),
    ("generateimage", "image"),
    ("recordscreen", "browser"),
    ("update_todos", "todo"),
    ("updatetodos", "todo"),
    ("create_plan", "plan"),
    ("createplan", "plan"),
    ("ask_question", "ask_user"),
];

/// The normalized kind of a native tool name.
pub fn tool_kind(name: &JsString) -> &'static str {
    let lowered = name
        .units()
        .map(|unit| {
            if (0x41..=0x5au16).contains(&unit) {
                unit + 32
            } else {
                unit
            }
        })
        .collect::<Vec<u16>>();
    for (native, kind) in KINDS {
        if lowered.len() == native.len()
            && lowered
                .iter()
                .zip(native.as_bytes())
                .all(|(unit, byte)| *unit == u16::from(*byte))
        {
            return kind;
        }
    }
    "custom"
}

fn is_lit(value: Option<&Value>, lit: &str) -> bool {
    matches!(value, Some(Value::String(units)) if units_eq(units, lit))
}

/// The call status from the SDK's terminal word and its stored result.
pub fn tool_status(status: &JsString, result: &Value) -> &'static str {
    let value = result.get("value").unwrap_or(&Value::Null);
    if units_eq(status, "error")
        || is_lit(result.get("status"), "error")
        || is_lit(result.get("status"), "rejected")
        || is_lit(result.get("status"), "denied")
        || matches!(value.get("permissionDenied"), Some(Value::Bool(true)))
        || matches!(value.get("rejected"), Some(Value::Bool(true)))
        || matches!(value.get("isError"), Some(Value::Bool(true)))
        || value
            .get("exitCode")
            .and_then(|code| code.as_i64())
            .is_some_and(|code| code != 0)
    {
        return "failed";
    }
    if units_eq(status, "completed") {
        "succeeded"
    } else {
        "running"
    }
}

fn todo_entry(value: &Value) -> Option<Value> {
    let content = string(value.get("content")?)?;
    let status = string(value.get("status")?)?;
    let status = if units_eq(status, "inProgress") {
        "in_progress"
    } else if units_eq(status, "pending") {
        "pending"
    } else if units_eq(status, "in_progress") {
        "in_progress"
    } else if units_eq(status, "completed") {
        "completed"
    } else if units_eq(status, "cancelled") {
        "cancelled"
    } else {
        return None;
    };
    let mut entry = vec![
        (JsString::from("content"), Value::String(content.clone())),
        (JsString::from("status"), Value::String(JsString::from(status))),
    ];
    if let Some(id) = string(value.get("id").unwrap_or(&Value::Null)) {
        entry.push((JsString::from("id"), Value::String(id.clone())));
    }
    Some(Value::from(entry))
}

fn todo_list(args: &Value, result_value: &Value) -> Value {
    let source = match args.get("todos").or_else(|| result_value.get("todos")) {
        Some(Value::Array(todos)) if todos.len() <= 128 => todos,
        _ => return Value::Array(Array::new()),
    };
    let mut todos = Vec::new();
    for todo in source {
        if !matches!(todo, Value::Object(_)) {
            return Value::Array(Array::new());
        }
        if string(todo.get("content").unwrap_or(&Value::Null)).is_none()
            || string(todo.get("status").unwrap_or(&Value::Null)).is_none()
        {
            return Value::Array(Array::new());
        }
        let Some(entry) = todo_entry(todo) else {
            return Value::Array(Array::new());
        };
        todos.push(entry);
    }
    Value::from(todos)
}

/// The normalized detail draft for a tool call's input and stored result.
pub fn tool_detail(name: &JsString, args: &Value, result: &Value) -> Value {
    let kind = tool_kind(name);
    let value = result.get("value").unwrap_or(&Value::Null);
    let path = string(args.get("path").unwrap_or(&Value::Null))
        .or_else(|| string(args.get("filePath").unwrap_or(&Value::Null)))
        .unwrap_or(JsString::empty());
    match kind {
        "shell" => {
            let mut detail = vec![
                (JsString::from("kind"), Value::String(JsString::from(kind))),
                (
                    JsString::from("command"),
                    Value::String(
                        string(args.get("command").unwrap_or(&Value::Null))
                            .unwrap_or(JsString::empty())
                            .clone(),
                    ),
                ),
            ];
            if let Some(cwd) = string(args.get("workingDirectory").unwrap_or(&Value::Null))
                .filter(|cwd| !cwd.is_empty())
            {
                detail.push((JsString::from("cwd"), Value::String(cwd.clone())));
            }
            if let Some(code) = value.get("exitCode").and_then(|code| code.as_i64()) {
                detail.push((JsString::from("exitCode"), Value::from(code)));
            }
            Value::from(detail)
        }
        "file.read" => Value::from(vec![
            (JsString::from("kind"), Value::String(JsString::from(kind))),
            (JsString::from("path"), Value::String(path.clone())),
        ]),
        "file.edit" | "file.write" | "file.delete" => {
            let change_kind = if kind == "file.write" {
                "add"
            } else if kind == "file.delete" {
                "delete"
            } else {
                "update"
            };
            let mut change = vec![
                (JsString::from("path"), Value::String(path.clone())),
                (JsString::from("kind"), Value::String(JsString::from(change_kind))),
            ];
            if let Some(old) = string(args.get("oldString").unwrap_or(&Value::Null)) {
                change.push((JsString::from("oldText"), Value::String(old.clone())));
            }
            let new = string(args.get("fileText").unwrap_or(&Value::Null))
                .or_else(|| string(args.get("newString").unwrap_or(&Value::Null)));
            if let Some(new) = new {
                change.push((JsString::from("newText"), Value::String(new.clone())));
            }
            let diff = string(value.get("diffString").unwrap_or(&Value::Null))
                .or_else(|| string(value.get("diff").unwrap_or(&Value::Null)));
            if let Some(diff) = diff {
                change.push((JsString::from("diff"), Value::String(diff.clone())));
            }
            Value::from(vec![
                (JsString::from("kind"), Value::String(JsString::from(kind))),
                (JsString::from("changes"), Value::from(vec![Value::from(change)])),
            ])
        }
        "search" => {
            let query = string(args.get("pattern").unwrap_or(&Value::Null))
                .or_else(|| string(args.get("query").unwrap_or(&Value::Null)))
                .unwrap_or(path);
            Value::from(vec![
                (JsString::from("kind"), Value::String(JsString::from(kind))),
                (JsString::from("query"), Value::String(query.clone())),
            ])
        }
        "mcp" => {
            let server = string(args.get("providerIdentifier").unwrap_or(&Value::Null))
                .or_else(|| string(args.get("server").unwrap_or(&Value::Null)))
                .map(|server| server.clone())
                .unwrap_or_else(|| JsString::from("unknown"));
            let tool = string(args.get("tool").unwrap_or(&Value::Null))
                .or_else(|| string(args.get("toolName").unwrap_or(&Value::Null)))
                .unwrap_or(name);
            let mut detail = vec![
                (JsString::from("kind"), Value::String(JsString::from(kind))),
                (JsString::from("server"), Value::String(server)),
                (JsString::from("tool"), Value::String(tool.clone())),
            ];
            if let Some(arguments) = args.get("args").or_else(|| args.get("arguments")) {
                detail.push((JsString::from("arguments"), arguments.clone()));
            }
            Value::from(detail)
        }
        "agent.spawn" => {
            let mut detail = vec![(JsString::from("kind"), Value::String(JsString::from(kind)))];
            if let Some(description) = string(args.get("description").unwrap_or(&Value::Null))
                .filter(|description| !description.is_empty())
            {
                detail.push((JsString::from("description"), Value::String(description.clone())));
            }
            if let Some(prompt) =
                string(args.get("prompt").unwrap_or(&Value::Null)).filter(|prompt| !prompt.is_empty())
            {
                detail.push((JsString::from("prompt"), Value::String(prompt.clone())));
            }
            Value::from(detail)
        }
        "todo" => Value::from(vec![
            (JsString::from("kind"), Value::String(JsString::from(kind))),
            (JsString::from("todos"), todo_list(args, value)),
        ]),
        "plan" => {
            let mut detail = vec![(JsString::from("kind"), Value::String(JsString::from(kind)))];
            let markdown = string(args.get("plan").unwrap_or(&Value::Null))
                .or_else(|| string(args.get("markdown").unwrap_or(&Value::Null)));
            if let Some(markdown) = markdown.filter(|markdown| !markdown.is_empty()) {
                detail.push((JsString::from("markdown"), Value::String(markdown.clone())));
            }
            Value::from(detail)
        }
        "ask_user" | "image" | "browser" => {
            Value::from(vec![(JsString::from("kind"), Value::String(JsString::from(kind)))])
        }
        _ => Value::from(vec![(JsString::from("kind"), Value::String(JsString::from("custom")))]),
    }
}
