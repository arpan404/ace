// SPDX-License-Identifier: Apache-2.0
//! Item translation: started and completed thread items.

use ace_core::Fact;
use serde_json::{Map, Value};

use super::facts::{fact, raw_payload};
use super::helpers::{list_of, obj_map, str_empty};
use super::item::{item_draft, tool_draft};
use super::state::CodexTranslator;

fn retry_cleared(agent_key: &str) -> Fact {
    let mut body = Map::with_capacity(1);
    body.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
    fact("retry.cleared", body)
}

/// `translateItem`: same facts the TypeScript emits, in the same order.
#[allow(clippy::too_many_arguments)]
pub fn translate_item(
    translator: &mut CodexTranslator,
    agent_native: &str,
    p: &Map<String, Value>,
    p_value: &Value,
    method: &str,
    frame_data: &Value,
    frame_channel: &str,
    now: i64,
    facts: &mut Vec<Fact>,
) {
    let agent_key = match translator.agents.get(agent_native) {
        Some(agent) => agent.key.clone(),
        None => return,
    };
    if frame_channel != "hydration" {
        facts.push(retry_cleared(&agent_key));
    }
    let item_map = p.get("item").map(obj_map).cloned().unwrap_or_default();
    let item_value = p.get("item").cloned().unwrap_or(Value::Null);
    let item_id = str_empty(item_map.get("id")).to_owned();
    let item_type = str_empty(item_map.get("type")).to_owned();
    let complete = method == "item/completed";
    if item_id.is_empty() {
        let is_frame = frame_data == p_value;
        let _ = is_frame;
        // `note(agent, method, frame.data)`: frame.data, so no diagnostics push.
        facts.push(super::facts::signal_fact(Some(&agent_key)));
        return;
    }
    if item_type == "contextCompaction" {
        let mut draft = Map::with_capacity(2);
        draft.insert("type".to_owned(), Value::String("compaction".to_owned()));
        draft.insert("complete".to_owned(), Value::Bool(complete));
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::String(agent_key.clone()));
        body.insert("item".to_owned(), Value::String(item_id.clone()));
        body.insert("draft".to_owned(), Value::Object(draft));
        facts.push(fact("item.upsert", body));
        return;
    }
    if let Some(agent) = translator.agents.get_mut(agent_native) {
        agent.items.add(item_id.clone());
    }
    if item_type == "subAgentActivity" {
        let child = str_empty(item_map.get("agentThreadId")).to_owned();
        let kind = str_empty(item_map.get("kind")).to_owned();
        if kind == "started" && !child.is_empty() {
            let title = format!("Spawn {}", str_empty(item_map.get("agentPath")));
            let mut detail = Map::with_capacity(2);
            detail.insert("kind".to_owned(), Value::String("agent.spawn".to_owned()));
            detail.insert("childAgent".to_owned(), Value::String(child.clone()));
            let draft = tool_draft(
                Value::Object(detail),
                &title,
                &item_value,
                "succeeded",
                &item_type,
                None,
            );
            let mut body = Map::with_capacity(3);
            body.insert("agent".to_owned(), Value::String(agent_key.clone()));
            body.insert("item".to_owned(), Value::String(item_id.clone()));
            body.insert("draft".to_owned(), draft);
            facts.push(fact("item.upsert", body));
            let native = agent_native.to_owned();
            let spawned_by = item_id.clone();
            translator.discover_agent(
                &child,
                &item_map,
                facts,
                now,
                super::registry::DiscoverOptions {
                    parent: Some(&native),
                    spawned_by: Some(&spawned_by),
                    revision: None,
                },
            );
            let (child_turn, child_had_turn) = translator
                .agents
                .get(&child)
                .map(|a| (a.turn.clone(), a.had_turn))
                .unwrap_or((None, false));
            if child_turn.is_some() || !child_had_turn {
                let task = super::helpers::child_key(&child);
                translator.tasks.insert(task.clone());
                let child_key = translator
                    .agents
                    .get(&child)
                    .map(|a| a.key.clone())
                    .unwrap_or(child.clone());
                let mut body = Map::with_capacity(7);
                body.insert("agent".to_owned(), Value::String(agent_key.clone()));
                body.insert("task".to_owned(), Value::String(task));
                body.insert("kind".to_owned(), Value::String("subagent".to_owned()));
                body.insert("childAgent".to_owned(), Value::String(child_key));
                body.insert("item".to_owned(), Value::String(item_id.clone()));
                body.insert(
                    "title".to_owned(),
                    Value::String(str_empty(item_map.get("agentPath")).to_owned()),
                );
                body.insert("stoppable".to_owned(), Value::Bool(true));
                // TS omits the title fallback when empty? It uses `str(...)`, which
                // is `""` when missing; keep the empty title to match.
                if str_empty(item_map.get("agentPath")).is_empty() {
                    body.insert("title".to_owned(), Value::String(child.clone()));
                }
                facts.push(fact("background.started", body));
            }
        } else if kind == "completed" {
            // TS: `${str(item["agentPath"], child)} finished`
            let base = {
                let path = str_empty(item_map.get("agentPath"));
                if path.is_empty() {
                    child.clone()
                } else {
                    path.to_owned()
                }
            };
            let text = format!("{base} finished");
            let _ = text;
            let synthetic = translator.synthetic;
            let _ = synthetic;
            let root_key = translator.root_key.clone();
            let _ = root_key;
            // `note` with text returns a notice upsert.
            let mut draft = Map::with_capacity(6);
            draft.insert("type".to_owned(), Value::String("notice".to_owned()));
            draft.insert("level".to_owned(), Value::String("info".to_owned()));
            draft.insert("text".to_owned(), Value::String(format!("{base} finished")));
            draft.insert("complete".to_owned(), Value::Bool(true));
            draft.insert(
                "raw".to_owned(),
                Value::Array(vec![raw_payload(&item_type, &item_value, None)]),
            );
            translator.synthetic += 1;
            let key = format!("codex:raw:{}", translator.synthetic);
            let mut body = Map::with_capacity(3);
            body.insert("agent".to_owned(), Value::String(agent_key.clone()));
            body.insert("item".to_owned(), Value::String(key));
            body.insert("draft".to_owned(), Value::Object(draft));
            facts.push(fact("item.upsert", body));
            let has_turn = translator
                .agents
                .get(agent_native)
                .and_then(|a| a.turn.clone())
                .is_some();
            if !has_turn && let Some(agent) = translator.agents.get_mut(agent_native) {
                agent.child_result = true;
            }
        } else {
            // `note(agent, type, item)`: item, not frame.data, so diagnostics push.
            translator
                .diagnostics
                .push(raw_payload(&item_type, &item_value, None));
            facts.push(super::facts::signal_fact(Some(&agent_key)));
        }
        return;
    }
    // Collab spawn receivers are discovered before the open is recorded.
    if item_type == "collabAgentToolCall" && str_empty(item_map.get("tool")) == "spawnAgent" {
        let receivers: Vec<String> = list_of(item_map.get("receiverThreadIds"))
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .filter(|s| !s.is_empty())
            .collect();
        for child in receivers {
            let native = agent_native.to_owned();
            let spawned_by = item_id.clone();
            translator.discover_agent(
                &child,
                &item_map,
                facts,
                now,
                super::registry::DiscoverOptions {
                    parent: Some(&native),
                    spawned_by: Some(&spawned_by),
                    revision: None,
                },
            );
            let (child_turn, child_had_turn) = translator
                .agents
                .get(&child)
                .map(|a| (a.turn.clone(), a.had_turn))
                .unwrap_or((None, false));
            if child_turn.is_some() || !child_had_turn {
                let task = super::helpers::child_key(&child);
                translator.tasks.insert(task.clone());
                let child_key = translator
                    .agents
                    .get(&child)
                    .map(|a| a.key.clone())
                    .unwrap_or(child.clone());
                let mut body = Map::with_capacity(7);
                body.insert("agent".to_owned(), Value::String(agent_key.clone()));
                body.insert("task".to_owned(), Value::String(task));
                body.insert("childAgent".to_owned(), Value::String(child_key));
                body.insert("item".to_owned(), Value::String(item_id.clone()));
                body.insert("kind".to_owned(), Value::String("subagent".to_owned()));
                let prompt = str_empty(item_map.get("prompt")).to_owned();
                body.insert(
                    "title".to_owned(),
                    Value::String(if prompt.is_empty() {
                        "Subagent".to_owned()
                    } else {
                        prompt
                    }),
                );
                body.insert("stoppable".to_owned(), Value::Bool(true));
                facts.push(fact("background.started", body));
            }
        }
    }
    let previous = translator
        .agents
        .get(agent_native)
        .and_then(|a| a.open.get(&item_id))
        .map(|open| (open.data.clone(), open.stream_started));
    if !complete {
        let mut metadata = item_map.clone();
        metadata.remove("aggregatedOutput");
        let turn = str_empty(p.get("turnId")).to_owned();
        let agent_turn = translator
            .agents
            .get(agent_native)
            .and_then(|a| a.turn.clone())
            .unwrap_or_default();
        let turn = if turn.is_empty() { agent_turn } else { turn };
        if let Some(agent) = translator.agents.get_mut(agent_native) {
            agent.open.insert(
                item_id.clone(),
                super::state::OpenItem {
                    data: Value::Object(metadata),
                    turn,
                    stream_started: false,
                    unseen_start: false,
                },
            );
        }
    } else {
        if let Some(agent) = translator.agents.get_mut(agent_native) {
            agent.open.shift_remove(&item_id);
            agent.completed.add(item_id.clone());
        }
    }
    let mut draft = item_draft(&item_map, complete, &item_value);
    // User echo matching adds `origin` and `synthetic` to message drafts.
    if obj_map(&draft).get("type").and_then(|v| v.as_str()) == Some("message")
        && obj_map(&draft).get("role").and_then(|v| v.as_str()) == Some("user")
    {
        let text = obj_map(&draft)
            .get("parts")
            .map(|parts| {
                list_of(Some(parts))
                    .iter()
                    .filter_map(|part| {
                        if obj_map(part).get("type").and_then(|v| v.as_str()) == Some("text") {
                            obj_map(part)
                                .get("text")
                                .and_then(|v| v.as_str())
                                .map(str::to_owned)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<String>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let origin = translator
            .answer_echoes
            .matches(agent_native, &item_id, &text);
        if let Some(origin) = origin
            && let Value::Object(map) = &mut draft
        {
            map.insert("origin".to_owned(), origin);
            map.insert("synthetic".to_owned(), Value::Bool(true));
        }
    }
    if item_type == "plan" && previous.as_ref().is_some_and(|(_, started)| *started) && complete {
        let mut upsert_body = Map::with_capacity(3);
        upsert_body.insert("agent".to_owned(), Value::String(agent_key.clone()));
        upsert_body.insert(
            "item".to_owned(),
            Value::String(format!("codex:plan-stream:{item_id}")),
        );
        let mut notice = Map::with_capacity(2);
        notice.insert("type".to_owned(), Value::String("notice".to_owned()));
        notice.insert("complete".to_owned(), Value::Bool(true));
        upsert_body.insert("draft".to_owned(), Value::Object(notice));
        facts.push(fact("item.upsert", upsert_body));
    }
    if let Some((previous_data, _)) = previous.clone() {
        let previous_map = obj_map(&previous_data).clone();
        let earlier_type = str_empty(previous_map.get("type")).to_owned();
        let earlier_name = previous_map
            .get("tool")
            .or(previous_map.get("name"))
            .cloned();
        let earlier = raw_payload(
            &earlier_type,
            &previous_data,
            earlier_name.as_ref().and_then(|v| v.as_str()),
        );
        if let Value::Object(draft_map) = &mut draft {
            if draft_map.get("type").and_then(|v| v.as_str()) == Some("tool_call") {
                if let Some(Value::Object(call)) = draft_map.get_mut("call") {
                    let mut combined = vec![earlier];
                    if let Some(Value::Array(existing)) = call.get("raw") {
                        combined.extend(existing.clone());
                    }
                    call.insert("raw".to_owned(), Value::Array(combined));
                }
            } else if matches!(
                draft_map.get("type").and_then(|v| v.as_str()),
                Some("message") | Some("reasoning") | Some("notice")
            ) {
                let mut combined = vec![earlier];
                if let Some(Value::Array(existing)) = draft_map.get("raw") {
                    combined.extend(existing.clone());
                }
                draft_map.insert("raw".to_owned(), Value::Array(combined));
            }
        }
    }
    let is_shell_reconciled = obj_map(&draft)
        .get("call")
        .map(obj_map)
        .and_then(|c| c.get("detail"))
        .map(obj_map)
        .and_then(|d| d.get("kind"))
        .and_then(|v| v.as_str())
        == Some("shell");
    if is_shell_reconciled {
        if let Some(Value::String(output)) = item_map.get("aggregatedOutput")
            && let Value::Object(draft_map) = &mut draft
            && let Some(Value::Object(call)) = draft_map.get_mut("call")
            && let Some(Value::Object(detail)) = call.get_mut("detail")
        {
            detail.insert("output".to_owned(), Value::String(output.clone()));
        }
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::String(agent_key.clone()));
        body.insert("item".to_owned(), Value::String(item_id.clone()));
        body.insert("draft".to_owned(), draft);
        facts.push(fact("item.reconciled", body));
    } else {
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::String(agent_key.clone()));
        body.insert("item".to_owned(), Value::String(item_id.clone()));
        body.insert("draft".to_owned(), draft);
        facts.push(fact("item.upsert", body));
    }
    let turn_id = str_empty(p.get("turnId")).to_owned();
    super::item_finish::finish_item(
        translator,
        agent_native,
        super::item_finish::FinishArgs {
            agent_key: agent_key.clone(),
            item_id: item_id.clone(),
            item_map: item_map.clone(),
            item_value: item_value.clone(),
            item_type: item_type.clone(),
            complete,
            frame_channel: frame_channel.to_owned(),
            turn_id,
        },
        facts,
    );
    let _ = now;
}
