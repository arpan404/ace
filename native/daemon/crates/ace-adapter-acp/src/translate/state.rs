// SPDX-License-Identifier: Apache-2.0
//! Translation state (`state.ts`): agents, tools, requests and the root.

use crate::translate::quirks::QuirksKind;
use ace_json::{JsString, Map, Value};
use indexmap::{IndexMap, IndexSet};

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
    pub native_id: JsString,
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
    pub native_id: JsString,
    pub key: String,
    pub owner_key: String,
    pub owner_native_id: JsString,
    pub data: Map,
    pub status: String,
    pub raw: Vec<Value>,
    pub input_raw: Option<Value>,
    pub initial_raw: Option<Value>,
    pub original_input: Option<Map>,
    pub input_parts: Option<IndexMap<JsString, Value>>,
    pub completed_input: Option<Map>,
    pub finalized: bool,
    pub retired: bool,
    pub uncertain_shell: bool,
    pub child_native_id: Option<JsString>,
    pub child_key: Option<String>,
    pub task: Option<String>,
    pub carried: bool,
    pub hold_task: Option<String>,
    pub declined: bool,
    pub published_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RequestState {
    pub key: JsString,
    pub method: String,
    pub params: Map,
    pub owner_key: String,
    pub owner_native_id: JsString,
    pub request: Value,
    pub tool_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SentRequest {
    pub method: String,
    pub params: Map,
}

#[derive(Debug, Clone)]
pub struct TranslatorIdentity {
    pub generation: String,
    pub cursor: i64,
}

pub struct TranslationState {
    /// Agents by exact native session id (`JsString`, distinguishing lone
    /// surrogates the way JavaScript `Map` keys do).
    pub agents: IndexMap<JsString, AgentState>,
    /// Agent key to native session id, so updates holding the key (as the
    /// TypeScript holds the agent) resolve in O(1) instead of scanning.
    pub agents_by_key: IndexMap<String, JsString>,
    pub owned_tools: IndexMap<String, IndexMap<JsString, String>>,
    pub tools_by_native: IndexMap<JsString, String>,
    pub tools: IndexMap<String, ToolState>,
    pub uncertain_shells: IndexMap<String, ToolState>,
    pub live_tools: IndexSet<String>,
    pub retired_tools: IndexMap<String, usize>,
    pub retired_bytes: usize,
    pub child_background_tools: IndexMap<JsString, IndexSet<String>>,
    pub background_tools: IndexSet<String>,
    pub pending_children: IndexMap<String, JsString>,
    pub child_tools: IndexMap<JsString, String>,
    pub requests: IndexMap<JsString, RequestState>,
    pub sent: IndexMap<JsString, SentRequest>,
    pub loads: IndexSet<JsString>,
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

pub(crate) const SENT_LIMIT: usize = 1024;
pub(crate) const UNCERTAIN_SHELL_LIMIT: usize = 256;
pub(crate) const RETIRED_COUNT_LIMIT: usize = 1024;
pub(crate) const RETIRED_BYTES_LIMIT: usize = 1024 * 1024;

pub fn rpc_key(id: &crate::translate::data::RpcId) -> JsString {
    let mut key = JsString::from(id.typeof_name());
    key.push_str(":");
    key.push_js(&id.display());
    key
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
            native_id: JsString::new(),
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
            agents_by_key: IndexMap::new(),
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
        let generation = ace_json::ser::to_string(&self.identity.generation)
            .unwrap_or_else(|_| "\"\"".to_owned());
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
        let mut all_keys: Vec<JsString> = self.agents.keys().cloned().collect();
        all_keys.sort();
        for key in &all_keys {
            if let Some(agent) = self.agents.get_mut(key) {
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
        self.agents_by_key.clear();
        self.root.active = false;
        self.root.terminal = false;
        self.root.suspended = false;
        self.root.segment.clear();
        self.root.stream = None;
        self.root.cancel_at = None;
        self.root.plan_tool_key = None;
        self.root.implicit_turn = false;
    }

    pub(crate) fn uncertain_key(owner_native_id: &JsString, id: &JsString) -> String {
        // JSON text of the pair: lone surrogates escape as \ud800, so distinct
        // ids keep distinct keys the way `JSON.stringify` does in TypeScript.
        let key = ace_json::ser::to_string(&(owner_native_id, id)).unwrap_or_default();
        if key.is_empty() {
            let mut fallback = String::from("[");
            fallback.push_str(&ace_json::ser::to_string(owner_native_id).unwrap_or_default());
            fallback.push(',');
            fallback.push_str(&ace_json::ser::to_string(id).unwrap_or_default());
            fallback.push(']');
            fallback
        } else {
            key
        }
    }

    /// The agent for a key, as the TypeScript holds the agent object: O(1).
    pub fn agent_by_key(&self, key: &str) -> Option<&AgentState> {
        if key == self.root.key {
            return Some(&self.root);
        }
        let native = self.agents_by_key.get(key)?;
        self.agents.get(native)
    }

    /// The agent for a key, mutably: O(1).
    pub fn agent_by_key_mut(&mut self, key: &str) -> Option<&mut AgentState> {
        if key == self.root.key {
            return Some(&mut self.root);
        }
        let native = self.agents_by_key.get(key)?.clone();
        self.agents.get_mut(&native)
    }

    /// Record a key to native-id mapping for a non-root agent.
    pub fn index_agent(&mut self, key: &str, native_id: &JsString) {
        if key == self.root.key {
            return;
        }
        self.agents_by_key.insert(key.to_owned(), native_id.clone());
    }

    /// Drop a key mapping, returning whether it was present.
    pub fn unindex_agent(&mut self, key: &str) -> bool {
        self.agents_by_key.shift_remove(key).is_some()
    }
}
