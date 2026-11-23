// SPDX-License-Identifier: Apache-2.0
//! Live methods: thread starts, names, interactive requests and turns.

use ace_core::Fact;
use ace_json::{Map, Value};

use super::ParsedFrame;
use super::facts::fact;
use super::helpers::{is_interactive_request, obj_map, str_empty};
use super::registry::DiscoverOptions;
use super::state::CodexTranslator;

pub fn handle_method(
    translator: &mut CodexTranslator,
    frame: &ParsedFrame,
    now: i64,
    facts: &mut Vec<Fact>,
) {
    let map = obj_map(&frame.data).clone();
    let method = str_empty(map.get("method")).to_owned();
    let id = map.get("id").cloned();
    let p = map.get("params").map(obj_map).cloned().unwrap_or_default();
    let p_value = map.get("params").cloned().unwrap_or(Value::Null);
    if method == "thread/started" {
        let thread = p.get("thread").map(obj_map).cloned().unwrap_or_default();
        let native = str_empty(thread.get("id")).to_owned();
        if native.is_empty() {
            if translator.root.is_empty() {
                let root = translator.root_key.clone();
                let data = frame.data.clone();
                facts.push(translator.note_signal(&root, &method, &data, true));
            }
            return;
        }
        if translator.root.is_empty() {
            translator.root = native.clone();
        }
        let root_now = translator.root.clone();
        let parent = str_empty(thread.get("parentThreadId")).to_owned();
        let parent = if parent.is_empty() {
            None
        } else {
            Some(parent)
        };
        translator.discover_agent(
            &native,
            &thread,
            facts,
            now,
            DiscoverOptions {
                parent: parent.as_deref(),
                spawned_by: None,
                revision: None,
            },
        );
        if native == root_now || (root_now.is_empty() && native == translator.root) {
            let name = thread.get("name").cloned().unwrap_or(Value::Null);
            for title_fact in translator.title(&name, &frame.data) {
                facts.push(title_fact);
            }
        }
        return;
    }
    let native = match p.get("threadId") {
        Some(Value::String(s)) => s.to_string(),
        _ => translator.root.clone(),
    };
    if native.is_empty() {
        let root = translator.root_key.clone();
        let data = frame.data.clone();
        let raw_type = if method.is_empty() {
            "unknown".to_owned()
        } else {
            method.clone()
        };
        facts.push(translator.note_signal(&root, &raw_type, &data, true));
        return;
    }
    if method == "thread/name/updated" {
        if native == translator.root {
            let name = p.get("threadName").cloned().unwrap_or(Value::Null);
            for title_fact in translator.title(&name, &frame.data) {
                facts.push(title_fact);
            }
        }
        return;
    }
    let known = translator
        .agents
        .get(&native)
        .is_some_and(|agent| agent.known);
    if native != translator.root && !known {
        let root = translator.root_key.clone();
        let data = frame.data.clone();
        let raw_type = if method.is_empty() {
            "unknown".to_owned()
        } else {
            method.clone()
        };
        facts.push(translator.note_signal(&root, &raw_type, &data, true));
        translator
            .buffers
            .push(String::from(native.clone()), frame_to_value(frame));
        if !translator.unknown_guard {
            translator.unknown_guard = true;
            let mut body = Map::with_capacity(7);
            body.insert("agent".to_owned(), Value::from(root));
            body.insert(
                "task".to_owned(),
                Value::from("codex:unknown-threads".to_owned()),
            );
            body.insert("kind".to_owned(), Value::from("other".to_owned()));
            body.insert(
                "title".to_owned(),
                Value::from("Thread discovery".to_owned()),
            );
            body.insert("internal".to_owned(), Value::Bool(true));
            body.insert("stoppable".to_owned(), Value::Bool(false));
            facts.push(fact("background.started", body));
        }
        return;
    }
    // Known thread: ensure it, then the mandatory signal.
    let native_clone = native.clone();
    {
        let root_clone = translator.root.clone();
        let cwd_clone = translator.cwd.clone();
        let metadata = Map::new();
        let _ = (&root_clone, &cwd_clone);
        translator.ensure_agent(&native_clone, true, facts, &metadata, None);
    }
    let agent_key = translator
        .agents
        .get(&native)
        .map(|a| a.key.clone())
        .unwrap_or_default();
    {
        let mut body = Map::with_capacity(1);
        body.insert("agent".to_owned(), Value::from(agent_key.clone()));
        facts.push(fact("signal", body));
    }
    if is_interactive_request(&method) {
        if let Some(id_value) = id {
            let scope = translator.scope.clone();
            let key = super::helpers::request_key(&id_value, &scope);
            let item = str_empty(p.get("itemId")).to_owned();
            let known_item = translator
                .agents
                .get(&native)
                .is_some_and(|a| a.items.has(&item));
            let native_item = translator
                .agents
                .get(&native)
                .and_then(|a| a.open.get(&item).map(|o| obj_map(&o.data).clone()));
            let opened = super::interactions::open_request(
                &agent_key,
                &key,
                &method,
                &p,
                &p_value,
                known_item,
                native_item.as_ref(),
            );
            facts.extend(opened);
            if !item.is_empty()
                && let Some(agent) = translator.agents.get_mut(&native)
            {
                agent.items.add(item.clone());
            }
            // `agent.requests.set(key, {item, turn: str(p turnId, agent.turn)})`
            let turn = str_empty(p.get("turnId")).to_owned();
            let agent_turn = translator
                .agents
                .get(&native)
                .and_then(|a| a.turn.clone())
                .unwrap_or_default();
            let turn = if turn.is_empty() { agent_turn } else { turn };
            if let Some(agent) = translator.agents.get_mut(&native) {
                agent.requests.insert(
                    key,
                    super::state::RequestEntry {
                        item: item.clone(),
                        turn,
                    },
                );
                agent.unmatched_flag = None;
            }
            // `interaction.closed status:native cancelled`
            let mut body = Map::with_capacity(2);
            body.insert(
                "interaction".to_owned(),
                Value::from(format!("status:{native}")),
            );
            body.insert("state".to_owned(), Value::from("cancelled".to_owned()));
            facts.push(fact("interaction.closed", body));
        }
        return;
    }
    if method == "serverRequest/resolved" {
        let key = translator.interaction_key(p.get("requestId").unwrap_or(&Value::Null));
        let mut body = Map::with_capacity(2);
        body.insert("interaction".to_owned(), Value::from(key.clone()));
        body.insert("state".to_owned(), Value::from("resolved".to_owned()));
        facts.push(fact("interaction.closed", body));
        let (item, should_upsert) = match translator.agents.get(&native) {
            Some(agent) => match agent.requests.get(&key) {
                Some(req) => {
                    let item = req.item.clone();
                    let should = !item.is_empty() && !agent.open.contains_key(&item);
                    (item, should)
                }
                None => (String::new(), false),
            },
            None => (String::new(), false),
        };
        if should_upsert {
            let mut call = Map::with_capacity(1);
            call.insert("status".to_owned(), Value::from("succeeded".to_owned()));
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
            draft.insert("call".to_owned(), Value::Object(call));
            let mut body = Map::with_capacity(3);
            body.insert("agent".to_owned(), Value::from(agent_key.clone()));
            body.insert("item".to_owned(), Value::from(item.clone()));
            body.insert("draft".to_owned(), Value::Object(draft));
            facts.push(fact("item.upsert", body));
        }
        if let Some(agent) = translator.agents.get_mut(&native) {
            agent.requests.shift_remove(&key);
        }
        return;
    }
    if method == "turn/started" {
        super::handle_turn::handle_turn_started(translator, &native, &p, now, facts);
        return;
    }
    if method == "turn/completed" {
        super::handle_turn::handle_turn_completed(
            translator, &native, &p, &p_value, frame, now, facts,
        );
        return;
    }
    super::handle_live::handle_live(translator, &native, frame, now, facts);
}

fn frame_to_value(frame: &ParsedFrame) -> Value {
    // The buffered frame replays through `handle`; keep its wire shape minimal
    // but sufficient: dir, channel and data. TS buffers the whole Frame.
    let mut map = Map::with_capacity(4);
    map.insert("dir".to_owned(), Value::from(frame.dir.clone()));
    map.insert("channel".to_owned(), Value::from(frame.channel.clone()));
    map.insert("data".to_owned(), frame.data.clone());
    Value::Object(map)
}

pub fn buffered_frame_to_parsed(value: &Value) -> ParsedFrame {
    let map = obj_map(value).clone();
    ParsedFrame {
        dir: str_empty(map.get("dir")).to_owned(),
        channel: str_empty(map.get("channel")).to_owned(),
        data: map.get("data").cloned().unwrap_or(Value::Null),
        seq: 0,
        t: 0,
    }
}
