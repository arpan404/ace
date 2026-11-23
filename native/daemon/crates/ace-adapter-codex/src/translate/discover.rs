// SPDX-License-Identifier: Apache-2.0
//! Agent discovery status: replays history turns and recovers terminals.

use ace_core::Fact;
use ace_json::{Map, Value};

use super::facts::fact;
use super::helpers::{list_of, obj_map, str_empty};
use super::registry::Revision;
use super::state::CodexTranslator;

impl CodexTranslator {
    pub(crate) fn discover_status(
        &mut self,
        id: &str,
        p: &Map,
        facts: &mut Vec<Fact>,
        now: i64,
        revision: &Option<Revision>,
    ) {
        let preserve_observed = self.agents.get(id).is_some_and(|a| a.had_turn);
        let current_snapshot = match revision {
            None => true,
            Some(r) => r.read == r.current,
        };
        let turns: Vec<Value> = list_of(p.get("turns")).to_vec();
        let status_type = p
            .get("status")
            .map(obj_map)
            .and_then(|m| m.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        let agent_turn = self.agents.get(id).and_then(|a| a.turn.clone());
        let uncertain = revision.as_ref().is_some_and(|r| r.uncertain);
        let output_recovery = revision.as_ref().is_some_and(|r| r.output_recovery);
        if current_snapshot
            && !uncertain
            && output_recovery
            && agent_turn
                .as_deref()
                .is_some_and(|t| t.starts_with("observed:"))
            && status_type == "idle"
            && !turns.iter().any(|turn| {
                obj_map(turn).get("status").and_then(|v| v.as_str()) == Some("inProgress")
            })
            && let Some(turn) = agent_turn.clone()
        {
            self.replay_hydration(
                "turn/completed",
                ace_json::json!({"threadId": id, "turn": {"id": turn, "status": "completed"}}),
                now,
                facts,
            );
        }
        for turn in &turns {
            let t = obj_map(turn);
            let turn_id = str_empty(t.get("id")).to_owned();
            if turn_id.is_empty() {
                continue;
            }
            let ended = self.agents.get(id).is_some_and(|a| a.ended.has(&turn_id));
            let agent_turn_now = self.agents.get(id).and_then(|a| a.turn.clone());
            let turn_status = str_empty(t.get("status")).to_owned();
            if current_snapshot
                && !ended
                && (!preserve_observed || (agent_turn_now.is_none() && turn_status == "inProgress"))
            {
                self.replay_hydration(
                    "turn/started",
                    ace_json::json!({"threadId": id, "turn": turn}),
                    now,
                    facts,
                );
            }
            for value in list_of(t.get("items")) {
                let item = obj_map(value);
                let item_id = str_empty(item.get("id")).to_owned();
                let completed = self
                    .agents
                    .get(id)
                    .is_some_and(|a| a.completed.has(&item_id));
                if completed {
                    continue;
                }
                let incomplete = str_empty(item.get("status")) == "inProgress";
                let method = if incomplete {
                    "item/started"
                } else {
                    "item/completed"
                };
                self.replay_hydration(
                    method,
                    ace_json::json!({"threadId": id, "turnId": turn_id, "item": value}),
                    now,
                    facts,
                );
            }
            if turn_status != "inProgress" {
                self.replay_hydration(
                    "turn/completed",
                    ace_json::json!({"threadId": id, "turn": turn}),
                    now,
                    facts,
                );
            }
        }
        if current_snapshot
            && !uncertain
            && let Some(live) = revision
                .as_ref()
                .and_then(|r| r.live_terminal_items.clone())
        {
            let live_set: std::collections::HashSet<String> = live.into_iter().collect();
            let terminal: Vec<String> = self
                .agents
                .get(id)
                .and_then(|a| a.terminal_items.clone())
                .map(|s| s.into_iter().collect())
                .unwrap_or_default();
            for item_id in terminal {
                if !live_set.contains(&item_id) {
                    let mut body = Map::with_capacity(2);
                    body.insert(
                        "task".to_owned(),
                        Value::from(super::helpers::shell_key(&item_id)),
                    );
                    body.insert("status".to_owned(), Value::from("completed".to_owned()));
                    facts.push(fact("background.ended", body));
                }
            }
            let mut recovered: std::collections::HashSet<String> = std::collections::HashSet::new();
            for item_id in &live_set {
                let has_open = self
                    .agents
                    .get(id)
                    .is_some_and(|a| a.open.contains_key(item_id));
                if has_open {
                    continue;
                }
                recovered.insert(item_id.clone());
                let had_terminal = self
                    .agents
                    .get(id)
                    .and_then(|a| a.terminal_items.clone())
                    .is_some_and(|s| s.contains(item_id));
                if !had_terminal {
                    let title = recovered_command(&turns, item_id)
                        .unwrap_or("Background command".to_owned());
                    let agent_key = self
                        .agents
                        .get(id)
                        .map(|a| a.key.clone())
                        .unwrap_or_default();
                    let mut body = Map::with_capacity(6);
                    body.insert("agent".to_owned(), Value::from(agent_key));
                    body.insert(
                        "task".to_owned(),
                        Value::from(super::helpers::shell_key(item_id)),
                    );
                    body.insert("kind".to_owned(), Value::from("shell".to_owned()));
                    body.insert("title".to_owned(), Value::from(title));
                    body.insert("stoppable".to_owned(), Value::Bool(true));
                    facts.push(fact("background.started", body));
                }
            }
            if let Some(agent) = self.agents.get_mut(id) {
                agent.terminal_items = Some(recovered);
            }
            let settled: std::collections::HashSet<String> = turns
                .iter()
                .map(obj_map)
                .filter(|t| str_empty(t.get("status")) != "inProgress")
                .map(|t| str_empty(t.get("id")).to_owned())
                .filter(|s| !s.is_empty())
                .collect();
            let opens: Vec<(String, Value, String)> = self
                .agents
                .get(id)
                .map(|a| {
                    a.open
                        .iter()
                        .map(|(item_id, open)| {
                            (item_id.clone(), open.data.clone(), open.turn.clone())
                        })
                        .collect()
                })
                .unwrap_or_default();
            for (item_id, data, open_turn) in opens {
                let data_type = obj_map(&data)
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if data_type != "commandExecution"
                    || !settled.contains(&open_turn)
                    || live_set.contains(&item_id)
                {
                    continue;
                }
                let mut completed = obj_map(&data).clone();
                completed.insert("status".to_owned(), Value::from("completed".to_owned()));
                self.replay_hydration(
                        "item/completed",
                        ace_json::json!({"threadId": id, "turnId": open_turn, "item": Value::Object(completed)}),
                        now,
                        facts,
                    );
            }
        }
        let (agent_turn_now, had_turn_now) = self
            .agents
            .get(id)
            .map(|a| (a.turn.clone(), a.had_turn))
            .unwrap_or((None, false));
        if current_snapshot
            && agent_turn_now.is_none()
            && (!had_turn_now || turns.is_empty())
            && status_type == "active"
        {
            let observed = if revision.as_ref().is_some_and(|r| r.output_recovery) {
                match revision {
                    Some(r) => format!("observed:{id}:{}", r.current as i64),
                    None => format!("observed:{id}"),
                }
            } else {
                format!("observed:{id}")
            };
            if let Some(agent) = self.agents.get_mut(id) {
                agent.turn = Some(observed.clone());
                agent.had_turn = true;
            }
            let agent_key = self
                .agents
                .get(id)
                .map(|a| a.key.clone())
                .unwrap_or_default();
            let mut body = Map::with_capacity(4);
            body.insert("agent".to_owned(), Value::from(agent_key));
            body.insert("nativeTurnId".to_owned(), Value::from(observed));
            body.insert("trigger".to_owned(), Value::from("unknown".to_owned()));
            facts.push(fact("turn.started", body));
        }
    }
}

fn recovered_command(turns: &[Value], item_id: &str) -> Option<String> {
    for turn in turns {
        for value in list_of(obj_map(turn).get("items")) {
            let item = obj_map(value);
            if str_empty(item.get("id")) == item_id
                && str_empty(item.get("type")) == "commandExecution"
            {
                let command = str_empty(item.get("command")).trim().to_owned();
                if command.is_empty() {
                    return None;
                }
                return Some(command);
            }
        }
    }
    None
}
