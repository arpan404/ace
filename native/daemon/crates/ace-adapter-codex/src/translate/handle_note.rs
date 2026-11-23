// SPDX-License-Identifier: Apache-2.0
//! Note frames: session scope, history, discovery, queue and exits.

use ace_core::RawFact;
use serde_json::{Map, Value};

use super::ParsedFrame;
use super::facts::fact;
use super::helpers::{list_of, obj_map, str_empty};
use super::registry::{DiscoverOptions, parse_revision};
use super::state::CodexTranslator;

pub fn handle_note(
    translator: &mut CodexTranslator,
    frame: &ParsedFrame,
    now: i64,
    facts: &mut Vec<RawFact>,
) {
    translator.answer_echoes.note(&frame.data);
    let message = obj_map(&frame.data).clone();
    let event = str_empty(message.get("event")).to_owned();
    if event == "session-scope" {
        translator.scope = str_empty(message.get("scope")).to_owned();
    }
    if event == "thread-history" {
        translator.histories.add(&message);
    }
    if event == "thread-history-omitted" || event == "output-line-dropped" {
        translator.output_lost = true;
        let root = translator.root_key.clone();
        let data = frame.data.clone();
        let signal = translator.note_signal(&root, &event, &data, true);
        facts.push(signal);
    }
    if event == "thread-discovered" {
        let thread_value = translator.histories.complete(&message);
        let thread = obj_map(&thread_value).clone();
        let source = thread
            .get("source")
            .map(obj_map)
            .and_then(|m| m.get("subAgent"))
            .map(obj_map)
            .and_then(|m| m.get("thread_spawn"))
            .map(obj_map)
            .cloned()
            .unwrap_or_default();
        let revision = parse_revision(message.get("revision"));
        let discovered = str_empty(thread.get("id")).to_owned();
        let parent_fallback = str_empty(source.get("parent_thread_id")).to_owned();
        let parent_thread = str_empty(thread.get("parentThreadId")).to_owned();
        let parent_candidate = if !parent_thread.is_empty() {
            parent_thread
        } else {
            parent_fallback
        };
        let root_now = translator.root.clone();
        let parent = if discovered != root_now && !parent_candidate.is_empty() {
            Some(parent_candidate)
        } else {
            None
        };
        let thread_clone = thread.clone();
        translator.discover_agent(
            &discovered,
            &thread_clone,
            facts,
            now,
            DiscoverOptions {
                parent: parent.as_deref(),
                spawned_by: None,
                revision,
            },
        );
    }
    if event == "async-question-answered"
        && translator.async_owners.len() == 1
        && let Some(key) = translator.async_owners.keys().next().cloned()
    {
        translator.recorded_answer = Some(key);
    }
    if event == "discovery-start" {
        let task = match message.get("task") {
            Some(Value::String(s)) => s.clone(),
            _ => "codex:discovery".to_owned(),
        };
        let mut body = Map::with_capacity(7);
        body.insert(
            "agent".to_owned(),
            Value::String(translator.root_key.clone()),
        );
        body.insert("task".to_owned(), Value::String(task));
        body.insert("kind".to_owned(), Value::String("other".to_owned()));
        body.insert(
            "title".to_owned(),
            Value::String("Subagent discovery".to_owned()),
        );
        body.insert("internal".to_owned(), Value::Bool(true));
        body.insert("stoppable".to_owned(), Value::Bool(false));
        facts.push(fact("background.started", body));
    }
    if event == "discovery-finished" {
        let task = match message.get("task") {
            Some(Value::String(s)) => s.clone(),
            _ => "codex:discovery".to_owned(),
        };
        if task == "codex:output-recovery" {
            translator.output_lost = false;
        }
        translator.buffers.clear();
        // `finishUnknown` lives on the registry impl; inline its two lines here
        // to keep this module under the size limit without another hop.
        if translator.unknown_guard
            && translator.buffers.pending() == 0
            && !translator.buffers.is_overflow()
        {
            let mut body = Map::with_capacity(2);
            body.insert(
                "task".to_owned(),
                Value::String("codex:unknown-threads".to_owned()),
            );
            body.insert("status".to_owned(), Value::String("completed".to_owned()));
            facts.push(fact("background.ended", body));
            translator.unknown_guard = false;
        }
        let mut body = Map::with_capacity(2);
        body.insert("task".to_owned(), Value::String(task));
        body.insert("status".to_owned(), Value::String("completed".to_owned()));
        facts.push(fact("background.ended", body));
    }
    if event == "queue-state"
        && let Some(Value::Number(count)) = message.get("count")
    {
        let mut queue_body = Map::with_capacity(1);
        queue_body.insert("count".to_owned(), Value::Number(count.clone()));
        facts.push(fact("queue.changed", queue_body));
        if count.as_i64() == Some(0) {
            for agent in translator.agents.values_mut() {
                if agent.pending_trigger.as_deref() == Some("queue") {
                    agent.pending_trigger = None;
                }
            }
        }
    }
    if event == "stop" {
        translator.deliberate = true;
    }
    if event == "process-exit" {
        let mut body = Map::with_capacity(3);
        body.insert("deliberate".to_owned(), Value::Bool(translator.deliberate));
        body.insert(
            "message".to_owned(),
            Value::String("Codex app-server exited".to_owned()),
        );
        facts.push(fact("process.exited", body));
    }
    if event == "interaction-resolved" {
        let interaction = str_empty(message.get("interaction")).to_owned();
        translator.close_async(&interaction);
        let mut body = Map::with_capacity(2);
        body.insert("interaction".to_owned(), Value::String(interaction));
        body.insert("state".to_owned(), Value::String("resolved".to_owned()));
        facts.push(fact("interaction.closed", body));
    }
    let _ = (now, list_of);
}
