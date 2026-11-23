// SPDX-License-Identifier: Apache-2.0
//! Translation state (`state.ts`): agents, tools, requests and the root.

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

pub(crate) const SENT_LIMIT: usize = 1024;
pub(crate) const UNCERTAIN_SHELL_LIMIT: usize = 256;
pub(crate) const RETIRED_COUNT_LIMIT: usize = 1024;
pub(crate) const RETIRED_BYTES_LIMIT: usize = 1024 * 1024;

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

    pub(crate) fn uncertain_key(owner_native_id: &str, id: &str) -> String {
        let key = serde_json::to_string(&(owner_native_id, id)).unwrap_or_default();
        if key.is_empty() {
            format!("[{owner_native_id:?},{id:?}]")
        } else {
            key
        }
    }
}
