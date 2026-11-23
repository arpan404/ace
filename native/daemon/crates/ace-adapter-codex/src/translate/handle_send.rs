// SPDX-License-Identifier: Apache-2.0
//! Send frames: remember the request so the reply can be correlated.

use ace_core::Fact;
use ace_json::Value;

use super::ParsedFrame;
use super::helpers::{obj_map, str_empty};
use super::state::{CodexTranslator, SentEntry};

pub fn handle_send(translator: &mut CodexTranslator, frame: &ParsedFrame, _facts: &mut Vec<Fact>) {
    let map = obj_map(&frame.data).clone();
    let method = str_empty(map.get("method")).to_owned();
    let id = map.get("id").cloned();
    if !method.is_empty() {
        if let Some(id_value) = id {
            let p = map.get("params").map(obj_map).cloned().unwrap_or_default();
            let lookup = match p.get("threadId") {
                Some(Value::String(s)) => s.to_string(),
                _ => String::new(),
            };
            let native_param = match p.get("threadId") {
                Some(Value::String(s)) => s.to_string(),
                _ => translator.root.clone(),
            };
            let observed_turn = translator
                .agents
                .get(&lookup)
                .and_then(|agent| agent.latest_turn.clone());
            let key = translator.interaction_key(&id_value);
            let interaction = if matches!(method.as_str(), "turn/start" | "turn/steer") {
                translator.recorded_answer.clone()
            } else {
                None
            };
            translator.sent.insert(
                key.clone(),
                SentEntry {
                    method: method.clone(),
                    params: Value::Object(p),
                    interaction,
                    observed_turn,
                },
            );
            if method == "turn/start" {
                translator.completions.open(
                    key,
                    String::from(native_param.clone()),
                    translator
                        .agents
                        .get(&lookup)
                        .and_then(|a| a.latest_turn.clone()),
                );
            }
            translator.recorded_answer = None;
        }
        if method == "thread/start" {
            let p = map.get("params").map(obj_map);
            let cwd = p
                .and_then(|m| m.get("cwd"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            translator.cwd = cwd;
        }
        if method == "turn/start" {
            let p = map.get("params").map(obj_map).cloned().unwrap_or_default();
            let thread_id = str_empty(p.get("threadId")).to_owned();
            if let Some(mode) = p
                .get("collaborationMode")
                .map(obj_map)
                .and_then(|m| m.get("mode"))
                .and_then(|v| v.as_str())
                && let Some(agent) = translator.agents.get_mut(&thread_id)
            {
                agent.mode = mode.to_owned();
            }
        }
    }
}
