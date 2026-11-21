// SPDX-License-Identifier: Apache-2.0

//! Native tool calls and their results (`native-tools.ts`, `tool-detail.ts`,
//! `complete-history-tool.ts`).

use history_text::{js, output_stream_id, summarize_output};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::packet::{Emit, blob};
use crate::error::Result;
use crate::json::{field, object, present, string, timestamp};
use crate::options::Provider;

/// A tool result found in a transcript, keyed by its call's native id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Completion {
    pub id: String,
    pub text: String,
    pub failed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    pub value: Value,
}

/// The native blocks of a record that may hold tool calls or results.
pub fn blocks(value: &Value, provider: Provider) -> Vec<&Value> {
    let r = object(value);
    match provider {
        Provider::Claude => field(object(field(r, "message")), "content")
            .as_array()
            .map(|a| a.iter().collect())
            .unwrap_or_default(),
        Provider::Codex => vec![field(r, "payload")],
        _ => vec![value],
    }
}

pub fn native_completions(value: &Value, provider: Provider) -> Vec<Completion> {
    let r = object(value);
    let at = timestamp(field(r, "timestamp"));
    let mut out = Vec::new();
    for block in blocks(value, provider) {
        let b = object(block);
        let Some(id) = string(b, "call_id").or_else(|| string(b, "tool_use_id")) else {
            continue;
        };
        if !matches!(
            string(b, "type"),
            Some("function_call_output" | "custom_tool_call_output" | "tool_result")
        ) {
            continue;
        }
        let output = present(b.get("output")).or_else(|| present(b.get("content")));
        let text = match output {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .map(|p| string(object(p), "text").unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        out.push(Completion {
            id: id.to_owned(),
            text,
            failed: b.get("is_error") == Some(&Value::Bool(true)),
            at,
            value: block.clone(),
        });
    }
    out
}

/// The native id of a call block.
pub fn native_call_id(block: &Map<String, Value>) -> Option<&str> {
    string(block, "call_id").or_else(|| string(block, "id"))
}

fn bounded(map: &Map<String, Value>, key: &str) -> Option<String> {
    string(map, key).map(|s| js::prefix(s, 4096).to_owned())
}

/// `historyToolDetail`: what a native call did, from its inputs.
pub fn tool_detail(block: &Map<String, Value>) -> Value {
    let name = string(block, "name")
        .or_else(|| string(block, "tool"))
        .map(|s| js::prefix(s, 4096).to_owned());
    let state = object(field(block, "state"));
    let mut input =
        object(present(block.get("input")).unwrap_or_else(|| field(state, "input"))).clone();
    if let Some(Value::String(arguments)) = block.get("arguments")
        && let Ok(parsed) = serde_json::from_str::<Value>(arguments)
    {
        input = object(&parsed).clone();
    }
    let name = name.as_deref();
    if matches!(name, Some("Bash" | "bash" | "exec_command"))
        && let Some(command) = bounded(&input, "command")
            .or_else(|| bounded(&input, "cmd"))
            .filter(|s| !s.is_empty())
    {
        return json!({ "kind": "shell", "command": command });
    }
    if matches!(name, Some("Read" | "read"))
        && let Some(path) = bounded(&input, "file_path")
            .or_else(|| bounded(&input, "filePath"))
            .filter(|s| !s.is_empty())
    {
        return json!({ "kind": "file.read", "path": path });
    }
    if matches!(name, Some("Edit" | "edit" | "Write" | "write"))
        && let Some(path) = bounded(&input, "file_path")
            .or_else(|| bounded(&input, "filePath"))
            .filter(|s| !s.is_empty())
    {
        let mut change = json!({ "kind": "update", "path": path });
        if let Some(old) = bounded(&input, "old_string").filter(|s| !s.is_empty()) {
            change["oldText"] = Value::String(old);
        }
        if let Some(new) = bounded(&input, "new_string").filter(|s| !s.is_empty()) {
            change["newText"] = Value::String(new);
        }
        let kind = if matches!(name, Some("Write" | "write")) {
            "file.write"
        } else {
            "file.edit"
        };
        return json!({ "kind": kind, "changes": [change] });
    }
    if matches!(name, Some("Task" | "task" | "spawn_agent")) {
        let mut detail = json!({ "kind": "agent.spawn" });
        if let Some(prompt) = bounded(&input, "prompt").filter(|s| !s.is_empty()) {
            detail["prompt"] = Value::String(prompt);
        }
        if let Some(description) = bounded(&input, "description").filter(|s| !s.is_empty()) {
            detail["description"] = Value::String(description);
        }
        return detail;
    }
    json!({ "kind": "custom" })
}

/// `completeHistoryTool`: a call's result streamed as its output blob, and the call settled.
pub fn complete(mut item: Value, result: &Completion, emit: Emit<'_>) -> Result<Value> {
    let item_id = item["id"].as_str().unwrap_or_default().to_owned();
    let stream = output_stream_id(&item_id);
    let output = result.text.as_bytes();
    blob(&stream, output, emit)?;
    let bytes = serde_json::to_vec(&result.value).unwrap_or_default();
    let mut raw = json!({ "type": "history.tool_result", "data": result.value });
    if bytes.len() > 64 * 1024 {
        let id = format!("{stream}:raw");
        blob(&id, &bytes, emit)?;
        raw = json!({ "type": "history.tool_result", "blobRef": id, "size": bytes.len(), "preview": "" });
    }
    let created = item["createdAt"].as_i64().unwrap_or(0);
    let call = &mut item["call"];
    let started = call["startedAt"].as_i64().unwrap_or(0);
    call["status"] = json!(if result.failed { "failed" } else { "succeeded" });
    call["endedAt"] = json!(started.max(result.at.unwrap_or(created)));
    let shell = call["detail"]["kind"] == "shell";
    if shell {
        let summary = summarize_output(&item_id, &result.text);
        call["detail"]["output"] = json!({
            "streamId": summary.stream_id,
            "bytes": summary.bytes,
            "tail": summary.tail,
            "truncated": summary.truncated,
        });
    }
    if let Some(list) = call["raw"].as_array_mut() {
        list.push(raw);
        if !shell {
            list.push(json!({ "type": "history.output", "blobRef": stream, "size": output.len(), "preview": "" }));
        }
    }
    Ok(item)
}
