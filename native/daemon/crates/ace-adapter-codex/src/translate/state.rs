// SPDX-License-Identifier: Apache-2.0
//! Translator state: the agents and bookkeeping the closure holds.

use std::collections::{HashMap, HashSet};

use ace_json::Value;
use indexmap::{IndexMap, IndexSet};

use super::answer_echo::AnswerEchoes;
use super::history::HistoryAssembly;
use super::pending::PendingCompletions;
use super::retention::{RecentSet, UnknownBuffers};

/// One open item: the exact raw start, retained for reconciliation.
#[derive(Clone)]
pub struct OpenItem {
    pub data: Value,
    pub turn: String,
    pub stream_started: bool,
    pub unseen_start: bool,
}

/// A provider thread the translator has seen.
pub struct Agent {
    pub key: String,
    pub parent: Option<String>,
    pub known: bool,
    pub unknown_task: bool,
    pub recovery_uncertain: bool,
    pub terminal_items: Option<HashSet<String>>,
    pub buffer_lost: bool,
    pub turn: Option<String>,
    pub latest_turn: Option<String>,
    pub had_turn: bool,
    pub mode: String,
    pub model: Option<String>,
    pub open: IndexMap<String, OpenItem>,
    pub items: RecentSet,
    pub completed: RecentSet,
    pub requests: IndexMap<ace_json::JsString, RequestEntry>,
    pub ended: RecentSet,
    pub async_items: HashSet<String>,
    pub children: IndexSet<String>,
    pub plan: Option<PlanEntry>,
    pub pending_trigger: Option<String>,
    pub background_result: bool,
    pub child_result: bool,
    pub unmatched_flag: Option<UnmatchedFlag>,
    pub failure_text: Option<String>,
}

impl Agent {
    pub fn new(key: String, parent: Option<String>, known: bool) -> Self {
        Self {
            key,
            parent,
            known,
            unknown_task: false,
            recovery_uncertain: false,
            terminal_items: None,
            buffer_lost: false,
            turn: None,
            latest_turn: None,
            had_turn: false,
            mode: "default".to_owned(),
            model: None,
            open: IndexMap::new(),
            items: RecentSet::new(),
            completed: RecentSet::new(),
            requests: IndexMap::new(),
            ended: RecentSet::new(),
            async_items: HashSet::new(),
            children: IndexSet::new(),
            plan: None,
            pending_trigger: None,
            background_result: false,
            child_result: false,
            unmatched_flag: None,
            failure_text: None,
        }
    }
}

#[derive(Clone)]
pub struct RequestEntry {
    pub item: String,
    pub turn: String,
}

#[derive(Clone)]
pub struct PlanEntry {
    pub id: String,
    pub text: String,
}

#[derive(Clone)]
pub struct UnmatchedFlag {
    pub data: Value,
    pub since: i64,
}

#[derive(Clone)]
pub struct SentEntry {
    pub method: String,
    pub params: Value,
    pub interaction: Option<String>,
    pub observed_turn: Option<String>,
}

/// The translator closure's owned state.
pub struct CodexTranslator {
    pub thread_id: String,
    pub root_key: String,
    pub agents: IndexMap<String, Agent>,
    pub sent: HashMap<ace_json::JsString, SentEntry>,
    pub recorded_answer: Option<String>,
    pub user_turns: RecentSet,
    pub completions: PendingCompletions,
    pub buffers: UnknownBuffers,
    pub histories: HistoryAssembly,
    pub async_owners: HashMap<String, AsyncOwner>,
    pub unknown_guard: bool,
    pub scope: String,
    pub root: String,
    pub cwd: String,
    pub diagnostics: Vec<Value>,
    pub diagnostic_frame_json: Option<String>,
    pub synthetic: u64,
    pub deliberate: bool,
    pub answer_echoes: AnswerEchoes,
    pub tasks: HashSet<String>,
    pub output_lost: bool,
}

#[derive(Clone)]
pub struct AsyncOwner {
    pub native: String,
    pub item: String,
}

impl CodexTranslator {
    pub fn new(thread_id: String, root_key: String) -> Self {
        Self {
            thread_id,
            root_key,
            agents: IndexMap::new(),
            sent: HashMap::new(),
            recorded_answer: None,
            user_turns: RecentSet::new(),
            completions: PendingCompletions::new(),
            buffers: UnknownBuffers::new(),
            histories: HistoryAssembly::new(),
            async_owners: HashMap::new(),
            unknown_guard: false,
            scope: String::new(),
            root: String::new(),
            cwd: String::new(),
            diagnostics: Vec::new(),
            diagnostic_frame_json: None,
            synthetic: 0,
            deliberate: false,
            answer_echoes: AnswerEchoes::new(),
            tasks: HashSet::new(),
            output_lost: false,
        }
    }

    pub fn interaction_key(&self, id: &Value) -> ace_json::JsString {
        super::helpers::request_key(id, &self.scope)
    }

    pub fn close_async(&mut self, key: &str) {
        self.async_owners.remove(key);
    }
}
