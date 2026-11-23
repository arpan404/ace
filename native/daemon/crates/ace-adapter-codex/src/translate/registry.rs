// SPDX-License-Identifier: Apache-2.0
//! Agent registry: ensure and discover threads, replaying history.

use ace_core::Fact;
use ace_json::{Map, Value};

use super::facts::fact;
use super::helpers::{obj_map, str_empty};
use super::state::{Agent, CodexTranslator};

pub struct Revision {
    pub read: f64,
    pub current: f64,
    pub uncertain: bool,
    pub output_recovery: bool,
    pub live_terminal_items: Option<Vec<String>>,
}

pub fn parse_revision(value: Option<&Value>) -> Option<Revision> {
    let map = obj_map(value?);
    let read = match map.get("read") {
        Some(Value::Number(n)) => n.as_f64()?,
        _ => return None,
    };
    let current = match map.get("current") {
        Some(Value::Number(n)) => n.as_f64()?,
        _ => return None,
    };
    if read < 0.0 || current < 0.0 || read.fract() != 0.0 || current.fract() != 0.0 {
        return None;
    }
    if read > 9_007_199_254_740_991.0 || current > 9_007_199_254_740_991.0 {
        return None;
    }
    let uncertain = match map.get("uncertain") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let output_recovery = match map.get("outputRecovery") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let live_terminal_items = match map.get("liveTerminalItems") {
        None => None,
        Some(Value::Array(items)) => {
            if items.len() > 4096 {
                return None;
            }
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::String(s) => out.push(s.to_string()),
                    _ => return None,
                }
            }
            Some(out)
        }
        Some(_) => return None,
    };
    Some(Revision {
        read,
        current,
        uncertain,
        output_recovery,
        live_terminal_items,
    })
}

struct SeenBody<'a> {
    agent_key: &'a str,
    parent_key: Option<&'a str>,
    spawned_by: Option<&'a str>,
    origin: &'a str,
    fidelity: &'a str,
    native_id: &'a str,
    path: Option<&'a str>,
    cwd: &'a str,
    name: Option<&'a str>,
    role: Option<&'a str>,
}

fn agent_seen_body(seen: SeenBody<'_>) -> Map {
    let agent_key = seen.agent_key;
    let parent_key = seen.parent_key;
    let spawned_by = seen.spawned_by;
    let origin = seen.origin;
    let fidelity = seen.fidelity;
    let native_id = seen.native_id;
    let path = seen.path;
    let cwd = seen.cwd;
    let name = seen.name;
    let role = seen.role;
    let mut body = Map::with_capacity(10);
    body.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
    if let Some(parent) = parent_key {
        body.insert("parent".to_owned(), Value::from(parent.to_owned()));
    }
    if let Some(spawned_by) = spawned_by {
        body.insert("spawnedBy".to_owned(), Value::from(spawned_by.to_owned()));
    }
    body.insert("origin".to_owned(), Value::from(origin.to_owned()));
    body.insert("fidelity".to_owned(), Value::from(fidelity.to_owned()));
    let mut native = Map::with_capacity(3);
    native.insert("provider".to_owned(), Value::from("codex".to_owned()));
    native.insert("nativeId".to_owned(), Value::from(native_id.to_owned()));
    if let Some(path) = path {
        native.insert("path".to_owned(), Value::from(path.to_owned()));
    }
    body.insert("native".to_owned(), Value::Object(native));
    body.insert("cwd".to_owned(), Value::from(cwd.to_owned()));
    if let Some(name) = name
        && !name.is_empty()
    {
        body.insert("name".to_owned(), Value::from(name.to_owned()));
    }
    if let Some(role) = role
        && !role.is_empty()
    {
        body.insert("role".to_owned(), Value::from(role.to_owned()));
    }
    body
}

pub struct DiscoverOptions<'a> {
    pub parent: Option<&'a str>,
    pub spawned_by: Option<&'a str>,
    pub revision: Option<Revision>,
}

impl CodexTranslator {
    pub fn ensure_agent(
        &mut self,
        id: &str,
        known: bool,
        facts: &mut Vec<Fact>,
        metadata: &Map,
        parent: Option<&str>,
    ) -> String {
        if self.agents.contains_key(id) {
            return id.to_owned();
        }
        let is_root = id == self.root;
        let key = if is_root {
            self.root_key.clone()
        } else {
            id.to_owned()
        };
        let parent_owned = parent.map(str::to_owned);
        let agent = Agent::new(key.clone(), parent_owned.clone(), known);
        self.agents.insert(id.to_owned(), agent);
        let parent_key = parent.and_then(|p| self.agents.get(p).map(|a| a.key.clone()));
        let path = metadata
            .get("agentPath")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let cwd = metadata
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or(&self.cwd)
            .to_owned();
        let cwd_clone = self.cwd.clone();
        let cwd_ref = if metadata.get("cwd").and_then(|v| v.as_str()).is_some() {
            cwd
        } else {
            cwd_clone
        };
        let body = agent_seen_body(SeenBody {
            agent_key: &key,
            parent_key: parent_key
                .as_deref()
                .or(if !is_root && !self.root.is_empty() {
                    Some(self.root_key.as_str())
                } else {
                    None
                }),
            spawned_by: None,
            origin: if is_root { "root" } else { "provider_subagent" },
            fidelity: if known { "full" } else { "placeholder" },
            native_id: id,
            path: path.as_deref(),
            cwd: &cwd_ref,
            name: None,
            role: None,
        });
        facts.push(fact("agent.seen", body));
        id.to_owned()
    }

    pub fn discover_agent(
        &mut self,
        id: &str,
        p: &Map,
        facts: &mut Vec<Fact>,
        now: i64,
        options: DiscoverOptions<'_>,
    ) {
        let parent = options.parent;
        let spawned_by = options.spawned_by;
        let revision = options.revision;
        let was_known = self.agents.get(id).is_some_and(|agent| agent.known);
        let parent_owned = parent.map(str::to_owned);
        self.ensure_agent(id, true, facts, p, parent_owned.as_deref());
        if let Some(agent) = self.agents.get_mut(id) {
            agent.known = true;
        }
        let model = p.get("model").cloned();
        if let Some(agent) = self.agents.get_mut(id) {
            let key = agent.key.clone();
            let _ = key;
        }
        // Confirm the model without holding the agent borrow across facts.
        {
            let agent_key = self
                .agents
                .get(id)
                .map(|a| a.key.clone())
                .unwrap_or_default();
            let current_model = self.agents.get(id).and_then(|a| a.model.clone());
            if let Some(Value::String(model_str)) = &model
                && !model_str.is_empty()
                && model_str.encode_utf16().count() <= 256
                && current_model.as_deref() != Some(model_str.as_str())
            {
                if let Some(agent) = self.agents.get_mut(id) {
                    agent.model = Some(String::from(model_str.clone()));
                }
                let mut body = Map::with_capacity(2);
                body.insert("agent".to_owned(), Value::from(agent_key));
                body.insert("model".to_owned(), Value::String(model_str.clone()));
                facts.push(fact("agent.linked", body));
            }
        }
        let (buffered, lost) = if was_known {
            (Vec::new(), false)
        } else {
            self.buffers.take(id)
        };
        if p.get("turns").is_some_and(|v| v.is_array()) {
            let uncertain = revision.as_ref().is_some_and(|r| r.uncertain);
            if let Some(agent) = self.agents.get_mut(id) {
                agent.recovery_uncertain = uncertain;
            }
        }
        if lost && let Some(agent) = self.agents.get_mut(id) {
            agent.buffer_lost = true;
        }
        let (buffer_lost, recovery_uncertain, unknown_task, has_turns) = self
            .agents
            .get(id)
            .map(|a| {
                (
                    a.buffer_lost,
                    a.recovery_uncertain,
                    a.unknown_task,
                    p.get("turns").is_some_and(|v| v.is_array()),
                )
            })
            .unwrap_or((false, false, false, false));
        if ((buffer_lost && !has_turns) || recovery_uncertain) && !unknown_task {
            if let Some(agent) = self.agents.get_mut(id) {
                agent.unknown_task = true;
            }
            let mut body = Map::with_capacity(6);
            body.insert("agent".to_owned(), Value::from(self.root_key.clone()));
            body.insert("task".to_owned(), Value::from(format!("unknown:{id}")));
            body.insert("kind".to_owned(), Value::from("other".to_owned()));
            body.insert(
                "title".to_owned(),
                Value::from("Subagent recovery".to_owned()),
            );
            body.insert("internal".to_owned(), Value::Bool(true));
            body.insert("stoppable".to_owned(), Value::Bool(false));
            facts.push(fact("background.started", body));
        }
        if let Some(parent) = parent_owned.as_deref() {
            let nickname = str_empty(p.get("agentNickname")).to_owned();
            let path_last = str_empty(p.get("agentPath"))
                .split('/')
                .next_back()
                .unwrap_or("")
                .to_owned();
            let name = if !nickname.is_empty() {
                nickname
            } else {
                path_last
            };
            let role = str_empty(p.get("agentRole")).to_owned();
            let parent_key = self
                .agents
                .get(parent)
                .map(|a| a.key.clone())
                .unwrap_or(parent.to_owned());
            let agent_key = self
                .agents
                .get(id)
                .map(|a| a.key.clone())
                .unwrap_or(id.to_owned());
            if let Some(agent) = self.agents.get_mut(id) {
                agent.parent = Some(parent.to_owned());
            }
            if let Some(parent_agent) = self.agents.get_mut(parent) {
                parent_agent.children.insert(id.to_owned());
            }
            let cwd = p
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or(&self.cwd)
                .to_owned();
            let path_opt = p
                .get("agentPath")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let body = agent_seen_body(SeenBody {
                agent_key: &agent_key,
                parent_key: Some(&parent_key),
                spawned_by,
                origin: "provider_subagent",
                fidelity: "full",
                native_id: id,
                path: path_opt.as_deref(),
                cwd: &cwd,
                name: if name.is_empty() { None } else { Some(&name) },
                role: if role.is_empty() { None } else { Some(&role) },
            });
            facts.push(fact("agent.seen", body));
        }
        if p.get("status").is_some() {
            self.discover_status(id, p, facts, now, &revision);
        }
        if !lost || !p.get("turns").is_some_and(|v| v.is_array()) {
            for frame in buffered {
                self.replay_hydration_frame(frame, now, facts);
            }
        }
        let (unknown_task_now, recovery_uncertain_now, buffer_lost_now, has_turns_now) = self
            .agents
            .get(id)
            .map(|a| {
                (
                    a.unknown_task,
                    a.recovery_uncertain,
                    a.buffer_lost,
                    p.get("turns").is_some_and(|v| v.is_array()),
                )
            })
            .unwrap_or((false, false, false, false));
        if unknown_task_now && !recovery_uncertain_now && (!buffer_lost_now || has_turns_now) {
            let mut body = Map::with_capacity(2);
            body.insert("task".to_owned(), Value::from(format!("unknown:{id}")));
            body.insert("status".to_owned(), Value::from("completed".to_owned()));
            facts.push(fact("background.ended", body));
            if let Some(agent) = self.agents.get_mut(id) {
                agent.unknown_task = false;
                agent.buffer_lost = false;
            }
        }
        if has_turns_now && let Some(agent) = self.agents.get_mut(id) {
            agent.buffer_lost = false;
        }
        self.finish_unknown(facts);
    }

    fn finish_unknown(&mut self, facts: &mut Vec<Fact>) {
        if self.unknown_guard && self.buffers.pending() == 0 && !self.buffers.is_overflow() {
            let mut body = Map::with_capacity(2);
            body.insert(
                "task".to_owned(),
                Value::from("codex:unknown-threads".to_owned()),
            );
            body.insert("status".to_owned(), Value::from("completed".to_owned()));
            facts.push(fact("background.ended", body));
            self.unknown_guard = false;
        }
    }
}
