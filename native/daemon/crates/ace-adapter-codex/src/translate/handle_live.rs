// SPDX-License-Identifier: Apache-2.0
//! Remaining live methods: items, deltas, plans, errors, status and usage.

use ace_core::Fact;
use ace_json::{Map, Value};

use super::ParsedFrame;
use super::facts::{fact, raw_payload};
use super::helpers::{is_known_delta, list_of, obj_map, str_empty};
use super::state::CodexTranslator;

pub fn handle_live(
    translator: &mut CodexTranslator,
    native: &str,
    frame: &ParsedFrame,
    now: i64,
    facts: &mut Vec<Fact>,
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
    if method == "item/started" || method == "item/completed" {
        super::item_translate::translate_item(
            translator,
            native,
            p,
            p_value,
            method,
            &frame.data,
            &frame.channel,
            now,
            facts,
        );
        return;
    }
    if is_known_delta(method) || method.ends_with("/delta") || method.ends_with("/outputDelta") {
        let agent_native = native.to_owned();
        super::delta::translate_delta(translator, &agent_native, frame, true, facts);
        return;
    }
    if method == "turn/plan/updated" {
        let agent_key = translator
            .agents
            .get(native)
            .map(|a| a.key.clone())
            .unwrap_or_default();
        let todos: Vec<Value> = list_of(p.get("plan"))
            .iter()
            .map(|entry| {
                let step = obj_map(entry);
                let status = str_empty(step.get("status"));
                let status = if status == "completed" {
                    "completed"
                } else if status == "inProgress" || status == "in_progress" {
                    "in_progress"
                } else {
                    "pending"
                };
                let mut todo = Map::with_capacity(2);
                todo.insert(
                    "content".to_owned(),
                    Value::from(str_empty(step.get("step")).to_owned()),
                );
                todo.insert("status".to_owned(), Value::from(status.to_owned()));
                Value::Object(todo)
            })
            .collect();
        let turn_id = str_empty(p.get("turnId")).to_owned();
        let agent_turn = translator
            .agents
            .get(native)
            .and_then(|a| a.turn.clone())
            .unwrap_or_default();
        let key_turn = if turn_id.is_empty() {
            agent_turn
        } else {
            turn_id
        };
        let explanation = str_empty(p.get("explanation")).to_owned();
        let title = if explanation.is_empty() {
            "Update plan".to_owned()
        } else {
            explanation
        };
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::from("todo".to_owned()));
        detail.insert("todos".to_owned(), Value::from(todos));
        let mut call = Map::with_capacity(5);
        call.insert("kind".to_owned(), Value::from("todo".to_owned()));
        call.insert("title".to_owned(), Value::from(title));
        call.insert("status".to_owned(), Value::from("succeeded".to_owned()));
        call.insert("detail".to_owned(), Value::Object(detail));
        call.insert(
            "raw".to_owned(),
            Value::from(vec![raw_payload(method, &frame.data, None)]),
        );
        let mut draft = Map::with_capacity(3);
        draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
        draft.insert("complete".to_owned(), Value::Bool(true));
        draft.insert("call".to_owned(), Value::Object(call));
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::from(agent_key));
        body.insert(
            "item".to_owned(),
            Value::from(format!("codex:plan-update:{key_turn}")),
        );
        body.insert("draft".to_owned(), Value::Object(draft));
        facts.push(fact("item.upsert", body));
        return;
    }
    if method == "error" {
        let agent_key = translator
            .agents
            .get(native)
            .map(|a| a.key.clone())
            .unwrap_or_default();
        let (kind, message) =
            super::interactions::turn_error(p.get("error").unwrap_or(&Value::Null));
        let will_retry = matches!(p.get("willRetry"), Some(Value::Bool(true)));
        // `note(agent, method, frame.data, message)` with text: a notice upsert,
        // never a diagnostics push. `willRetry` marks it `provider.retry`.
        translator.synthetic += 1;
        let key = format!("codex:raw:{}", translator.synthetic);
        let mut draft = Map::with_capacity(7);
        draft.insert("type".to_owned(), Value::from("notice".to_owned()));
        draft.insert("level".to_owned(), Value::from("info".to_owned()));
        draft.insert("text".to_owned(), Value::from(message.clone()));
        draft.insert("complete".to_owned(), Value::Bool(true));
        if will_retry {
            draft.insert(
                "code".to_owned(),
                Value::from("provider.retry".to_owned()),
            );
        }
        draft.insert(
            "raw".to_owned(),
            Value::from(vec![raw_payload(method, &frame.data, None)]),
        );
        // TS sets `code` after construction but before pushing; key order in
        // JS objects is insertion order, so `code` sorts after `raw`.
        let mut ordered_draft = Map::with_capacity(7);
        ordered_draft.insert("type".to_owned(), Value::from("notice".to_owned()));
        ordered_draft.insert("level".to_owned(), Value::from("info".to_owned()));
        ordered_draft.insert("text".to_owned(), Value::from(message.clone()));
        ordered_draft.insert("complete".to_owned(), Value::Bool(true));
        ordered_draft.insert(
            "raw".to_owned(),
            Value::from(vec![raw_payload(method, &frame.data, None)]),
        );
        if will_retry {
            ordered_draft.insert(
                "code".to_owned(),
                Value::from("provider.retry".to_owned()),
            );
        }
        let _ = draft;
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::from(agent_key.clone()));
        body.insert("item".to_owned(), Value::from(key));
        body.insert("draft".to_owned(), Value::Object(ordered_draft));
        facts.push(fact("item.upsert", body));
        if will_retry || kind == "quota" {
            let on = if kind == "quota" {
                "rate_limit"
            } else if kind == "network" {
                "network"
            } else {
                "upstream"
            };
            let mut body = Map::with_capacity(3);
            body.insert("agent".to_owned(), Value::from(agent_key));
            body.insert("on".to_owned(), Value::from(on.to_owned()));
            body.insert("message".to_owned(), Value::from(message));
            facts.push(fact("retry", body));
        }
        return;
    }
    super::handle_status::handle_status(translator, native, frame, now, facts);
}
