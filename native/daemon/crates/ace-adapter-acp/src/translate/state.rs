// SPDX-License-Identifier: Apache-2.0
//! Translation state (`state.ts`): agents, tools, requests and the root.

use crate::translate::data::raw;
use crate::translate::keys::native_agent_key;
use crate::translate::quirks::QuirksKind;
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct StreamState {
    pub key: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct PlanEntry {
    pub turn: String,
    pub key: String,
}

#[derive(Debug, Clone)]
pub struct AgentState {
    pub key: String,
    pub native_id: String,
    pub parent: Option<String>,
    pub spawn: Option<String>,
    pub active: bool,
    pub terminal: bool,
    pub background: bool,
    pub suspended: bool,
    pub segment: String,
    pub input_key: Option<String>,
    pub stream: Option<StreamState>,
    pub cancel_at: Option<i64>,
    pub plan_tool_key: Option<String>,
    pub pending_spawn_key: Option<String>,
    pub placeholder: bool,
    pub associated: bool,
    pub implicit_turn: bool,
    pub plan_state: Option<PlanEntry>,
}

#[derive(Debug, Clone)]
pub struct ToolState {
    pub native_id: String,
    pub key: String,
    pub owner_key: String,
    pub owner_native_id: String,
    pub data: Map<String, Value>,
    pub status: String,
    pub raw: Vec<Value>,
    pub input_raw: Option<Value>,
    pub initial_raw: Option<Value>,
    pub original_input: Option<Map<String, Value>>,
    pub input_parts: Option<IndexMap<String, Value>>,
    pub completed_input: Option<Map<String, Value>>,
    pub finalized: bool,
    pub retired: bool,
    pub uncertain_shell: bool,
    pub child_native_id: Option<String>,
    pub child_key: Option<String>,
    pub task: Option<String>,
    pub carried: bool,
    pub hold_task: Option<String>,
    pub declined: bool,
    pub published_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RequestState {
    pub key: String,
    pub method: String,
    pub params: Map<String, Value>,
    pub owner_key: String,
    pub owner_native_id: String,
    pub request: Value,
    pub tool_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SentRequest {
    pub method: String,
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct TranslatorIdentity {
    pub generation: String,
    pub cursor: i64,
}

pub struct TranslationState {
    pub agents: IndexMap<String, AgentState>,
    pub owned_tools: IndexMap<String, IndexMap<String, String>>,
    pub tools_by_native: IndexMap<String, String>,
    pub tools: IndexMap<String, ToolState>,
    pub uncertain_shells: IndexMap<String, ToolState>,
    pub live_tools: IndexSet<String>,
    pub retired_tools: IndexMap<String, usize>,
    pub retired_bytes: usize,
    pub child_background_tools: IndexMap<String, IndexSet<String>>,
    pub background_tools: IndexSet<String>,
    pub pending_children: IndexMap<String, String>,
    pub child_tools: IndexMap<String, String>,
    pub requests: IndexMap<String, RequestState>,
    pub sent: IndexMap<String, SentRequest>,
    pub loads: IndexSet<String>,
    pub cancelling: IndexSet<String>,
    pub root: AgentState,
    pub quirks: QuirksKind,
    pub thread_id: String,
    pub cwd: String,
    pub identity: TranslatorIdentity,
    pub diagnostics: Vec<Value>,
    pub prompt_open: bool,
    pub root_cancelled: bool,
    pub stopped: bool,
    pub initialized: bool,
    pub process_dead: bool,
}

const SENT_LIMIT: usize = 1024;
const UNCERTAIN_SHELL_LIMIT: usize = 256;
const RETIRED_COUNT_LIMIT: usize = 1024;
const RETIRED_BYTES_LIMIT: usize = 1024 * 1024;

pub fn rpc_key(id: &crate::translate::data::RpcId) -> String {
    format!("{}:{}", id.typeof_name(), id.display())
}

impl TranslationState {
    pub fn new(
        root_key: String,
        quirks: QuirksKind,
        thread_id: String,
        identity: TranslatorIdentity,
    ) -> Self {
        let root = AgentState {
            key: root_key,
            native_id: String::new(),
            parent: None,
            spawn: None,
            active: false,
            terminal: false,
            background: false,
            suspended: false,
            segment: String::new(),
            input_key: None,
            stream: None,
            cancel_at: None,
            plan_tool_key: None,
            pending_spawn_key: None,
            placeholder: false,
            associated: false,
            implicit_turn: false,
            plan_state: None,
        };
        Self {
            agents: IndexMap::new(),
            owned_tools: IndexMap::new(),
            tools_by_native: IndexMap::new(),
            tools: IndexMap::new(),
            uncertain_shells: IndexMap::new(),
            live_tools: IndexSet::new(),
            retired_tools: IndexMap::new(),
            retired_bytes: 0,
            child_background_tools: IndexMap::new(),
            background_tools: IndexSet::new(),
            pending_children: IndexMap::new(),
            child_tools: IndexMap::new(),
            requests: IndexMap::new(),
            sent: IndexMap::new(),
            loads: IndexSet::new(),
            cancelling: IndexSet::new(),
            root,
            quirks,
            thread_id,
            cwd: String::new(),
            identity,
            diagnostics: Vec::new(),
            prompt_open: false,
            root_cancelled: false,
            stopped: false,
            initialized: false,
            process_dead: false,
        }
    }

    pub fn key(&mut self, kind: &str) -> String {
        self.identity.cursor = self.identity.cursor.saturating_add(1);
        let generation =
            serde_json::to_string(&self.identity.generation).unwrap_or_else(|_| "\"\"".to_owned());
        format!(
            "{}:{}:{}:{}",
            self.root.key, generation, kind, self.identity.cursor
        )
    }

    pub fn reset_process(&mut self) {
        self.prompt_open = false;
        self.root_cancelled = false;
        self.sent.clear();
        self.loads.clear();
        self.cancelling.clear();
        self.requests.clear();
        self.live_tools.clear();
        self.retired_tools.clear();
        self.retired_bytes = 0;
        self.background_tools.clear();
        self.child_background_tools.clear();
        self.tools.clear();
        self.owned_tools.clear();
        self.pending_children.clear();
        self.child_tools.clear();
        self.tools_by_native.clear();
        // Uncertain shells are kept across restarts so a later report can
        // still settle one; only the live indexes above are cleared.
        // Agents keep their objects in TypeScript (same references cleared);
        // here new agents start empty and the root is cleared in place.
        let mut all_keys: Vec<String> = self.agents.keys().cloned().collect();
        all_keys.sort();
        for key in all_keys {
            if let Some(agent) = self.agents.get_mut(&key) {
                agent.active = false;
                agent.terminal = false;
                agent.suspended = false;
                agent.segment.clear();
                agent.stream = None;
                agent.cancel_at = None;
                agent.plan_tool_key = None;
                agent.implicit_turn = false;
            }
        }
        self.agents.clear();
        self.root.active = false;
        self.root.terminal = false;
        self.root.suspended = false;
        self.root.segment.clear();
        self.root.stream = None;
        self.root.cancel_at = None;
        self.root.plan_tool_key = None;
        self.root.implicit_turn = false;
    }

    fn uncertain_key(owner_native_id: &str, id: &str) -> String {
        let key = serde_json::to_string(&(owner_native_id, id)).unwrap_or_default();
        if key.is_empty() {
            format!("[{owner_native_id:?},{id:?}]")
        } else {
            key
        }
    }

    pub fn tool_mut(&mut self, owner_key: &str, owner_native_id: &str, id: &str) -> Option<String> {
        if let Some(owned) = self.owned_tools.get(owner_key)
            && let Some(tool_key) = owned.get(id)
        {
            return Some(tool_key.clone());
        }
        let uncertain = Self::uncertain_key(owner_native_id, id);
        if let Some(retained) = self.uncertain_shells.get(&uncertain).cloned() {
            let tool_key = retained.key.clone();
            let mut restored = retained;
            restored.owner_key = owner_key.to_owned();
            restored.owner_native_id = owner_native_id.to_owned();
            self.tools.insert(tool_key.clone(), restored);
            self.register_tool(owner_key, id, &tool_key);
            return Some(tool_key);
        }
        None
    }

    pub fn tool_key_for_native(&self, native_id: &str) -> Option<String> {
        self.tools_by_native.get(native_id).cloned()
    }

    pub fn retain_uncertain_shell(&mut self, tool_key: &str) {
        let retained = match self.tools.get(tool_key).cloned() {
            Some(tool) => tool,
            None => return,
        };
        let (owner_native_id, native_id) =
            (retained.owner_native_id.clone(), retained.native_id.clone());
        if let Some(tool) = self.tools.get_mut(tool_key) {
            tool.uncertain_shell = true;
        }
        let mut stored = retained;
        stored.uncertain_shell = true;
        let key = Self::uncertain_key(&owner_native_id, &native_id);
        self.uncertain_shells.shift_remove(&key);
        self.uncertain_shells.insert(key, stored);
        if self.uncertain_shells.len() > UNCERTAIN_SHELL_LIMIT
            && let Some((oldest_key, _)) = self
                .uncertain_shells
                .first()
                .map(|(k, v)| (k.clone(), v.clone()))
        {
            self.uncertain_shells.shift_remove(&oldest_key);
            // Clear the flag on any live copy, mirroring the shared reference.
            let mut to_clear: Option<String> = None;
            for (candidate_key, tool) in self.tools.iter() {
                if tool.uncertain_shell {
                    let candidate = Self::uncertain_key(&tool.owner_native_id, &tool.native_id);
                    if candidate == oldest_key {
                        to_clear = Some(candidate_key.clone());
                        break;
                    }
                }
            }
            if let Some(clear_key) = to_clear
                && let Some(tool) = self.tools.get_mut(&clear_key)
            {
                tool.uncertain_shell = false;
            }
        }
    }

    pub fn request(
        &mut self,
        id: &crate::translate::data::RpcId,
        method: &str,
        params: &Map<String, Value>,
    ) {
        let key = rpc_key(id);
        self.sent.insert(
            key.clone(),
            SentRequest {
                method: method.to_owned(),
                params: params.clone(),
            },
        );
        if method == "session/load" {
            self.loads.insert(key.clone());
        }
        if self.sent.len() <= SENT_LIMIT {
            return;
        }
        if let Some((oldest, _)) = self.sent.first().map(|(k, v)| (k.clone(), v.clone())) {
            self.reply_key(&oldest);
        }
    }

    pub fn reply(&mut self, id: &crate::translate::data::RpcId) {
        let key = rpc_key(id);
        self.reply_key(&key);
    }

    fn reply_key(&mut self, key: &str) {
        self.sent.shift_remove(key);
        self.loads.shift_remove(key);
    }

    pub fn arm_cancel(&mut self, agent_key: &str, at: i64) {
        if agent_key == self.root.key {
            self.root.cancel_at = Some(at);
        } else if let Some(agent) = self
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.cancel_at = Some(at);
        } else {
            // The root may be addressed before it has a native id.
            return;
        }
        self.cancelling.insert(agent_key.to_owned());
    }

    pub fn disarm_cancel(&mut self, agent_key: &str) {
        if agent_key == self.root.key {
            self.root.cancel_at = None;
        } else if let Some(agent) = self
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.cancel_at = None;
        }
        self.cancelling.shift_remove(agent_key);
    }

    pub fn settle_shell(&mut self, tool_key: &str) {
        let key = match self.tools.get(tool_key) {
            Some(tool) => Self::uncertain_key(&tool.owner_native_id, &tool.native_id),
            None => return,
        };
        if let Some(tool) = self.tools.get_mut(tool_key) {
            tool.uncertain_shell = false;
        }
        self.uncertain_shells.shift_remove(&key);
    }

    pub fn register_tool(&mut self, owner_key: &str, id: &str, tool_key: &str) {
        self.owned_tools
            .entry(owner_key.to_owned())
            .or_default()
            .insert(id.to_owned(), tool_key.to_owned());
        self.tools_by_native
            .insert(id.to_owned(), tool_key.to_owned());
    }

    pub fn ensure_root(&mut self, facts: &mut Vec<Value>) {
        if self.initialized {
            return;
        }
        self.initialized = true;
        let mut native = Map::with_capacity(2);
        native.insert(
            "provider".to_owned(),
            Value::String(self.quirks.provider().to_owned()),
        );
        if !self.root.native_id.is_empty() {
            native.insert(
                "nativeId".to_owned(),
                Value::String(self.root.native_id.clone()),
            );
        }
        let mut fact = Map::with_capacity(6);
        fact.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
        fact.insert("agent".to_owned(), Value::String(self.root.key.clone()));
        fact.insert("origin".to_owned(), Value::String("root".to_owned()));
        fact.insert("fidelity".to_owned(), Value::String("full".to_owned()));
        fact.insert("native".to_owned(), Value::Object(native));
        fact.insert("cwd".to_owned(), Value::String(self.cwd.clone()));
        facts.push(Value::Object(fact));
    }

    pub fn bind_root(&mut self, id: &str, facts: &mut Vec<Value>) {
        self.root.native_id = id.to_owned();
        let root_snapshot = self.root.clone();
        self.agents.insert(id.to_owned(), root_snapshot);
        let mut native = Map::with_capacity(2);
        native.insert(
            "provider".to_owned(),
            Value::String(self.quirks.provider().to_owned()),
        );
        native.insert("nativeId".to_owned(), Value::String(id.to_owned()));
        let mut fact = Map::with_capacity(6);
        fact.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
        fact.insert("agent".to_owned(), Value::String(self.root.key.clone()));
        fact.insert("origin".to_owned(), Value::String("root".to_owned()));
        fact.insert("fidelity".to_owned(), Value::String("full".to_owned()));
        fact.insert("native".to_owned(), Value::Object(native));
        fact.insert("cwd".to_owned(), Value::String(self.cwd.clone()));
        facts.push(Value::Object(fact));
    }

    fn opening_session(&self) -> bool {
        self.sent
            .values()
            .any(|request| request.method == "session/new")
    }

    /// The agent for a native session id, creating a child when unknown.
    /// Returns the agent's key and whether it was newly created (for fact order).
    pub fn agent_key(&mut self, id: &str, facts: &mut Vec<Value>) -> String {
        if id.is_empty() || id == self.root.native_id {
            return self.root.key.clone();
        }
        if self.agents.contains_key(id) {
            return self
                .agents
                .get(id)
                .map(|agent| agent.key.clone())
                .unwrap_or_default();
        }
        if self.opening_session() {
            self.bind_root(id, facts);
            return self.root.key.clone();
        }
        let key = native_agent_key(&self.thread_id, id);
        let agent = AgentState {
            key: key.clone(),
            native_id: id.to_owned(),
            parent: Some(self.root.key.clone()),
            spawn: None,
            active: false,
            terminal: false,
            background: false,
            suspended: false,
            segment: String::new(),
            input_key: None,
            stream: None,
            cancel_at: None,
            plan_tool_key: None,
            pending_spawn_key: None,
            placeholder: false,
            associated: false,
            implicit_turn: false,
            plan_state: None,
        };
        self.agents.insert(id.to_owned(), agent);
        let mut native = Map::with_capacity(2);
        native.insert(
            "provider".to_owned(),
            Value::String(self.quirks.provider().to_owned()),
        );
        native.insert("nativeId".to_owned(), Value::String(id.to_owned()));
        let mut fact = Map::with_capacity(7);
        fact.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
        fact.insert("agent".to_owned(), Value::String(key.clone()));
        fact.insert("parent".to_owned(), Value::String(self.root.key.clone()));
        fact.insert(
            "origin".to_owned(),
            Value::String("provider_subagent".to_owned()),
        );
        fact.insert("fidelity".to_owned(), Value::String("full".to_owned()));
        fact.insert("native".to_owned(), Value::Object(native));
        fact.insert("cwd".to_owned(), Value::String(self.cwd.clone()));
        facts.push(Value::Object(fact));
        key
    }

    pub fn start(&mut self, agent_key: &str, facts: &mut Vec<Value>, trigger: &str) {
        // agent.reconnected always, even when already active.
        let mut reconnected = Map::with_capacity(2);
        reconnected.insert(
            "type".to_owned(),
            Value::String("agent.reconnected".to_owned()),
        );
        reconnected.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
        facts.push(Value::Object(reconnected));
        let already_active = if agent_key == self.root.key {
            self.root.active
        } else {
            self.agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .is_some_and(|agent| agent.active)
        };
        if already_active {
            return;
        }
        if agent_key == self.root.key {
            self.root.active = true;
            self.root.terminal = false;
            self.root.segment.clear();
        } else if let Some(agent) = self
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.active = true;
            agent.terminal = false;
            agent.segment.clear();
        }
        let mut cleared = Map::with_capacity(2);
        cleared.insert("type".to_owned(), Value::String("retry.cleared".to_owned()));
        cleared.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
        facts.push(Value::Object(cleared));
        let turn_id = self.key("turn");
        let mut started = Map::with_capacity(4);
        started.insert("type".to_owned(), Value::String("turn.started".to_owned()));
        started.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
        started.insert("nativeTurnId".to_owned(), Value::String(turn_id));
        started.insert("trigger".to_owned(), Value::String(trigger.to_owned()));
        facts.push(Value::Object(started));
    }

    pub fn end(
        &mut self,
        agent_key: &str,
        facts: &mut Vec<Value>,
        outcome: &str,
        error: Option<Value>,
    ) {
        self.finish_stream(agent_key, facts);
        if agent_key == self.root.key {
            self.root.active = false;
        } else if let Some(agent) = self
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.active = false;
        }
        let mut ended = Map::with_capacity(4);
        ended.insert("type".to_owned(), Value::String("turn.ended".to_owned()));
        ended.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
        ended.insert("outcome".to_owned(), Value::String(outcome.to_owned()));
        if let Some(error) = error {
            ended.insert("error".to_owned(), error);
        }
        facts.push(Value::Object(ended));
    }

    pub fn finish_stream(&mut self, agent_key: &str, facts: &mut Vec<Value>) {
        let stream = if agent_key == self.root.key {
            self.root.stream.clone()
        } else {
            self.agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .and_then(|agent| agent.stream.clone())
        };
        let Some(stream) = stream else {
            return;
        };
        let mut draft = Map::with_capacity(2);
        if stream.kind == "agent_thought_chunk" {
            draft.insert("type".to_owned(), Value::String("reasoning".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
        } else {
            draft.insert("type".to_owned(), Value::String("message".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
        }
        let mut fact = Map::with_capacity(4);
        fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
        fact.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
        fact.insert("item".to_owned(), Value::String(stream.key));
        fact.insert("draft".to_owned(), Value::Object(draft));
        facts.push(Value::Object(fact));
        if agent_key == self.root.key {
            self.root.stream = None;
        } else if let Some(agent) = self
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.stream = None;
        }
    }

    pub fn notice(
        &mut self,
        facts: &mut Vec<Value>,
        data: &Value,
        typ: &str,
        text: Option<&str>,
        owner_key: Option<&str>,
    ) {
        if let Some(text) = text {
            let item_key = self.key("raw");
            let agent_key = owner_key.unwrap_or(&self.root.key.clone()).to_owned();
            let mut draft = Map::with_capacity(5);
            draft.insert("type".to_owned(), Value::String("notice".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(true));
            draft.insert("level".to_owned(), Value::String("info".to_owned()));
            draft.insert("text".to_owned(), Value::String(text.to_owned()));
            draft.insert("raw".to_owned(), Value::Array(vec![raw(data, typ, None)]));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::String(agent_key));
            fact.insert("item".to_owned(), Value::String(item_key));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        } else {
            self.diagnostics.push(raw(data, typ, None));
        }
    }
}

/// Published payloads belong to canonical storage. Keep only a bounded window.
pub fn retire_tool(state: &mut TranslationState, tool_key: &str) {
    let is_live = state.live_tools.contains(tool_key);
    let is_uncertain = state
        .tools
        .get(tool_key)
        .is_some_and(|tool| tool.uncertain_shell);
    if is_live || is_uncertain {
        return;
    }
    if let Some(tool) = state.tools.get_mut(tool_key) {
        tool.retired = true;
        tool.raw.clear();
        tool.initial_raw = None;
        tool.input_raw = None;
        tool.original_input = None;
    }
    if state.retired_tools.contains_key(tool_key) {
        return;
    }
    let child_terminal = match state.tools.get(tool_key) {
        Some(tool) => match tool.child_native_id.as_deref() {
            Some(child_id) => state
                .agents
                .get(child_id)
                .is_some_and(|child| !child.terminal),
            None => false,
        },
        None => return,
    };
    if child_terminal {
        return;
    }
    let bytes = {
        let tool = match state.tools.get(tool_key) {
            Some(tool) => tool,
            None => return,
        };
        let mut input_entries: Vec<Value> = Vec::new();
        if let Some(parts) = tool.input_parts.as_ref() {
            for (key, value) in parts.iter() {
                input_entries.push(Value::Array(vec![
                    Value::String(key.clone()),
                    value.clone(),
                ]));
            }
        }
        let mut payload = Map::with_capacity(2);
        payload.insert("data".to_owned(), Value::Object(tool.data.clone()));
        payload.insert("input".to_owned(), Value::Array(input_entries));
        serde_json::to_string(&Value::Object(payload))
            .map(|text| text.len())
            .unwrap_or(0)
    };
    state.retired_tools.insert(tool_key.to_owned(), bytes);
    state.retired_bytes = state.retired_bytes.saturating_add(bytes);
    while state.retired_tools.len() > RETIRED_COUNT_LIMIT
        || state.retired_bytes > RETIRED_BYTES_LIMIT
    {
        let Some((oldest_key, cost)) = state.retired_tools.first().map(|(k, v)| (k.clone(), *v))
        else {
            break;
        };
        state.retired_tools.shift_remove(&oldest_key);
        state.retired_bytes = state.retired_bytes.saturating_sub(cost);
        let (owner_key, native_id, child_native_id, plan_owner) = match state.tools.get(&oldest_key)
        {
            Some(tool) => (
                tool.owner_key.clone(),
                tool.native_id.clone(),
                tool.child_native_id.clone(),
                tool.owner_key.clone(),
            ),
            None => continue,
        };
        if let Some(owned) = state.owned_tools.get_mut(&owner_key) {
            if owned.get(&native_id).is_some_and(|key| key == &oldest_key) {
                owned.shift_remove(&native_id);
            }
            if owned.is_empty() {
                state.owned_tools.shift_remove(&owner_key);
            }
        }
        if state
            .tools_by_native
            .get(&native_id)
            .is_some_and(|key| key == &oldest_key)
        {
            state.tools_by_native.shift_remove(&native_id);
        }
        state.tools.shift_remove(&oldest_key);
        // Clear a plan pointer that named the evicted tool.
        if owner_key == plan_owner {
            let clear_root = state.root.key == owner_key
                && state.root.plan_tool_key.as_deref() == Some(oldest_key.as_str());
            if clear_root {
                state.root.plan_tool_key = None;
            }
        }
        for agent in state.agents.values_mut() {
            if agent.plan_tool_key.as_deref() == Some(oldest_key.as_str()) {
                agent.plan_tool_key = None;
            }
        }
        if state.root.plan_tool_key.as_deref() == Some(oldest_key.as_str()) {
            state.root.plan_tool_key = None;
        }
        if let Some(child_id) = child_native_id
            && state
                .child_tools
                .get(&child_id)
                .is_some_and(|key| key == &oldest_key)
        {
            state.child_tools.shift_remove(&child_id);
        }
        state.background_tools.shift_remove(&oldest_key);
    }
}

pub fn renew_tool(state: &mut TranslationState, tool_key: &str) {
    if let Some(cost) = state.retired_tools.shift_remove(tool_key) {
        state.retired_bytes = state.retired_bytes.saturating_sub(cost);
    }
}
