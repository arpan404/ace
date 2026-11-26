// SPDX-License-Identifier: Apache-2.0
//! Status, settings, goals and usage: the remaining live methods.

use ace_core::RawFact;
use ace_json::{Map, Value};

use super::ParsedFrame;
use super::facts::{fact, raw_payload};
use super::goal::codex_goal;
use super::helpers::{list_of, obj_map, str_empty};
use super::state::CodexTranslator;

pub fn handle_status(
    translator: &mut CodexTranslator,
    native: &str,
    frame: &ParsedFrame,
    now: i64,
    facts: &mut Vec<RawFact>,
) {
    let method_owned = frame
        .data
        .as_object()
        .and_then(|m| m.get("method"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let method = method_owned.as_str();
    let p_value_owned = frame
        .data
        .as_object()
        .and_then(|m| m.get("params"))
        .cloned()
        .unwrap_or(Value::Null);
    let p_owned = p_value_owned.as_object().cloned().unwrap_or_default();
    let p = &p_owned;
    let p_value = &p_value_owned;
    if method == "thread/status/changed" {
        let agent_key = translator
            .agents
            .get(native)
            .map(|a| a.key.clone())
            .unwrap_or_default();
        let status = p.get("status").map(obj_map).cloned().unwrap_or_default();
        let flags = list_of(status.get("activeFlags")).to_vec();
        let status_type = str_empty(status.get("type")).to_owned();
        let has_turn = translator
            .agents
            .get(native)
            .and_then(|a| a.turn.clone())
            .is_some();
        if status_type == "active" && !has_turn {
            let mut body = Map::with_capacity(2);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("until".to_owned(), Value::Number((now + 2_000).into()));
            facts.push(fact("wake.expected", body));
        }
        if (status_type == "idle" || status_type == "notLoaded") && !has_turn {
            let mut body = Map::with_capacity(2);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("until".to_owned(), Value::Number(now.into()));
            facts.push(fact("wake.expected", body));
        }
        let key = format!("status:{native}");
        let requests_empty = translator
            .agents
            .get(native)
            .is_some_and(|a| a.requests.is_empty());
        if !flags.is_empty() && requests_empty {
            if let Some(agent) = translator.agents.get_mut(native) {
                agent.unmatched_flag = Some(super::state::UnmatchedFlag {
                    data: Value::Object(p.clone()),
                    since: now,
                });
            }
            let mut request = Map::with_capacity(3);
            request.insert("kind".to_owned(), Value::from("approval".to_owned()));
            request.insert(
                "title".to_owned(),
                Value::from("Codex is waiting for input".to_owned()),
            );
            request.insert("options".to_owned(), Value::Array(ace_json::Array::new()));
            let mut body = Map::with_capacity(5);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("interaction".to_owned(), Value::from(key));
            body.insert("blocking".to_owned(), Value::Bool(true));
            body.insert("request".to_owned(), Value::Object(request));
            body.insert(
                "raw".to_owned(),
                Value::from(vec![raw_payload(method, p_value, None)]),
            );
            facts.push(fact("interaction.opened", body));
        } else if let Some(agent) = translator.agents.get_mut(native) {
            agent.unmatched_flag = None;
        }
        let requests_count = translator
            .agents
            .get(native)
            .map(|a| a.requests.len())
            .unwrap_or(0);
        if flags.is_empty() || requests_count > 0 {
            let mut body = Map::with_capacity(2);
            body.insert(
                "interaction".to_owned(),
                Value::from(format!("status:{native}")),
            );
            body.insert("state".to_owned(), Value::from("cancelled".to_owned()));
            facts.push(fact("interaction.closed", body));
        }
        if status_type == "systemError" {
            let mut body = Map::with_capacity(4);
            body.insert("agent".to_owned(), Value::from(agent_key));
            if let Some(turn) = translator.agents.get(native).and_then(|a| a.turn.clone()) {
                body.insert("nativeTurnId".to_owned(), Value::from(turn));
            }
            body.insert("outcome".to_owned(), Value::from("failed".to_owned()));
            let mut error = Map::with_capacity(2);
            error.insert("kind".to_owned(), Value::from("provider".to_owned()));
            error.insert(
                "message".to_owned(),
                Value::from("Codex thread reported systemError".to_owned()),
            );
            body.insert("error".to_owned(), Value::Object(error));
            facts.push(fact("turn.ended", body));
        }
        return;
    }
    if method == "thread/settings/updated" {
        let mode = p
            .get("collaborationMode")
            .map(obj_map)
            .and_then(|m| m.get("mode"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if !mode.is_empty()
            && let Some(agent) = translator.agents.get_mut(native)
        {
            agent.mode = mode;
        }
        let model = p.get("model").cloned().unwrap_or(Value::Null);
        let agent_key = translator
            .agents
            .get(native)
            .map(|a| a.key.clone())
            .unwrap_or_default();
        let current = translator.agents.get(native).and_then(|a| a.model.clone());
        if let Some(model_str) = super::model::bounded_model(&model)
            && current.as_deref() != Some(model_str.as_str())
        {
            if let Some(agent) = translator.agents.get_mut(native) {
                agent.model = Some(String::from(model_str.clone()));
            }
            let mut body = Map::with_capacity(2);
            body.insert("agent".to_owned(), Value::from(agent_key));
            body.insert("model".to_owned(), Value::String(model_str.clone()));
            facts.push(fact("agent.linked", body));
        }
        return;
    }
    if method.starts_with("thread/goal/") {
        if let Some(agent) = translator.agents.get_mut(native) {
            agent.pending_trigger = Some("goal".to_owned());
        }
        if method == "thread/goal/cleared" {
            let agent_key = translator
                .agents
                .get(native)
                .map(|a| a.key.clone())
                .unwrap_or_default();
            let mut body = Map::with_capacity(2);
            body.insert("agent".to_owned(), Value::from(agent_key));
            body.insert("goal".to_owned(), Value::Null);
            facts.push(fact("goal.updated", body));
        } else if method == "thread/goal/updated"
            && let Some(goal) = p.get("goal").and_then(codex_goal)
        {
            let agent_key = translator
                .agents
                .get(native)
                .map(|a| a.key.clone())
                .unwrap_or_default();
            let mut body = Map::with_capacity(2);
            body.insert("agent".to_owned(), Value::from(agent_key));
            body.insert("goal".to_owned(), goal);
            facts.push(fact("goal.updated", body));
        }
        return;
    }
    if method == "thread/queue/changed" {
        if let Some(agent) = translator.agents.get_mut(native) {
            agent.pending_trigger = Some("queue".to_owned());
        }
        return;
    }
    if method == "thread/tokenUsage/updated" {
        let agent_key = translator
            .agents
            .get(native)
            .map(|a| a.key.clone())
            .unwrap_or_default();
        let agent_model = translator.agents.get(native).and_then(|a| a.model.clone());
        let token_usage = p
            .get("tokenUsage")
            .map(obj_map)
            .cloned()
            .unwrap_or_default();
        let usage = token_usage
            .get("last")
            .map(obj_map)
            .cloned()
            .unwrap_or_default();
        if let Some(Value::Number(total)) = usage.get("totalTokens")
            && total.as_i64().is_some_and(|v| v >= 0)
        {
            let mut body = Map::with_capacity(5);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("usedTokens".to_owned(), Value::Number(*total));
            if let Some(Value::Number(window)) = token_usage.get("modelContextWindow")
                && window.as_i64().is_some_and(|v| v > 0)
            {
                body.insert("windowTokens".to_owned(), Value::Number(*window));
            }
            body.insert("sessionId".to_owned(), Value::from(native.to_owned()));
            if let Some(model) = agent_model.clone() {
                body.insert("model".to_owned(), Value::from(model));
            }
            facts.push(fact("context.sample", body));
        }
        let total = token_usage
            .get("total")
            .map(obj_map)
            .cloned()
            .unwrap_or_default();
        let use_total = matches!(
            (total.get("inputTokens"), total.get("outputTokens")),
            (Some(Value::Number(_)), Some(Value::Number(_)))
        );
        let counts = if use_total { &total } else { &usage };
        if let (Some(Value::Number(input)), Some(Value::Number(output))) =
            (counts.get("inputTokens"), counts.get("outputTokens"))
        {
            let mut body = Map::with_capacity(8);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            if let Some(model) = agent_model {
                body.insert("model".to_owned(), Value::from(model));
            }
            body.insert("inputTokens".to_owned(), Value::Number(*input));
            body.insert("outputTokens".to_owned(), Value::Number(*output));
            if use_total {
                body.insert(
                    "counterMode".to_owned(),
                    Value::from("cumulative".to_owned()),
                );
                body.insert(
                    "counterKey".to_owned(),
                    Value::from(format!("codex:{native}")),
                );
            } else {
                body.insert(
                    "counterMode".to_owned(),
                    Value::from("incremental".to_owned()),
                );
            }
            if let Some(Value::Number(reasoning)) = counts.get("reasoningOutputTokens") {
                body.insert("reasoningTokens".to_owned(), Value::Number(*reasoning));
            }
            if let Some(Value::Number(cached)) = counts.get("cachedInputTokens") {
                body.insert("cachedInputTokens".to_owned(), Value::Number(*cached));
            }
            facts.push(fact("usage", body));
        }
        return;
    }
    let root = translator.root_key.clone();
    let data = frame.data.clone();
    let raw_type = if method.is_empty() {
        "unknown".to_owned()
    } else {
        method.to_owned()
    };
    // `note(agent, method || "unknown", frame.data)` keeps the initial
    // diagnostics: frame.data is the diagnostic frame.
    let agent_key = translator
        .agents
        .get(native)
        .map(|a| a.key.clone())
        .unwrap_or(root);
    facts.push(translator.note_signal(&agent_key, &raw_type, &data, true));
}
