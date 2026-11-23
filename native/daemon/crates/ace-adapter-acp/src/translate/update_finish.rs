// SPDX-License-Identifier: Apache-2.0
//! Tool update settlement (`translator.ts` finish half).

use crate::translate::child_spawn::{background_child, placeholder_child};
use crate::translate::completed_tools::retire_tool;
use crate::translate::shell_output::ShellOutput;
use crate::translate::state::TranslationState;
use crate::translate::tool_text::tool_title;
use ace_json::{Map, Value};

/// Publish a tool update as an upsert.
pub fn push_upsert(
    state: &mut TranslationState,
    agent_key: &str,
    tool_key: &str,
    detail: &Value,
    error: Option<String>,
    retained_raw: bool,
    facts: &mut Vec<Value>,
) {
    {
        let tool = state.tools.get(tool_key).cloned();
        if let Some(tool) = tool {
            let detail_kind = detail
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let title = tool_title(&Value::Object(tool.data.clone()), detail);
            let mut call = Map::with_capacity(6);
            call.insert(
                "kind".to_owned(),
                detail
                    .get("kind")
                    .cloned()
                    .unwrap_or(Value::from(detail_kind.clone())),
            );
            call.insert("title".to_owned(), Value::from(title));
            call.insert("status".to_owned(), Value::from(tool.status.clone()));
            if let Some(error) = error {
                call.insert("error".to_owned(), Value::from(error));
            }
            let mut detail_value = detail.clone();
            if detail_kind == "agent.spawn"
                && let Some(child_key) = tool.child_key.clone()
                && let Some(detail_map) = detail_value.as_object_mut()
            {
                detail_map.insert("childAgent".to_owned(), Value::from(child_key));
            }
            call.insert("detail".to_owned(), detail_value);
            if !retained_raw {
                call.insert("raw".to_owned(), Value::from(tool.raw.clone()));
            }
            let mut ordered = Map::with_capacity(6);
            for key in ["kind", "title", "status", "error", "detail", "raw"] {
                if let Some(value) = call.get(key) {
                    ordered.insert(key.to_owned(), value.clone());
                }
            }
            let complete =
                !["pending", "running", "awaiting_approval"].contains(&tool.status.as_str());
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(complete));
            draft.insert("call".to_owned(), Value::Object(ordered));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
            fact.insert("item".to_owned(), Value::from(tool.key.clone()));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        }
    }
}

/// Settle a tool update: shell output, plan, placeholders, background tasks.
pub fn settle_finish(
    state: &mut TranslationState,
    shell_output: &mut ShellOutput,
    agent_key: &str,
    tool_key: &str,
    update: &Value,
    detail: &Value,
    facts: &mut Vec<Value>,
) {
    {
        let detail_kind = detail
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if detail_kind == "shell" {
            shell_output.append(state, tool_key, update, facts);
        }
        if detail_kind == "plan"
            && let Some(agent) = state.agent_by_key_mut(agent_key)
        {
            agent.plan_tool_key = Some(tool_key.to_owned());
        }
        if state.quirks.provider() == "antigravity" && detail_kind == "agent.spawn" {
            placeholder_child(state, tool_key, facts);
        }
        background_child(state, tool_key, facts);
    }
    // Background shell settlement.
    {
        let (task, status, has_child) = match state.tools.get(tool_key) {
            Some(tool) => (
                tool.task.clone(),
                tool.status.clone(),
                tool.child_key.is_some(),
            ),
            None => (None, String::new(), true),
        };
        if let Some(task) = task
            && ["succeeded", "failed", "declined", "cancelled"].contains(&status.as_str())
            && !has_child
        {
            state.settle_shell(tool_key);
            let mut ended = Map::with_capacity(3);
            ended.insert(
                "type".to_owned(),
                Value::from("background.ended".to_owned()),
            );
            ended.insert("task".to_owned(), Value::from(task));
            ended.insert(
                "status".to_owned(),
                Value::from(
                    match status.as_str() {
                        "succeeded" => "completed",
                        "cancelled" => "stopped",
                        _ => "failed",
                    }
                    .to_owned(),
                ),
            );
            facts.push(Value::Object(ended));
        }
    }
    {
        let status = state
            .tools
            .get(tool_key)
            .map(|tool| tool.status.clone())
            .unwrap_or_default();
        if ["succeeded", "failed", "declined", "cancelled"].contains(&status.as_str()) {
            let mut activity = Map::with_capacity(3);
            activity.insert("type".to_owned(), Value::from("activity".to_owned()));
            activity.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
            activity.insert(
                "activity".to_owned(),
                Value::from("starting_turn".to_owned()),
            );
            facts.push(Value::Object(activity));
        }
    }
    retire_tool(state, tool_key);
}
