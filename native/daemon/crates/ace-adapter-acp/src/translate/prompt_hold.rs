// SPDX-License-Identifier: Apache-2.0
//! Prompt holds (`prompt-hold.ts`).

use crate::translate::shell_settlement::holds_next_prompt;
use crate::translate::state::TranslationState;
use crate::translate::tools::tool_detail;
use ace_json::{Map, Value};

/// Reports a root tool running with no prompt open as holding the next prompt.
pub fn sync_prompt_hold(
    state: &mut TranslationState,
    tool_key: &str,
    live: bool,
    facts: &mut Vec<Value>,
) {
    let (owner_key, title, kind_is_shell, has_task, hold_task) = match state.tools.get(tool_key) {
        Some(tool) => (
            tool.owner_key.clone(),
            tool.data
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            tool_detail(&Value::Object(tool.data.clone()), state.quirks)
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "shell"),
            tool.task.is_some(),
            tool.hold_task.clone(),
        ),
        None => return,
    };
    let is_root = owner_key == state.root.key;
    if live && hold_task.is_none() && holds_next_prompt(state.prompt_open, is_root, has_task) {
        let hold_key = state.key("hold");
        if let Some(tool) = state.tools.get_mut(tool_key) {
            tool.hold_task = Some(hold_key.clone());
        }
        let mut fact = Map::with_capacity(7);
        fact.insert(
            "type".to_owned(),
            Value::from("background.started".to_owned()),
        );
        fact.insert("agent".to_owned(), Value::from(owner_key));
        fact.insert("task".to_owned(), Value::from(hold_key));
        fact.insert(
            "kind".to_owned(),
            Value::from(if kind_is_shell {
                "shell".to_owned()
            } else {
                "other".to_owned()
            }),
        );
        fact.insert(
            "title".to_owned(),
            Value::from(if title.is_empty() {
                "Tool".to_owned()
            } else {
                title
            }),
        );
        let item_key = state
            .tools
            .get(tool_key)
            .map(|tool| tool.key.clone())
            .unwrap_or_default();
        fact.insert("item".to_owned(), Value::from(item_key));
        fact.insert("stoppable".to_owned(), Value::Bool(false));
        fact.insert("blocksPrompts".to_owned(), Value::Bool(true));
        facts.push(Value::Object(fact));
    } else if !live && let Some(hold) = hold_task {
        let status = match state.tools.get(tool_key).map(|tool| tool.status.as_str()) {
            Some("succeeded") => "completed",
            Some("cancelled") | Some("declined") => "stopped",
            _ => "failed",
        };
        if let Some(tool) = state.tools.get_mut(tool_key) {
            tool.hold_task = None;
        }
        let mut fact = Map::with_capacity(3);
        fact.insert(
            "type".to_owned(),
            Value::from("background.ended".to_owned()),
        );
        fact.insert("task".to_owned(), Value::from(hold));
        fact.insert("status".to_owned(), Value::from(status.to_owned()));
        facts.push(Value::Object(fact));
    }
}
