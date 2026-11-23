// SPDX-License-Identifier: Apache-2.0
//! Responses: replies to the requests `handle_send` remembered.

use ace_core::Fact;
use serde_json::{Map, Value};

use super::ParsedFrame;
use super::facts::fact;
use super::helpers::{obj_map, str_empty};
use super::history::metadata_only;
use super::registry::DiscoverOptions;
use super::state::CodexTranslator;

pub fn handle_response(
    translator: &mut CodexTranslator,
    frame: &ParsedFrame,
    now: i64,
    facts: &mut Vec<Fact>,
) {
    let map = obj_map(&frame.data).clone();
    let id = match map.get("id") {
        Some(value) => value.clone(),
        None => return,
    };
    let key = translator.interaction_key(&id);
    let pending = translator.sent.remove(&key);
    let result = map.get("result").map(obj_map).cloned().unwrap_or_default();
    let thread = result
        .get("thread")
        .map(obj_map)
        .cloned()
        .unwrap_or_default();
    let has_error = map.get("error").is_some();
    if pending.as_ref().is_some_and(|p| p.method == "initialize") && !has_error {
        facts.push(fact("process.started", Map::new()));
    }
    if let Some(pending) = pending.clone() {
        if matches!(
            pending.method.as_str(),
            "thread/start" | "thread/resume" | "thread/fork"
        ) {
            let thread_id = str_empty(thread.get("id")).to_owned();
            if !thread_id.is_empty() {
                translator.root = thread_id.clone();
                let pending_cwd = obj_map(&pending.params)
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                let thread_cwd = thread
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                translator.cwd = if !thread_cwd.is_empty() {
                    thread_cwd
                } else if !pending_cwd.is_empty() {
                    pending_cwd
                } else {
                    translator.cwd.clone()
                };
                let exclude_turns =
                    obj_map(&pending.params).get("excludeTurns") == Some(&Value::Bool(true));
                let thread_value = if exclude_turns {
                    match metadata_only(&thread) {
                        Value::Object(m) => m,
                        _ => thread.clone(),
                    }
                } else {
                    thread.clone()
                };
                translator.discover_agent(
                    &thread_id,
                    &thread_value,
                    facts,
                    now,
                    DiscoverOptions {
                        parent: None,
                        spawned_by: None,
                        revision: None,
                    },
                );
                let name = thread.get("name").cloned().unwrap_or(Value::Null);
                for title_fact in translator.title(&name, &frame.data) {
                    facts.push(title_fact);
                }
                let model = result.get("model").cloned().unwrap_or(Value::Null);
                confirm_model_here(translator, &thread_id, &model, facts);
            }
        } else if pending.method == "thread/read"
            && frame.channel != "codex-discovery"
            && !str_empty(thread.get("id")).is_empty()
        {
            let thread_id = str_empty(thread.get("id")).to_owned();
            let source = thread
                .get("source")
                .map(obj_map)
                .and_then(|m| m.get("subAgent"))
                .map(obj_map)
                .and_then(|m| m.get("thread_spawn"))
                .map(obj_map)
                .cloned()
                .unwrap_or_default();
            let parent_thread = str_empty(thread.get("parentThreadId")).to_owned();
            let fallback = str_empty(source.get("parent_thread_id")).to_owned();
            let parent = if !parent_thread.is_empty() {
                Some(parent_thread)
            } else if !fallback.is_empty() {
                Some(fallback)
            } else {
                None
            };
            translator.discover_agent(
                &thread_id,
                &thread,
                facts,
                now,
                DiscoverOptions {
                    parent: parent.as_deref(),
                    spawned_by: None,
                    revision: None,
                },
            );
        } else if pending.method == "turn/start" {
            let native = match obj_map(&pending.params).get("threadId") {
                Some(Value::String(s)) => s.clone(),
                _ => translator.root.clone(),
            };
            let turn = if !has_error {
                result
                    .get("turn")
                    .map(obj_map)
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned()
            } else {
                String::new()
            };
            let agent_latest = translator
                .agents
                .get(&native)
                .and_then(|a| a.latest_turn.clone());
            let correlated = translator.completions.resolve(
                &key,
                if turn.is_empty() { None } else { Some(&turn) },
                agent_latest.as_deref(),
            );
            if !turn.is_empty() {
                translator.user_turns.add(turn.clone());
            }
            if !turn.is_empty() {
                let should_update = match translator.agents.get(&native) {
                    Some(agent) => {
                        agent.turn.is_none()
                            && !agent.ended.has(&turn)
                            && agent.latest_turn.as_deref() == pending.observed_turn.as_deref()
                    }
                    None => false,
                };
                if should_update && let Some(agent) = translator.agents.get_mut(&native) {
                    agent.latest_turn = Some(turn.clone());
                }
            }
            if let Some(correlated) = correlated {
                let has_agent = translator.agents.contains_key(&native);
                if has_agent {
                    if let Some(current) = correlated.current.clone() {
                        let (agent_turn, ended_has) = translator
                            .agents
                            .get(&native)
                            .map(|a| (a.turn.clone(), a.ended.has(&turn)))
                            .unwrap_or((None, false));
                        if agent_turn.as_deref() != Some(turn.as_str()) && !ended_has {
                            // Synthesize the acknowledged turn's start, as TS does.
                            let mut params = Map::with_capacity(2);
                            params.insert("threadId".to_owned(), Value::String(native.clone()));
                            let mut turn_obj = Map::with_capacity(1);
                            turn_obj.insert("id".to_owned(), Value::String(turn.clone()));
                            params.insert("turn".to_owned(), Value::Object(turn_obj));
                            let mut data = Map::with_capacity(2);
                            data.insert(
                                "method".to_owned(),
                                Value::String("turn/started".to_owned()),
                            );
                            data.insert("params".to_owned(), Value::Object(params));
                            translator.handle_frame(
                                &ParsedFrame {
                                    dir: frame.dir.clone(),
                                    channel: frame.channel.clone(),
                                    data: Value::Object(data),
                                    seq: frame.seq,
                                    t: frame.t,
                                },
                                now,
                                facts,
                            );
                        }
                        let current_map = current.as_object().cloned().unwrap_or_default();
                        super::turn::complete_turn(translator, &native, &current_map, true, facts);
                        translator.user_turns.delete(&turn);
                    }
                    for historical in correlated.historical {
                        let historical_map = historical.as_object().cloned().unwrap_or_default();
                        super::turn::complete_turn(
                            translator,
                            &native,
                            &historical_map,
                            false,
                            facts,
                        );
                    }
                    if correlated.settled {
                        let mut body = Map::with_capacity(2);
                        body.insert("task".to_owned(), Value::String(correlated.task));
                        body.insert("status".to_owned(), Value::String("completed".to_owned()));
                        facts.push(fact("background.ended", body));
                    }
                }
            }
        }
    }
    if let Some(pending) = pending
        && pending.interaction.is_some()
        && !has_error
    {
        let interaction = pending.interaction.unwrap_or_default();
        let mut body = Map::with_capacity(2);
        body.insert("interaction".to_owned(), Value::String(interaction.clone()));
        body.insert("state".to_owned(), Value::String("resolved".to_owned()));
        facts.push(fact("interaction.closed", body));
        translator.close_async(&interaction);
    }
}

fn confirm_model_here(
    translator: &mut CodexTranslator,
    native: &str,
    value: &Value,
    facts: &mut Vec<Fact>,
) {
    let model = match value {
        Value::String(s) if !s.is_empty() && s.encode_utf16().count() <= 256 => s.clone(),
        _ => return,
    };
    let current = translator.agents.get(native).and_then(|a| a.model.clone());
    if current.as_deref() == Some(model.as_str()) {
        return;
    }
    let agent_key = translator
        .agents
        .get(native)
        .map(|a| a.key.clone())
        .unwrap_or_default();
    if agent_key.is_empty() {
        return;
    }
    if let Some(agent) = translator.agents.get_mut(native) {
        agent.model = Some(model.clone());
    }
    let mut body = Map::with_capacity(2);
    body.insert("agent".to_owned(), Value::String(agent_key));
    body.insert("model".to_owned(), Value::String(model));
    facts.push(fact("agent.linked", body));
}
