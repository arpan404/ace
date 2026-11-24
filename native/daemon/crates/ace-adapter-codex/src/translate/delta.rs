// SPDX-License-Identifier: Apache-2.0
//! Deltas: streaming text, reasoning and command output.

use ace_core::RawFact;
use ace_json::{Map, Value};

use super::facts::{fact, raw_payload};
use super::helpers::{obj_map, str_empty};
use super::item::item_draft;
use super::state::CodexTranslator;

fn delta_field(method: &str) -> Option<&'static str> {
    match method {
        "item/agentMessage/delta" => Some("text"),
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => Some("reasoning"),
        "item/commandExecution/outputDelta" => Some("output"),
        _ => None,
    }
}

fn retry_cleared(agent_key: &str) -> RawFact {
    let mut body = Map::with_capacity(1);
    body.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
    fact("retry.cleared", body)
}

fn item_delta(agent_key: &str, item: &str, field: &str, append: &str) -> RawFact {
    let mut body = Map::with_capacity(4);
    body.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
    body.insert("item".to_owned(), Value::from(item.to_owned()));
    body.insert("field".to_owned(), Value::from(field.to_owned()));
    body.insert("append".to_owned(), Value::from(append.to_owned()));
    fact("item.delta", body)
}

/// `translateDelta`: same facts the TypeScript emits, in the same order.
pub fn translate_delta(
    translator: &mut CodexTranslator,
    agent_native: &str,
    frame: &super::ParsedFrame,
    is_frame_data: bool,
    facts: &mut Vec<RawFact>,
) {
    let p_value = frame
        .data
        .as_object()
        .and_then(|m| m.get("params"))
        .cloned()
        .unwrap_or(Value::Null);
    let p = obj_map(&p_value).clone();
    let method = frame
        .data
        .as_object()
        .and_then(|m| m.get("method"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let frame_data = frame.data.clone();
    let method_ref = method.as_str();
    let agent_key = match translator.agents.get(agent_native) {
        Some(agent) => agent.key.clone(),
        None => return,
    };
    let item = str_empty(p.get("itemId")).to_owned();
    let append = str_empty(p.get("delta")).to_owned();
    let field = delta_field(method_ref);
    if item.is_empty() || (field.is_none() && method_ref != "item/plan/delta") {
        translator_note(
            translator,
            &agent_key,
            method_ref,
            &frame_data,
            is_frame_data,
            facts,
        );
        return;
    }
    facts.push(retry_cleared(&agent_key));
    // Borrow the agent mutably for the rest; take what we need without holding
    // the borrow across `translator_note`, which needs `&mut translator`.
    let (open_exists, open_turn, open_data_type, open_stream_started) = {
        match translator.agents.get(agent_native) {
            Some(agent) => match agent.open.get(&item) {
                Some(open) => (
                    true,
                    open.turn.clone(),
                    obj_map(&open.data)
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_owned(),
                    open.stream_started,
                ),
                None => (false, String::new(), String::new(), false),
            },
            None => return,
        }
    };
    if method_ref == "item/plan/delta" || field == Some("output") {
        let turn = str_empty(p.get("turnId"));
        let agent_turn = translator
            .agents
            .get(agent_native)
            .and_then(|a| a.turn.clone())
            .unwrap_or_default();
        let turn = if turn.is_empty() {
            agent_turn.clone()
        } else {
            turn.to_owned()
        };
        let _ = open_turn;
        if !open_exists && field == Some("output") && (agent_turn.is_empty() || turn != agent_turn)
        {
            facts.push(item_delta(&agent_key, &item, "output", &append));
            let mut body = Map::with_capacity(7);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert(
                "task".to_owned(),
                Value::from(super::helpers::shell_key(&item)),
            );
            body.insert("item".to_owned(), Value::from(item.clone()));
            body.insert("kind".to_owned(), Value::from("shell".to_owned()));
            body.insert("title".to_owned(), Value::from("Command output".to_owned()));
            body.insert("stoppable".to_owned(), Value::Bool(true));
            facts.push(fact("background.started", body));
            return;
        }
        if !open_exists {
            let completed_has = translator
                .agents
                .get(agent_native)
                .is_some_and(|a| a.completed.has(&item));
            if !completed_has {
                let mut data = Map::with_capacity(6);
                data.insert("id".to_owned(), Value::from(item.clone()));
                data.insert(
                    "type".to_owned(),
                    Value::from(
                        if field == Some("output") {
                            "commandExecution"
                        } else {
                            "plan"
                        }
                        .to_owned(),
                    ),
                );
                data.insert("command".to_owned(), Value::from(String::new()));
                data.insert(
                    "commandActions".to_owned(),
                    Value::Array(ace_json::Array::new()),
                );
                data.insert("text".to_owned(), Value::from(String::new()));
                let draft = item_draft(&data, false, &Value::Object(data.clone()));
                if let Some(agent) = translator.agents.get_mut(agent_native) {
                    agent.open.insert(
                        item.clone(),
                        super::state::OpenItem {
                            data: Value::Object(data),
                            turn: turn.clone(),
                            stream_started: false,
                            unseen_start: true,
                        },
                    );
                    agent.items.add(item.clone());
                }
                let mut body = Map::with_capacity(3);
                body.insert("agent".to_owned(), Value::from(agent_key.clone()));
                body.insert("item".to_owned(), Value::from(item.clone()));
                body.insert("draft".to_owned(), draft);
                // `item.reconciled` for output, `item.upsert` for plan, as TS does.
                let fact_type = if field == Some("output") {
                    "item.reconciled"
                } else {
                    "item.upsert"
                };
                facts.push(fact(fact_type, body));
            }
        }
        if method_ref == "item/plan/delta" {
            let has_open = translator
                .agents
                .get(agent_native)
                .is_some_and(|a| a.open.contains_key(&item));
            if !has_open {
                translator_note(
                    translator,
                    &agent_key,
                    method_ref,
                    &frame_data,
                    is_frame_data,
                    facts,
                );
                return;
            }
            let stream = format!("codex:plan-stream:{item}");
            let stream_started = translator
                .agents
                .get(agent_native)
                .and_then(|a| a.open.get(&item))
                .is_some_and(|o| o.stream_started);
            if !stream_started {
                let text = translator
                    .agents
                    .get(agent_native)
                    .and_then(|a| a.open.get(&item))
                    .and_then(|o| obj_map(&o.data).get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned();
                let mut draft = Map::with_capacity(4);
                draft.insert("type".to_owned(), Value::from("notice".to_owned()));
                draft.insert("level".to_owned(), Value::from("info".to_owned()));
                draft.insert("text".to_owned(), Value::from(text));
                draft.insert("complete".to_owned(), Value::Bool(false));
                let mut body = Map::with_capacity(3);
                body.insert("agent".to_owned(), Value::from(agent_key.clone()));
                body.insert("item".to_owned(), Value::from(stream.clone()));
                body.insert("draft".to_owned(), Value::Object(draft));
                facts.push(fact("item.upsert", body));
                if let Some(agent) = translator.agents.get_mut(agent_native)
                    && let Some(open) = agent.open.get_mut(&item)
                {
                    open.stream_started = true;
                }
            }
            facts.push(item_delta(&agent_key, &stream, "text", &append));
            return;
        }
        let has_open = translator
            .agents
            .get(agent_native)
            .is_some_and(|a| a.open.contains_key(&item));
        if !has_open {
            facts.push(item_delta(&agent_key, &item, "output", &append));
            return;
        }
        let draft = {
            let agent = match translator.agents.get(agent_native) {
                Some(agent) => agent,
                None => return,
            };
            let open = match agent.open.get(&item) {
                Some(open) => open,
                None => return,
            };
            item_draft(obj_map(&open.data), false, &open.data.clone())
        };
        let is_shell = obj_map(&draft)
            .get("call")
            .map(obj_map)
            .and_then(|c| c.get("detail"))
            .map(obj_map)
            .and_then(|d| d.get("kind"))
            .and_then(|v| v.as_str())
            == Some("shell");
        let _ = (open_data_type, open_stream_started);
        if !is_shell {
            translator_note(
                translator,
                &agent_key,
                method_ref,
                &frame_data,
                is_frame_data,
                facts,
            );
            return;
        }
    }
    if let Some(field) = field {
        facts.push(item_delta(&agent_key, &item, field, &append));
    }
}

fn translator_note(
    translator: &mut CodexTranslator,
    agent: &str,
    raw_type: &str,
    data: &Value,
    is_frame_data: bool,
    facts: &mut Vec<RawFact>,
) {
    if !is_frame_data {
        translator
            .diagnostics
            .push(raw_payload(raw_type, data, None));
    }
    facts.push(super::facts::signal_fact(Some(agent)));
}
