// SPDX-License-Identifier: Apache-2.0
//! Tool kinds, statuses and detail drafts (`tools.ts`).

use super::envelope::string;
use super::json::{J, encode_units, units_eq};

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
pub fn tool_kind(name: &[u16]) -> &'static str {
    let lowered = name
        .iter()
        .map(|unit| {
            if (0x41..=0x5au16).contains(unit) {
                unit + 32
            } else {
                *unit
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

fn is_lit(value: Option<&J>, lit: &str) -> bool {
    matches!(value, Some(J::Str(units)) if units_eq(units, lit))
}

/// The call status from the SDK's terminal word and its stored result.
pub fn tool_status(status: &[u16], result: &J) -> &'static str {
    let value = result.get("value").unwrap_or(&J::Null);
    if units_eq(status, "error")
        || is_lit(result.get("status"), "error")
        || is_lit(result.get("status"), "rejected")
        || is_lit(result.get("status"), "denied")
        || matches!(value.get("permissionDenied"), Some(J::Bool(true)))
        || matches!(value.get("rejected"), Some(J::Bool(true)))
        || matches!(value.get("isError"), Some(J::Bool(true)))
        || value
            .get("exitCode")
            .and_then(|code| code.as_int().ok())
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

fn todo_entry(value: &J) -> Option<J> {
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
        (encode_units("content"), J::Str(content.to_vec())),
        (encode_units("status"), J::Str(encode_units(status))),
    ];
    if let Some(id) = string(value.get("id").unwrap_or(&J::Null)) {
        entry.push((encode_units("id"), J::Str(id.to_vec())));
    }
    Some(J::Obj(entry))
}

fn todo_list(args: &J, result_value: &J) -> J {
    let source = match args.get("todos").or_else(|| result_value.get("todos")) {
        Some(J::Arr(todos)) if todos.len() <= 128 => todos,
        _ => return J::Arr(Vec::new()),
    };
    let mut todos = Vec::new();
    for todo in source {
        if !matches!(todo, J::Obj(_)) {
            return J::Arr(Vec::new());
        }
        if string(todo.get("content").unwrap_or(&J::Null)).is_none()
            || string(todo.get("status").unwrap_or(&J::Null)).is_none()
        {
            return J::Arr(Vec::new());
        }
        let Some(entry) = todo_entry(todo) else {
            return J::Arr(Vec::new());
        };
        todos.push(entry);
    }
    J::Arr(todos)
}

/// The normalized detail draft for a tool call's input and stored result.
pub fn tool_detail(name: &[u16], args: &J, result: &J) -> J {
    let kind = tool_kind(name);
    let value = result.get("value").unwrap_or(&J::Null);
    let path = string(args.get("path").unwrap_or(&J::Null))
        .or_else(|| string(args.get("filePath").unwrap_or(&J::Null)))
        .unwrap_or(&[]);
    match kind {
        "shell" => {
            let mut detail = vec![
                (encode_units("kind"), J::Str(encode_units(kind))),
                (
                    encode_units("command"),
                    J::Str(
                        string(args.get("command").unwrap_or(&J::Null))
                            .unwrap_or(&[])
                            .to_vec(),
                    ),
                ),
            ];
            if let Some(cwd) = string(args.get("workingDirectory").unwrap_or(&J::Null))
                .filter(|cwd| !cwd.is_empty())
            {
                detail.push((encode_units("cwd"), J::Str(cwd.to_vec())));
            }
            if let Some(code) = value.get("exitCode").and_then(|code| code.as_int().ok()) {
                detail.push((encode_units("exitCode"), J::Num(code.to_string())));
            }
            J::Obj(detail)
        }
        "file.read" => J::Obj(vec![
            (encode_units("kind"), J::Str(encode_units(kind))),
            (encode_units("path"), J::Str(path.to_vec())),
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
                (encode_units("path"), J::Str(path.to_vec())),
                (encode_units("kind"), J::Str(encode_units(change_kind))),
            ];
            if let Some(old) = string(args.get("oldString").unwrap_or(&J::Null)) {
                change.push((encode_units("oldText"), J::Str(old.to_vec())));
            }
            let new = string(args.get("fileText").unwrap_or(&J::Null))
                .or_else(|| string(args.get("newString").unwrap_or(&J::Null)));
            if let Some(new) = new {
                change.push((encode_units("newText"), J::Str(new.to_vec())));
            }
            let diff = string(value.get("diffString").unwrap_or(&J::Null))
                .or_else(|| string(value.get("diff").unwrap_or(&J::Null)));
            if let Some(diff) = diff {
                change.push((encode_units("diff"), J::Str(diff.to_vec())));
            }
            J::Obj(vec![
                (encode_units("kind"), J::Str(encode_units(kind))),
                (encode_units("changes"), J::Arr(vec![J::Obj(change)])),
            ])
        }
        "search" => {
            let query = string(args.get("pattern").unwrap_or(&J::Null))
                .or_else(|| string(args.get("query").unwrap_or(&J::Null)))
                .unwrap_or(path);
            J::Obj(vec![
                (encode_units("kind"), J::Str(encode_units(kind))),
                (encode_units("query"), J::Str(query.to_vec())),
            ])
        }
        "mcp" => {
            let server = string(args.get("providerIdentifier").unwrap_or(&J::Null))
                .or_else(|| string(args.get("server").unwrap_or(&J::Null)))
                .map(|server| server.to_vec())
                .unwrap_or_else(|| encode_units("unknown"));
            let tool = string(args.get("tool").unwrap_or(&J::Null))
                .or_else(|| string(args.get("toolName").unwrap_or(&J::Null)))
                .unwrap_or(name);
            let mut detail = vec![
                (encode_units("kind"), J::Str(encode_units(kind))),
                (encode_units("server"), J::Str(server)),
                (encode_units("tool"), J::Str(tool.to_vec())),
            ];
            if let Some(arguments) = args.get("args").or_else(|| args.get("arguments")) {
                detail.push((encode_units("arguments"), arguments.clone()));
            }
            J::Obj(detail)
        }
        "agent.spawn" => {
            let mut detail = vec![(encode_units("kind"), J::Str(encode_units(kind)))];
            if let Some(description) = string(args.get("description").unwrap_or(&J::Null))
                .filter(|description| !description.is_empty())
            {
                detail.push((encode_units("description"), J::Str(description.to_vec())));
            }
            if let Some(prompt) =
                string(args.get("prompt").unwrap_or(&J::Null)).filter(|prompt| !prompt.is_empty())
            {
                detail.push((encode_units("prompt"), J::Str(prompt.to_vec())));
            }
            J::Obj(detail)
        }
        "todo" => J::Obj(vec![
            (encode_units("kind"), J::Str(encode_units(kind))),
            (encode_units("todos"), todo_list(args, value)),
        ]),
        "plan" => {
            let mut detail = vec![(encode_units("kind"), J::Str(encode_units(kind)))];
            let markdown = string(args.get("plan").unwrap_or(&J::Null))
                .or_else(|| string(args.get("markdown").unwrap_or(&J::Null)));
            if let Some(markdown) = markdown.filter(|markdown| !markdown.is_empty()) {
                detail.push((encode_units("markdown"), J::Str(markdown.to_vec())));
            }
            J::Obj(detail)
        }
        "ask_user" | "image" | "browser" => {
            J::Obj(vec![(encode_units("kind"), J::Str(encode_units(kind)))])
        }
        _ => J::Obj(vec![(encode_units("kind"), J::Str(encode_units("custom")))]),
    }
}
