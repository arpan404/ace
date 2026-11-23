// SPDX-License-Identifier: Apache-2.0
//! Turn completion: settle open items, end the turn, link children.

use ace_core::RawFact;
use ace_json::{Map, Value};

use super::facts::{fact, raw_payload};
use super::helpers::{list_of, obj_map};
use super::item::item_draft;
use super::state::CodexTranslator;

fn turn_id_of(p: &Map) -> String {
    p.get("turn")
        .map(obj_map)
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned()
}

fn turn_status_of(p: &Map) -> String {
    p.get("turn")
        .map(obj_map)
        .and_then(|m| m.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned()
}

/// `completeTurn`: the same facts the TypeScript emits, in the same order.
pub fn complete_turn(
    translator: &mut CodexTranslator,
    agent_native: &str,
    p: &Map,
    actionable: bool,
    facts: &mut Vec<RawFact>,
) {
    let agent_key = match translator.agents.get(agent_native) {
        Some(agent) => agent.key.clone(),
        None => return,
    };
    let turn_id = turn_id_of(p);
    let had_turn_before = translator
        .agents
        .get(agent_native)
        .is_some_and(|a| a.had_turn);
    if let Some(agent) = translator.agents.get_mut(agent_native) {
        agent.had_turn = true;
    }
    let (current_latest, agent_turn_now) = translator
        .agents
        .get(agent_native)
        .map(|a| (a.turn.clone(), a.latest_turn.clone()))
        .unwrap_or((None, None));
    let _ = had_turn_before;
    // `current = agent.turn ? agent.turn === turnId : !agent.latestTurn || agent.latestTurn === turnId`
    let current = match agent_turn_now.clone() {
        Some(turn) => turn == turn_id,
        None => current_latest.is_none() || current_latest.as_deref() == Some(turn_id.as_str()),
    };
    if current && let Some(agent) = translator.agents.get_mut(agent_native) {
        agent.latest_turn = Some(turn_id.clone());
    }
    let failure_text = translator
        .agents
        .get(agent_native)
        .and_then(|a| a.failure_text.clone())
        .unwrap_or_default();
    let status = turn_status_of(p);
    let outcome = if current && !failure_text.is_empty() {
        "failed"
    } else if status == "interrupted" {
        "interrupted"
    } else if status == "failed" {
        "failed"
    } else {
        "completed"
    }
    .to_owned();
    // Settle open items whose turn matches.
    let open_ids: Vec<String> = translator
        .agents
        .get(agent_native)
        .map(|a| {
            a.open
                .iter()
                .filter(|(_, open)| open.turn == turn_id)
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default();
    for item_id in open_ids {
        let open = match translator
            .agents
            .get(agent_native)
            .and_then(|a| a.open.get(&item_id))
        {
            Some(open) => (open.data.clone(), open.turn.clone(), open.stream_started),
            None => continue,
        };
        let open_type = obj_map(&open.0)
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        if open_type == "commandExecution" {
            let task = super::helpers::shell_key(&item_id);
            translator.tasks.insert(task.clone());
            let command = obj_map(&open.0)
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            let output_lost = translator.output_lost;
            let agent_turn = translator
                .agents
                .get(agent_native)
                .and_then(|a| a.turn.clone());
            let unseen_start = translator
                .agents
                .get(agent_native)
                .and_then(|a| a.open.get(&item_id))
                .is_some_and(|o| o.unseen_start);
            let wakes = actionable && current && agent_turn.as_deref().is_some() && {
                // `actionable && current && !open.unseenStart && !outputLost`
                // plus the command whose start was seen: agent.turn must be set?
                // TS: `actionable && current && !open.unseenStart && !ctx.outputLost`
                // decides `wakesAgent: false`. Only a live end of the current turn
                // for a seen start with no loss says so.
                !unseen_start && !output_lost
            };
            let _ = wakes;
            // Re-read liveness: TS checks `actionable && current && !open.unseenStart
            // && !ctx.outputLost` for `wakesAgent: false`; otherwise omits it.
            let include_wakes_false = actionable && current && !unseen_start && !output_lost;
            let mut body = Map::with_capacity(9);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("task".to_owned(), Value::from(task));
            body.insert("kind".to_owned(), Value::from("shell".to_owned()));
            body.insert("title".to_owned(), Value::from(command));
            body.insert("item".to_owned(), Value::from(item_id.clone()));
            body.insert("stoppable".to_owned(), Value::Bool(true));
            if include_wakes_false {
                body.insert("wakesAgent".to_owned(), Value::Bool(false));
            }
            body.insert(
                "raw".to_owned(),
                Value::from(vec![raw_payload("commandExecution", &open.0, None)]),
            );
            facts.push(fact("background.started", body));
        } else {
            if open.2 {
                let mut body = Map::with_capacity(3);
                body.insert("agent".to_owned(), Value::from(agent_key.clone()));
                body.insert(
                    "item".to_owned(),
                    Value::from(format!("codex:plan-stream:{item_id}")),
                );
                let mut draft = Map::with_capacity(2);
                draft.insert("type".to_owned(), Value::from("notice".to_owned()));
                draft.insert("complete".to_owned(), Value::Bool(true));
                body.insert("draft".to_owned(), Value::Object(draft));
                facts.push(fact("item.upsert", body));
            }
            let mut draft = match item_draft(obj_map(&open.0), true, &open.0) {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            if let Some(Value::Object(call)) = draft.get_mut("call") {
                call.insert(
                    "status".to_owned(),
                    Value::from(
                        if outcome == "completed" {
                            "succeeded"
                        } else {
                            "cancelled"
                        }
                        .to_owned(),
                    ),
                );
                // TS only rewrites `call.status` when the draft is a tool call;
                // `item_draft` always returns one here except for message types,
                // which never reach this branch (commandExecution handled above,
                // plan/message/reasoning do). Keep the same guard: only when the
                // draft has a `call` object.
            }
            // `draft.type !== "tool_call"` cannot happen for non-shell opens here,
            // but keep the value whole when it does.
            let draft_value = Value::Object(draft);
            let mut body = Map::with_capacity(3);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("item".to_owned(), Value::from(item_id.clone()));
            body.insert("draft".to_owned(), draft_value);
            facts.push(fact("item.upsert", body));
            if let Some(agent) = translator.agents.get_mut(agent_native) {
                agent.open.shift_remove(&item_id);
            }
        }
    }
    let already_ended = translator
        .agents
        .get(agent_native)
        .is_some_and(|a| a.ended.has(&turn_id));
    if already_ended {
        return;
    }
    if let Some(agent) = translator.agents.get_mut(agent_native) {
        agent.ended.add(turn_id.clone());
    }
    if current {
        let children: Vec<String> = translator
            .agents
            .get(agent_native)
            .map(|a| a.children.iter().cloned().collect())
            .unwrap_or_default();
        for child_native in children {
            let (child_key, child_turn, child_had_turn, child_open_shell) =
                match translator.agents.get(&child_native) {
                    Some(child) => (
                        child.key.clone(),
                        child.turn.clone(),
                        child.had_turn,
                        child.open.keys().any(|item| {
                            translator.tasks.contains(&super::helpers::shell_key(item))
                        }),
                    ),
                    None => continue,
                };
            if child_turn.is_some() || !child_had_turn || child_open_shell {
                let mut body = Map::with_capacity(3);
                body.insert("agent".to_owned(), Value::from(child_key));
                body.insert("background".to_owned(), Value::Bool(true));
                facts.push(fact("agent.linked", body));
            }
        }
    }
    // Cancel requests of this turn.
    let request_keys: Vec<String> = translator
        .agents
        .get(agent_native)
        .map(|a| {
            a.requests
                .iter()
                .filter(|(_, req)| req.turn == turn_id)
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    for key in request_keys {
        let mut body = Map::with_capacity(3);
        body.insert("interaction".to_owned(), Value::from(key.clone()));
        body.insert("state".to_owned(), Value::from("cancelled".to_owned()));
        facts.push(fact("interaction.closed", body));
        if let Some(agent) = translator.agents.get_mut(agent_native) {
            agent.requests.shift_remove(&key);
        }
    }
    // `turn.ended`, with the failure error when it failed.
    let mut body = Map::with_capacity(6);
    body.insert("agent".to_owned(), Value::from(agent_key.clone()));
    body.insert("nativeTurnId".to_owned(), Value::from(turn_id.clone()));
    body.insert("outcome".to_owned(), Value::from(outcome.clone()));
    if !actionable || !current {
        body.insert("historical".to_owned(), Value::Bool(true));
    }
    if outcome == "failed" {
        let error_value = if current && !failure_text.is_empty() {
            let mut map = Map::with_capacity(1);
            map.insert("message".to_owned(), Value::from(failure_text));
            Value::Object(map)
        } else {
            p.get("turn")
                .cloned()
                .unwrap_or(Value::Null)
                .get("error")
                .cloned()
                .unwrap_or(Value::Null)
        };
        // Reuse the shared error mapping via the interactions helper shape.
        let (kind, message) = super::interactions::turn_error(&error_value);
        let mut error = Map::with_capacity(2);
        error.insert("kind".to_owned(), Value::from(kind));
        error.insert("message".to_owned(), Value::from(message));
        body.insert("error".to_owned(), Value::Object(error));
    }
    facts.push(fact("turn.ended", body));
    let agent_turn_is = translator
        .agents
        .get(agent_native)
        .and_then(|a| a.turn.clone());
    if agent_turn_is.as_deref() == Some(turn_id.as_str())
        && let Some(agent) = translator.agents.get_mut(agent_native)
    {
        agent.turn = None;
    }
    let parent = translator
        .agents
        .get(agent_native)
        .and_then(|a| a.parent.clone());
    let child_task = super::helpers::child_key(agent_native);
    if current && parent.is_some() && translator.tasks.contains(&child_task) {
        translator.tasks.remove(&child_task);
        let mut body = Map::with_capacity(2);
        body.insert("task".to_owned(), Value::from(child_task));
        body.insert(
            "status".to_owned(),
            Value::from(
                if outcome == "failed" {
                    "failed"
                } else {
                    "completed"
                }
                .to_owned(),
            ),
        );
        facts.push(fact("background.ended", body));
    }
    let mode_is_plan = translator
        .agents
        .get(agent_native)
        .is_some_and(|a| a.mode == "plan");
    let plan = translator
        .agents
        .get(agent_native)
        .and_then(|a| a.plan.as_ref().map(|p| (p.id.clone(), p.text.clone())));
    if actionable
        && current
        && outcome == "completed"
        && mode_is_plan
        && let Some((plan_id, plan_text)) = plan
    {
        let mut request = Map::with_capacity(2);
        request.insert("kind".to_owned(), Value::from("plan_review".to_owned()));
        request.insert("markdown".to_owned(), Value::from(plan_text.clone()));
        let mut raw_inner = Map::with_capacity(2);
        raw_inner.insert("id".to_owned(), Value::from(plan_id.clone()));
        raw_inner.insert("text".to_owned(), Value::from(plan_text));
        let mut body = Map::with_capacity(5);
        body.insert("agent".to_owned(), Value::from(agent_key.clone()));
        body.insert(
            "interaction".to_owned(),
            Value::from(super::helpers::plan_key(&turn_id)),
        );
        body.insert("item".to_owned(), Value::from(plan_id));
        body.insert("blocking".to_owned(), Value::Bool(true));
        body.insert("request".to_owned(), Value::Object(request));
        body.insert(
            "raw".to_owned(),
            Value::from(vec![raw_payload("plan", &Value::Object(raw_inner), None)]),
        );
        facts.push(fact("interaction.opened", body));
    }
    let _ = list_of;
}
