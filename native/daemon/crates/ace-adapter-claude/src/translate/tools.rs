// SPDX-License-Identifier: Apache-2.0
//! Tool detail normalization (the port of `tools.ts`).
//! Only what ace renders is typed; everything else stays in raw.

use ace_json::{Map, Value};

use super::json::{list, object, str_of};

fn todo_entry(value: &Value) -> Option<Value> {
    let obj = object(value);
    let content = obj.get("content").and_then(|v| v.as_str())?;
    let status = obj.get("status").and_then(|v| v.as_str())?;
    if !matches!(
        status,
        "pending" | "in_progress" | "completed" | "cancelled"
    ) {
        return None;
    }
    if let Some(id) = obj.get("id")
        && !matches!(id, Value::Null)
        && id.as_str().is_none()
    {
        return None;
    }
    let mut map = Map::with_capacity(3);
    if let Some(Value::String(id)) = obj.get("id") {
        map.insert("id".to_owned(), Value::String(id.clone()));
    }
    map.insert("content".to_owned(), Value::from(content.to_owned()));
    map.insert("status".to_owned(), Value::from(status.to_owned()));
    Some(Value::Object(map))
}

pub fn tool_detail(name: &str, value: &Value) -> Value {
    let input = object(value);
    let kind: &str = if name.starts_with("mcp__") {
        "mcp"
    } else {
        match name {
            "Bash" | "PowerShell" | "Monitor" => "shell",
            "Read" => "file.read",
            "Edit" | "Write" => {
                if name == "Edit" {
                    "file.edit"
                } else {
                    "file.write"
                }
            }
            "NotebookEdit" => "notebook",
            "Glob" | "Grep" | "LSP" | "ToolSearch" => "search",
            "WebSearch" => "web.search",
            "WebFetch" => "web.fetch",
            "Agent" | "Task" | "Workflow" => "agent.spawn",
            "SendMessage" | "ListAgents" | "SubagentHandback" => "agent.message",
            "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskGet" | "TaskList" => "todo",
            "EnterPlanMode" | "ExitPlanMode" => "plan",
            "AskUserQuestion" => "ask_user",
            "ListMcpResourcesTool"
            | "ReadMcpResourceTool"
            | "ReadMcpResourceDirTool"
            | "RefreshMcpTools"
            | "WaitForMcpServers" => "mcp",
            _ => "custom",
        }
    };
    // The TypeScript consults `kinds[name] ?? "custom"` after the mcp__
    // prefix check; the match above encodes that same table.
    let kind = if name.starts_with("mcp__") {
        "mcp"
    } else {
        kind
    };
    let mut map = Map::new();
    map.insert("kind".to_owned(), Value::from(kind.to_owned()));
    match kind {
        "shell" => {
            map.insert(
                "command".to_owned(),
                Value::from(str_of(input.get("command").unwrap_or(&Value::Null))),
            );
        }
        "file.read" => {
            map.insert(
                "path".to_owned(),
                Value::from(str_of(input.get("file_path").unwrap_or(&Value::Null))),
            );
        }
        "file.edit" | "file.write" => {
            let mut change = Map::new();
            change.insert(
                "path".to_owned(),
                Value::from(str_of(input.get("file_path").unwrap_or(&Value::Null))),
            );
            change.insert(
                "kind".to_owned(),
                Value::from(
                    if kind == "file.write" {
                        "add"
                    } else {
                        "update"
                    }
                    .to_owned(),
                ),
            );
            if let Some(Value::String(s)) = input.get("old_string") {
                change.insert("oldText".to_owned(), Value::String(s.clone()));
            }
            if let Some(Value::String(s)) = input.get("new_string") {
                change.insert("newText".to_owned(), Value::String(s.clone()));
            }
            if let Some(Value::String(s)) = input.get("content") {
                change.insert("newText".to_owned(), Value::String(s.clone()));
            }
            map.insert(
                "changes".to_owned(),
                Value::from(vec![Value::Object(change)]),
            );
        }
        "search" => {
            let query = str_of(input.get("query").unwrap_or(&Value::Null));
            let pattern = str_of(input.get("pattern").unwrap_or(&Value::Null));
            let q = if !query.is_empty() { query } else { pattern };
            map.insert("query".to_owned(), Value::from(q));
            if name == "ToolSearch" {
                map.insert("scope".to_owned(), Value::from("tools".to_owned()));
            }
        }
        "web.search" => {
            let query = str_of(input.get("query").unwrap_or(&Value::Null));
            let pattern = str_of(input.get("pattern").unwrap_or(&Value::Null));
            let q = if !query.is_empty() { query } else { pattern };
            map.insert("query".to_owned(), Value::from(q));
        }
        "web.fetch" => {
            map.insert(
                "url".to_owned(),
                Value::from(str_of(input.get("url").unwrap_or(&Value::Null))),
            );
        }
        "mcp" if name.starts_with("mcp__") => {
            let parts: Vec<&str> = name.split("__").collect();
            let server = parts.get(1).unwrap_or(&"claude").to_string();
            let tool = if parts.len() > 2 {
                parts[2..].join("__")
            } else {
                name.to_owned()
            };
            map.insert("server".to_owned(), Value::from(server));
            map.insert("tool".to_owned(), Value::from(tool));
            map.insert("arguments".to_owned(), value.clone());
        }
        "mcp" => {
            map.insert("server".to_owned(), Value::from("claude".to_owned()));
            map.insert("tool".to_owned(), Value::from(name.to_owned()));
            map.insert("arguments".to_owned(), value.clone());
        }
        "agent.spawn" => {
            map.insert(
                "description".to_owned(),
                Value::from(str_of(input.get("description").unwrap_or(&Value::Null))),
            );
            map.insert(
                "prompt".to_owned(),
                Value::from(str_of(input.get("prompt").unwrap_or(&Value::Null))),
            );
            let agent_type = str_of(input.get("subagent_type").unwrap_or(&Value::Null));
            if !agent_type.is_empty() {
                map.insert("agentType".to_owned(), Value::from(agent_type));
            }
        }
        "agent.message" => {
            map.insert(
                "message".to_owned(),
                Value::from(str_of(input.get("message").unwrap_or(&Value::Null))),
            );
        }
        "todo" => {
            let mut todos = Vec::new();
            for entry in list(input.get("todos").unwrap_or(&Value::Null)) {
                if let Some(todo) = todo_entry(entry) {
                    todos.push(todo);
                }
            }
            map.insert("todos".to_owned(), Value::from(todos));
        }
        "plan" => {
            map.insert(
                "markdown".to_owned(),
                Value::from(str_of(input.get("plan").unwrap_or(&Value::Null))),
            );
        }
        _ => {}
    }
    Value::Object(map)
}
