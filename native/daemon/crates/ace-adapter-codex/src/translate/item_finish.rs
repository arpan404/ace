// SPDX-License-Identifier: Apache-2.0
//! Item completion: command actions, waiting, background ends and async questions.

use ace_core::RawFact;
use ace_json::{Map, Value};

use super::command::command_action_items;
use super::facts::{fact, raw_payload};
use super::helpers::{is_async_question, list_of, str_empty};
use super::state::CodexTranslator;

pub struct FinishArgs {
    pub agent_key: String,
    pub item_id: String,
    pub item_map: Map,
    pub item_value: Value,
    pub item_type: String,
    pub complete: bool,
    pub frame_channel: String,
    pub turn_id: String,
}

pub fn finish_item(
    translator: &mut CodexTranslator,
    agent_native: &str,
    args: FinishArgs,
    facts: &mut Vec<RawFact>,
) {
    let agent_key = args.agent_key;
    let item_id = args.item_id;
    let item_map = args.item_map;
    let item_value = args.item_value;
    let item_type = args.item_type;
    let complete = args.complete;
    let frame_channel = args.frame_channel;
    let turn_id = args.turn_id;

    if item_type == "commandExecution" {
        for (key, action_draft) in command_action_items(&item_map, complete) {
            let mut body = Map::with_capacity(3);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("item".to_owned(), Value::from(key));
            body.insert("draft".to_owned(), action_draft);
            facts.push(fact("item.upsert", body));
        }
    }
    if !complete && item_type == "collabAgentToolCall" && str_empty(item_map.get("tool")) == "wait"
    {
        let targets: Vec<Value> = list_of(item_map.get("receiverThreadIds"))
            .iter()
            .filter_map(|v| v.as_str().map(|s| Value::from(s.to_owned())))
            .collect();
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::from(agent_key.clone()));
        body.insert("item".to_owned(), Value::from(item_id.clone()));
        body.insert("targets".to_owned(), Value::from(targets));
        facts.push(fact("subagents.waiting", body));
    }
    if complete && item_type == "commandExecution" {
        let task = super::helpers::shell_key(&item_id);
        translator.tasks.remove(&task);
        let mut body = Map::with_capacity(2);
        body.insert("task".to_owned(), Value::from(task));
        let status = if str_empty(item_map.get("status")) == "failed" {
            "failed"
        } else {
            "completed"
        };
        body.insert("status".to_owned(), Value::from(status.to_owned()));
        facts.push(fact("background.ended", body));
        if frame_channel != "hydration"
            && let Some(agent) = translator.agents.get_mut(agent_native)
        {
            agent.background_result = true;
        }
    }
    if item_type == "agentMessage"
        && complete
        && frame_channel != "hydration"
        && matches_agent_failure(str_empty(item_map.get("text")))
        && let Some(agent) = translator.agents.get_mut(agent_native)
    {
        agent.failure_text = Some(str_empty(item_map.get("text")).to_owned());
    }
    if item_type == "plan"
        && complete
        && frame_channel != "hydration"
        && turn_id
            == translator
                .agents
                .get(agent_native)
                .and_then(|a| a.turn.clone())
                .unwrap_or_default()
        && let Some(agent) = translator.agents.get_mut(agent_native)
    {
        agent.plan = Some(super::state::PlanEntry {
            id: item_id.clone(),
            text: str_empty(item_map.get("text")).to_owned(),
        });
    }
    if is_async_question(&item_value)
        && translator
            .agents
            .get(agent_native)
            .is_none_or(|a| !a.async_items.contains(&item_id))
    {
        if let Some(agent) = translator.agents.get_mut(agent_native) {
            agent.async_items.insert(item_id.clone());
        }
        if frame_channel == "hydration" {
            return;
        }
        let key = super::helpers::async_key(&item_id);
        let native = agent_native.to_owned();
        translator.async_owners.insert(
            key.clone(),
            super::state::AsyncOwner {
                native,
                item: item_id.clone(),
            },
        );
        let mut request_questions = Map::with_capacity(2);
        request_questions.insert("kind".to_owned(), Value::from("question".to_owned()));
        request_questions.insert(
            "questions".to_owned(),
            super::interactions::async_questions(&item_value),
        );
        let mut body = Map::with_capacity(6);
        body.insert("agent".to_owned(), Value::from(agent_key.clone()));
        body.insert("interaction".to_owned(), Value::from(key));
        body.insert("item".to_owned(), Value::from(item_id.clone()));
        body.insert("blocking".to_owned(), Value::Bool(false));
        body.insert("request".to_owned(), Value::Object(request_questions));
        body.insert(
            "raw".to_owned(),
            Value::from(vec![raw_payload(&item_type, &item_value, None)]),
        );
        facts.push(fact("interaction.opened", body));
    }
    if !complete && item_type != "userMessage" {
        let activity = match item_type.as_str() {
            "reasoning" => "thinking",
            "agentMessage" | "plan" => "responding",
            "contextCompaction" => "compacting",
            _ => "tool",
        };
        let mut body = Map::with_capacity(3);
        body.insert("agent".to_owned(), Value::from(agent_key.clone()));
        body.insert("activity".to_owned(), Value::from(activity.to_owned()));
        facts.push(fact("activity", body));
    }
    if item_type == "collabAgentToolCall" && str_empty(item_map.get("tool")) != "wait" {
        for child in list_of(item_map.get("receiverThreadIds")) {
            let target = str_empty(Some(child)).to_owned();
            if target.is_empty() {
                continue;
            }
            if let Some(agent) = translator.agents.get_mut(&target) {
                agent.pending_trigger = Some("parent_agent".to_owned());
            }
        }
    }
}

fn matches_agent_failure(text: &str) -> bool {
    let lower = text.to_lowercase();
    let text_trimmed = text.trim_start();
    let stripped = if lower.starts_with("error:") {
        text_trimmed[6..].trim_start()
    } else {
        text_trimmed
    };
    let stripped_lower = stripped.to_lowercase();
    stripped_lower.starts_with("you\u{2019}ve hit your usage limit")
        || stripped_lower.starts_with("you've hit your usage limit")
        || stripped_lower.starts_with("your usage limit has been reached")
        || stripped_lower.starts_with("rate limit reached")
        || stripped_lower.starts_with("authentication failed")
        || stripped_lower.starts_with("not logged in")
}
