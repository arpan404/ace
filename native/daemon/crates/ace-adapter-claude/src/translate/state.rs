// SPDX-License-Identifier: Apache-2.0
//! Translator state for one thread (the port of `state.ts`).
//! Keys stay namespaced per provider process because providers restart
//! counters on resume; only core allocates ace ids.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::json::object;
use super::missing_edges::MissingEdges;
use super::usage::ChildUsage;

pub const ADAPTER_WARNING: &str = "adapter.warning";

#[derive(Clone, Debug)]
pub struct NativeTask {
    pub data: Value,
    pub owner: String,
    pub child: Option<String>,
    pub item: Option<String>,
    pub background: bool,
    pub terminal: bool,
    pub terminal_status: Option<String>,
    pub started: bool,
}

#[derive(Clone, Debug)]
pub struct ChildIdentity {
    pub name: Option<String>,
    pub role: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Interaction {
    pub agent: String,
    pub item: String,
    pub tool_id: String,
    pub request: Value,
}

pub struct ClaudeState {
    pub root: String,
    pub session: String,
    pub model: Option<String>,
    pub cwd: String,
    pub process_id: String,
    pub session_state: Option<String>,
    pub retry_on: Option<String>,
    pub rate_blocks: HashSet<String>,
    pub errors: HashMap<String, Value>,
    pub root_failure: Option<Value>,
    pub run_trigger: String,
    pub wake_until: Option<i64>,
    pub active: HashSet<String>,
    pub seen: HashSet<String>,
    pub tool_owners: HashMap<String, String>,
    pub tool_kinds: HashMap<String, String>,
    pub tool_frames: HashMap<String, i64>,
    pub raw_items: HashMap<String, HashSet<String>>,
    pub child_usage: ChildUsage,
    pub child_usage_overflow: bool,
    pub terminal_children: HashSet<String>,
    pub children: HashMap<String, String>,
    pub bindings: Vec<String>,
    pub native_agents: HashMap<String, String>,
    pub tasks: HashMap<String, NativeTask>,
    pub level: HashSet<String>,
    pub missing: MissingEdges,
    pub interactions: HashMap<String, Interaction>,
    pub facts: Vec<Value>,
    pub diagnostics: Vec<Value>,
    pub sent: bool,
    pub wake: Option<String>,
    pub wake_during_turn: bool,
    pub turn: i64,
    pub native_queued: i64,
    pub content_seen: HashSet<String>,
    pub native_by_agent: HashMap<String, String>,
    pub compaction: Option<String>,
    pub compactions: HashMap<String, Value>,
    pub compact_summaries: HashMap<String, String>,
}

impl ClaudeState {
    pub fn new(root: &str) -> Self {
        ClaudeState {
            root: root.to_owned(),
            session: "initial".to_owned(),
            model: None,
            cwd: String::new(),
            process_id: String::new(),
            session_state: None,
            retry_on: None,
            rate_blocks: HashSet::new(),
            errors: HashMap::new(),
            root_failure: None,
            run_trigger: "unknown".to_owned(),
            wake_until: None,
            active: HashSet::new(),
            seen: HashSet::new(),
            tool_owners: HashMap::new(),
            tool_kinds: HashMap::new(),
            tool_frames: HashMap::new(),
            raw_items: HashMap::new(),
            child_usage: HashMap::new(),
            child_usage_overflow: false,
            terminal_children: HashSet::new(),
            children: HashMap::new(),
            bindings: Vec::new(),
            native_agents: HashMap::new(),
            tasks: HashMap::new(),
            level: HashSet::new(),
            missing: MissingEdges::new(),
            interactions: HashMap::new(),
            facts: Vec::new(),
            diagnostics: Vec::new(),
            sent: false,
            wake: None,
            wake_during_turn: false,
            turn: 0,
            native_queued: 0,
            content_seen: HashSet::new(),
            native_by_agent: HashMap::new(),
            compaction: None,
            compactions: HashMap::new(),
            compact_summaries: HashMap::new(),
        }
    }

    pub fn key(&self, kind: &str, id: &str) -> String {
        if self.process_id.is_empty() {
            format!("claude:{}:{}:{}", self.session, kind, id)
        } else {
            format!(
                "claude:{}:{}:{}:{}",
                self.session, self.process_id, kind, id
            )
        }
    }

    pub fn emit(&mut self, fact: Value) {
        self.facts.push(fact);
    }

    pub fn ensure_root(&mut self, data: &Value) {
        if self.seen.contains(&self.root) {
            if let Some(Value::String(cwd)) = object(data).get("cwd") {
                self.cwd = cwd.clone();
            }
            return;
        }
        let obj = object(data);
        self.session = obj
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("initial")
            .to_owned();
        if self.session.is_empty() {
            self.session = "initial".to_owned();
        }
        self.cwd = obj
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        self.process_id = obj
            .get("process_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        self.seen.insert(self.root.clone());
        self.emit(crate::translate::state_emit::fact_type(
            "process.started",
            |map| {
                let _ = map;
            },
        ));
        let root = self.root.clone();
        let session = self.session.clone();
        let cwd = self.cwd.clone();
        self.emit(crate::translate::state_emit::agent_seen(
            &root, &session, &cwd,
        ));
    }

    pub fn start(&mut self, agent: &str, trigger: &str) {
        if self.active.contains(agent) || self.terminal_children.contains(agent) {
            return;
        }
        self.active.insert(agent.to_owned());
        self.content_seen.remove(agent);
        if agent == self.root {
            self.run_trigger = trigger.to_owned();
            self.wake_until = None;
            self.wake = None;
            self.wake_during_turn = false;
        }
        self.turn += 1;
        let turn_id = self.key("turn", &format!("{}:{}", agent, self.turn));
        self.emit(crate::translate::state_emit::turn_started(
            agent, &turn_id, trigger,
        ));
    }

    pub fn child(
        &mut self,
        spawn: &str,
        owner: &str,
        background: bool,
        native_id: Option<&str>,
        terminal_status: Option<&str>,
        identity: &ChildIdentity,
    ) -> String {
        let by_native = native_id.and_then(|id| self.native_agents.get(id)).cloned();
        let known = self.children.get(spawn).cloned();
        let agent = by_native
            .or(known.clone())
            .unwrap_or_else(|| self.key("child", spawn));
        let fresh = !self.seen.contains(&agent);
        if self.children.get(spawn).map(|s| s.as_str()) != Some(agent.as_str()) {
            self.bindings.push(spawn.to_owned());
        }
        self.children.insert(spawn.to_owned(), agent.clone());
        let native = native_id
            .map(|s| s.to_owned())
            .or_else(|| self.native_by_agent.get(&agent).cloned())
            .unwrap_or_else(|| spawn.to_owned());
        self.emit(crate::translate::state_emit::child_seen(
            &agent,
            owner,
            &self.key("tool", spawn),
            &self.cwd,
            background,
            &native,
            identity,
        ));
        self.seen.insert(agent.clone());
        if let Some(id) = native_id {
            self.native_agents.insert(id.to_owned(), agent.clone());
            self.native_by_agent.insert(agent.clone(), id.to_owned());
        }
        if fresh && terminal_status.is_none() {
            self.start(&agent.clone(), "spawn");
        }
        agent
    }

    pub fn reopen_child(&mut self, agent: &str, spawn: &str) {
        self.terminal_children.remove(agent);
        if !spawn.is_empty() && self.children.get(spawn).map(|s| s.as_str()) != Some(agent) {
            self.children.insert(spawn.to_owned(), agent.to_owned());
            self.bindings.push(spawn.to_owned());
        }
        let again = agent.to_owned();
        self.start(&again, "parent_agent");
    }

    pub fn bind_child(&mut self, spawn: &str, agent: &str) {
        if self.children.get(spawn).map(|s| s.as_str()) == Some(agent) {
            return;
        }
        self.children.insert(spawn.to_owned(), agent.to_owned());
        self.bindings.push(spawn.to_owned());
    }

    pub fn agent_for(&self, data: &Value) -> String {
        let parent = object(data)
            .get("parent_tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if parent.is_empty() {
            return self.root.clone();
        }
        self.children
            .get(parent)
            .cloned()
            .unwrap_or_else(|| self.root.clone())
    }
}
