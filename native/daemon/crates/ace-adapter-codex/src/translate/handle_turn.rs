// SPDX-License-Identifier: Apache-2.0
//! Turns: started brackets the agent's work, completed settles it.

use ace_core::Fact;
use serde_json::{Map, Value};

use super::ParsedFrame;
use super::facts::{fact, raw_payload};
use super::helpers::{obj_map, str_empty};
use super::state::CodexTranslator;

pub fn handle_turn_started(
    translator: &mut CodexTranslator,
    native: &str,
    p: &Map<String, Value>,
    _now: i64,
    facts: &mut Vec<Fact>,
) {
    let turn = p
        .get("turn")
        .map(obj_map)
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let agent_key = translator
        .agents
        .get(native)
        .map(|a| a.key.clone())
        .unwrap_or_default();
    let (parent, pending_trigger, child_result, background_result) = translator
        .agents
        .get(native)
        .map(|a| {
            (
                a.parent.clone(),
                a.pending_trigger.clone(),
                a.child_result,
                a.background_result,
            )
        })
        .unwrap_or((None, None, false, false));
    let has_user_turn = translator.user_turns.has(&turn);
    let trigger = if has_user_turn {
        "user"
    } else if parent.is_some() {
        pending_trigger.as_deref().unwrap_or("spawn")
    } else if pending_trigger.as_deref() == Some("queue") {
        "queue"
    } else if child_result {
        "subagent_result"
    } else if background_result {
        "background_completion"
    } else {
        pending_trigger.as_deref().unwrap_or("unknown")
    }
    .to_owned();
    translator.user_turns.delete(&turn);
    if let Some(agent) = translator.agents.get_mut(native) {
        agent.turn = Some(turn.clone());
        agent.latest_turn = Some(turn.clone());
        agent.had_turn = true;
        agent.plan = None;
        agent.failure_text = None;
        agent.child_result = false;
        agent.background_result = false;
        agent.pending_trigger = None;
    }
    let mut body = Map::with_capacity(4);
    body.insert("agent".to_owned(), Value::String(agent_key));
    body.insert("nativeTurnId".to_owned(), Value::String(turn));
    body.insert("trigger".to_owned(), Value::String(trigger));
    facts.push(fact("turn.started", body));
}

#[allow(clippy::too_many_arguments)]
pub fn handle_turn_completed(
    translator: &mut CodexTranslator,
    native: &str,
    p: &Map<String, Value>,
    p_value: &Value,
    frame: &ParsedFrame,
    _now: i64,
    facts: &mut Vec<Fact>,
) {
    let turn = p
        .get("turn")
        .map(obj_map)
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let agent_key = translator
        .agents
        .get(native)
        .map(|a| a.key.clone())
        .unwrap_or_default();
    let ended_has = translator
        .agents
        .get(native)
        .is_some_and(|a| a.ended.has(&turn));
    let (agent_turn, latest_turn) = translator
        .agents
        .get(native)
        .map(|a| (a.turn.clone(), a.latest_turn.clone()))
        .unwrap_or((None, None));
    let should_hold = !ended_has
        && (translator.completions.has(native, &turn)
            || (frame.channel != "hydration"
                && Some(turn.clone()) != agent_turn
                && Some(turn.clone()) != latest_turn));
    if should_hold {
        let held = translator
            .completions
            .hold(native, p_value, latest_turn.as_deref());
        if let Some(held) = held {
            if held.first {
                let mut body = Map::with_capacity(7);
                body.insert("agent".to_owned(), Value::String(agent_key.clone()));
                body.insert("task".to_owned(), Value::String(held.task));
                body.insert("kind".to_owned(), Value::String("other".to_owned()));
                body.insert(
                    "title".to_owned(),
                    Value::String("Turn completion".to_owned()),
                );
                body.insert("internal".to_owned(), Value::Bool(true));
                body.insert("stoppable".to_owned(), Value::Bool(false));
                facts.push(fact("background.started", body));
            }
            if held.overflow {
                facts.push(translator.warning(
                    &agent_key,
                    "turn-correlation-overflow",
                    "Codex turn correlation exceeded its limit. Execution stays unresolved until the session exits.",
                ));
            }
            return;
        }
    }
    let actionable = frame.channel != "hydration";
    super::turn::complete_turn(translator, native, p, actionable, facts);
    if let Some(flag) = translator
        .agents
        .get(native)
        .and_then(|a| a.unmatched_flag.clone())
    {
        let mut request = Map::with_capacity(3);
        request.insert("kind".to_owned(), Value::String("approval".to_owned()));
        request.insert(
            "title".to_owned(),
            Value::String("Codex is waiting for input".to_owned()),
        );
        request.insert("options".to_owned(), Value::Array(Vec::new()));
        let mut body = Map::with_capacity(5);
        body.insert("agent".to_owned(), Value::String(agent_key));
        body.insert(
            "interaction".to_owned(),
            Value::String(format!("status:{native}")),
        );
        body.insert("blocking".to_owned(), Value::Bool(true));
        body.insert("request".to_owned(), Value::Object(request));
        body.insert(
            "raw".to_owned(),
            Value::Array(vec![raw_payload("thread/status/changed", &flag.data, None)]),
        );
        facts.push(fact("interaction.opened", body));
    }
    let _ = obj_map;
    let _ = str_empty;
}
