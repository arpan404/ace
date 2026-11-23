// SPDX-License-Identifier: Apache-2.0
//! Tool updates and streaming chunks (part of `translator.ts`).

use crate::translate::data::{object, raw};
use crate::translate::state::TranslationState;
use crate::translate::tool_text::todos;
use ace_json::{Map, Value};
use sha2::{Digest, Sha256};

pub fn error_key(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let result = hasher.finalize();
    let mut out = String::with_capacity(result.len() * 2);
    for byte in result {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A standard plan update from an agent with no plan tool.
pub fn plan_update(
    state: &mut TranslationState,
    agent_key: &str,
    agent_input_key: Option<String>,
    update: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) {
    let turn = agent_input_key.unwrap_or_default();
    // The plan entry lives on the agent, like the WeakMap in TypeScript.
    let needs_new = {
        let plan_turn = if agent_key == state.root.key {
            state.root.plan_state.as_ref().map(|plan| plan.turn.clone())
        } else {
            state
                .agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .and_then(|agent| agent.plan_state.clone())
                .map(|plan| plan.turn)
        };
        plan_turn.as_deref() != Some(turn.as_str())
    };
    if needs_new {
        state.finish_stream(agent_key, facts);
        let key = state.key("plan");
        let entry = crate::translate::state::PlanEntry {
            turn: turn.clone(),
            key: key.clone(),
        };
        if agent_key == state.root.key {
            state.root.plan_state = Some(entry);
        } else if let Some(agent) = state
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.plan_state = Some(entry);
        }
    }
    let plan_key = if agent_key == state.root.key {
        state
            .root
            .plan_state
            .as_ref()
            .map(|plan| plan.key.clone())
            .unwrap_or_default()
    } else {
        state
            .agents
            .values()
            .find(|agent| agent.key == *agent_key)
            .and_then(|agent| agent.plan_state.clone())
            .map(|plan| plan.key)
            .unwrap_or_default()
    };
    let mut detail = Map::with_capacity(2);
    detail.insert("kind".to_owned(), Value::from("todo".to_owned()));
    detail.insert(
        "todos".to_owned(),
        Value::from(todos(object(update).get("entries").unwrap_or(&Value::Null))),
    );
    let mut call = Map::with_capacity(5);
    call.insert("kind".to_owned(), Value::from("todo".to_owned()));
    call.insert("title".to_owned(), Value::from("Plan".to_owned()));
    call.insert("status".to_owned(), Value::from("succeeded".to_owned()));
    call.insert("detail".to_owned(), Value::Object(detail));
    call.insert(
        "raw".to_owned(),
        Value::from(vec![raw(frame, "session/update", None)]),
    );
    let mut draft = Map::with_capacity(3);
    draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    draft.insert("call".to_owned(), Value::Object(call));
    // TypeScript order: type, complete, call{kind, title, status, detail, raw}.
    // Rebuild call in that order.
    let mut ordered_call = Map::with_capacity(5);
    ordered_call.insert("kind".to_owned(), Value::from("todo".to_owned()));
    ordered_call.insert("title".to_owned(), Value::from("Plan".to_owned()));
    ordered_call.insert("status".to_owned(), Value::from("succeeded".to_owned()));
    ordered_call.insert(
        "detail".to_owned(),
        Value::Object({
            let mut detail = Map::with_capacity(2);
            detail.insert("kind".to_owned(), Value::from("todo".to_owned()));
            detail.insert(
                "todos".to_owned(),
                Value::from(todos(object(update).get("entries").unwrap_or(&Value::Null))),
            );
            detail
        }),
    );
    ordered_call.insert(
        "raw".to_owned(),
        Value::from(vec![raw(frame, "session/update", None)]),
    );
    let mut ordered_draft = Map::with_capacity(3);
    ordered_draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
    ordered_draft.insert("complete".to_owned(), Value::Bool(true));
    ordered_draft.insert("call".to_owned(), Value::Object(ordered_call));
    let mut fact = Map::with_capacity(4);
    fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
    fact.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
    fact.insert("item".to_owned(), Value::from(plan_key));
    fact.insert("draft".to_owned(), Value::Object(ordered_draft));
    facts.push(Value::Object(fact));
    let _ = draft;
}

/// The root waits only on background children.
pub fn waits_on_background_child(state: &TranslationState, agent_key: &str) -> bool {
    let mut waiting = false;
    for tool_key in state.background_tools.iter() {
        if let Some(tool) = state.tools.get(tool_key)
            && tool.owner_key == *agent_key
            && let Some(child_native) = tool.child_native_id.clone()
            && let Some(child) = state.agents.get(&child_native)
            && child.background
            && !child.terminal
        {
            waiting = true;
            break;
        }
    }
    if !waiting {
        return false;
    }
    for tool_key in state.live_tools.iter() {
        if let Some(tool) = state.tools.get(tool_key)
            && tool.owner_key == *agent_key
            && ["pending", "running", "awaiting_approval"].contains(&tool.status.as_str())
        {
            return false;
        }
    }
    true
}

/// Dispatch a `session/update` payload. Returns true when handled.
pub fn handle_update(
    state: &mut TranslationState,
    shell_output: &mut crate::translate::shell_output::ShellOutput,
    agent_key: &str,
    agent_native_id: &str,
    update: &ace_json::Value,
    frame: &ace_json::Value,
    facts: &mut Vec<ace_json::Value>,
) -> bool {
    use crate::translate::data::{object, raw, string};
    use ace_json::{Map, Value};
    let update_map = object(update);
    let kind = string(update_map.get("sessionUpdate").unwrap_or(&Value::Null)).to_owned();
    // Thread titles.
    let is_root = agent_key == state.root.key;
    if kind == "session_info_update"
        && is_root
        && let Some(Value::String(title)) = update_map.get("title")
    {
        let mut draft = Map::with_capacity(6);
        draft.insert("type".to_owned(), Value::from("notice".to_owned()));
        draft.insert("code".to_owned(), Value::from("thread_title".to_owned()));
        draft.insert("title".to_owned(), Value::String(title.clone()));
        draft.insert("text".to_owned(), Value::String(title.clone()));
        draft.insert("level".to_owned(), Value::from("info".to_owned()));
        draft.insert("complete".to_owned(), Value::Bool(true));
        // TS order: type, code, title, text, level, complete.
        let mut ordered = Map::with_capacity(6);
        ordered.insert("type".to_owned(), Value::from("notice".to_owned()));
        ordered.insert("code".to_owned(), Value::from("thread_title".to_owned()));
        ordered.insert("title".to_owned(), Value::String(title.clone()));
        ordered.insert("text".to_owned(), Value::String(title.clone()));
        ordered.insert("level".to_owned(), Value::from("info".to_owned()));
        ordered.insert("complete".to_owned(), Value::Bool(true));
        let mut fact = Map::with_capacity(4);
        fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
        fact.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        fact.insert("item".to_owned(), Value::from("provider:title".to_owned()));
        fact.insert("draft".to_owned(), Value::Object(ordered));
        facts.push(Value::Object(fact));
        let _ = draft;
        state.notice(facts, frame, "session/update", None, Some(agent_key));
        return true;
    }
    if crate::translate::children::child_update(
        state,
        agent_key,
        agent_native_id,
        update,
        frame,
        facts,
    ) {
        return true;
    }
    if kind == "tool_call" || kind == "tool_call_update" {
        return crate::translate::update_tool::handle_tool_call(
            state,
            shell_output,
            agent_key,
            agent_native_id,
            update,
            frame,
            facts,
        );
    }
    if let Some(handled) =
        crate::translate::update_stream::handle_stream(state, agent_key, update, frame, facts)
    {
        return handled;
    }
    // Unknown session updates fall through to a diagnostic in the caller.
    let _ = raw;
    false
}
