// SPDX-License-Identifier: Apache-2.0
//! Injected user messages (the port of `injected-inputs.ts`).
//! What a user message Claude Code wrote for the model reports, or nothing
//! for any other text.

use ace_json::Value;

use super::json::{object, str_of};
use super::state::ClaudeState;

pub fn injected_input(state: &ClaudeState, data: &Value, text: &str) -> Option<String> {
    let trimmed = text.trim();
    let origin_kind = object(get_origin(data))
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let is_notification = origin_kind == "task-notification"
        || (trimmed.starts_with("<task-notification>")
            && trimmed.ends_with("</task-notification>"));
    if is_notification {
        let id = extract_task_id(trimmed);
        let task = id.as_deref().and_then(|id| state.tasks.get(id));
        if let Some(task) = task {
            let task_type = object(&task.data)
                .get("task_type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if task_type == "local_agent" {
                return Some("subagent_result".to_owned());
            }
            return Some("background_completion".to_owned());
        }
        if trimmed.contains("<summary>Agent") {
            return Some("subagent_result".to_owned());
        }
        return Some("background_completion".to_owned());
    }
    if is_agent_message(trimmed) {
        return Some("parent_agent".to_owned());
    }
    None
}

fn get_origin(data: &Value) -> &Value {
    object(data).get("origin").unwrap_or(&Value::Null)
}

/// The subagent's own task prompt, which Claude echoes back as its first
/// user message.
pub fn child_prompt(state: &ClaudeState, agent: &str, text: &str) -> bool {
    for task in state.tasks.values() {
        if task.child.as_deref() == Some(agent) {
            let prompt = object(&task.data)
                .get("prompt")
                .map(str_of)
                .unwrap_or_default();
            if prompt == text {
                return true;
            }
        }
    }
    false
}

fn extract_task_id(trimmed: &str) -> Option<String> {
    let start = trimmed.find("<task-id>")?;
    let end = trimmed.find("</task-id>")?;
    if end <= start {
        return None;
    }
    let id = trimmed[start + 9..end].trim().to_owned();
    if id.is_empty() || id.contains('\n') || id.contains('<') {
        return None;
    }
    Some(id)
}

fn is_agent_message(trimmed: &str) -> bool {
    if !trimmed.starts_with("<agent-message from=\"") || !trimmed.ends_with("</agent-message>") {
        return false;
    }
    let after_open = &trimmed["<agent-message from=\"".len()..];
    match after_open.find("\">") {
        Some(at) => {
            let from = &after_open[..at];
            !from.contains('"') && !from.contains('\n')
        }
        None => false,
    }
}
