// SPDX-License-Identifier: Apache-2.0
//! The bottom-up status derivation of `status.ts`: agent statuses resolve
//! descendants first, with the malformed-tree guard (`starting`, never
//! settled). Recursion over agent links carries a depth bound: restored
//! trees are untrusted nesting, and anything deeper than the bound reads as
//! the malformed guard does.

use std::collections::{HashMap, HashSet};

use crate::emit::{Event, get};
use crate::entity_model::BackgroundTask;
use crate::items::Item;
use crate::json_io::Json;
use crate::state::{AgentRecord, ThreadState};
use crate::status::{AgentStatus, is_settled};
use crate::status_inputs::{
    StatusInputs, is_live_tool, status_inputs, suppresses_active_silence, task_holds_thread,
};

/// Depth bound for resolver recursion over agent links.
const RESOLVE_DEPTH_LIMIT: usize = 4096;

/// One memoized derivation pass.
pub struct StatusResolver<'a> {
    state: &'a ThreadState,
    now: i64,
    inputs: StatusInputs<'a>,
    resolved: HashMap<String, AgentStatus>,
    visiting: HashSet<String>,
    relevant_cache: HashMap<String, bool>,
    relevant_visiting: HashSet<String>,
    waiting: HashSet<String>,
    /// Read persisted statuses instead of deriving them: the completion and
    /// deadline readers run over the stored tree.
    persisted: bool,
}

impl<'a> StatusResolver<'a> {
    /// Start one derivation pass at `now`.
    pub fn new(state: &'a ThreadState, now: i64) -> Self {
        let mut waiting = HashSet::new();
        for item_key in crate::indexes::live_tool_keys(state, None) {
            if let Some(item) = get(&state.items, &item_key) {
                if let Item::ToolCall { call, .. } = item {
                    waiting.insert(call.agent_id.clone());
                }
            }
        }
        for pending_key in crate::indexes::pending_interaction_keys(state, None) {
            if let Some(interaction) = get(&state.interactions, &pending_key) {
                waiting.insert(interaction.agent_id.clone());
            }
        }
        for task_key in crate::indexes::running_task_keys(state, None) {
            if let Some(task) = get(&state.tasks, &task_key) {
                if task_holds_thread(state, task) {
                    waiting.insert(task.agent_id.clone());
                }
            }
        }
        Self {
            state,
            now,
            inputs: status_inputs(state),
            resolved: HashMap::new(),
            visiting: HashSet::new(),
            relevant_cache: HashMap::new(),
            relevant_visiting: HashSet::new(),
            waiting,
            persisted: false,
        }
    }

    /// A pass over the persisted tree, for completion and deadline readers.
    pub fn persisted(state: &'a ThreadState, now: i64) -> Self {
        let mut resolver = Self::new(state, now);
        resolver.persisted = true;
        resolver
    }

    /// Resolve one agent's status, descendants first.
    pub fn resolve(&mut self, key: &str) -> AgentStatus {
        self.resolve_inner(key, 0)
    }

    fn resolve_inner(&mut self, key: &str, depth: usize) -> AgentStatus {
        if let Some(cached) = self.resolved.get(key) {
            return cached.clone();
        }
        if depth > RESOLVE_DEPTH_LIMIT {
            // Deeper than any real tree: read as the malformed guard does.
            return AgentStatus::Starting;
        }
        let record = match get(&self.state.agents, key) {
            Some(record) => record.clone(),
            None => return AgentStatus::Starting,
        };
        if self.persisted {
            return record.agent.status.clone();
        }
        // A malformed restored tree must not recurse forever or look settled.
        if !self.visiting.insert(key.to_owned()) {
            return AgentStatus::Starting;
        }
        let mut status = self.derive(&record, key, depth + 1);
        if record.external_status.is_none()
            && self.state.config.liveness.as_deref() == Some("transport")
            && self.state.process_exit.is_none()
            && record.limited.is_none()
            && !is_settled(&status)
            && (self.now - self.inputs.last_transport_signal_at) as f64
                > self.state.config.silence_ms
        {
            status = AgentStatus::Unresponsive {
                last_signal_at: self.inputs.last_transport_signal_at,
            };
        }
        self.visiting.remove(key);
        self.resolved.insert(key.to_owned(), status.clone());
        status
    }

    fn derive(&mut self, record: &AgentRecord, key: &str, depth: usize) -> AgentStatus {
        let agent = &record.agent;
        if let Some(external) = &record.external_status {
            if let Some(child_thread) = &agent.child_thread_id {
                return crate::external::external_agent_status(external, child_thread);
            }
        }
        let exit = self.state.process_exit.clone();
        if let Some(limited) = &record.limited {
            return AgentStatus::Blocked {
                on: "rate_limit".to_owned(),
                refs: Vec::new(),
                until: limited.until,
                attempt: None,
                message: limited.message.clone(),
            };
        }
        if let Some(exit) = &exit {
            if exit.unsettled.iter().any(|unsettled| unsettled == key) {
                return if exit.deliberate {
                    AgentStatus::Interrupted
                } else {
                    AgentStatus::Failed {
                        error: crate::status::AgentError {
                            kind: "process_exit".to_owned(),
                            message: exit
                                .message
                                .clone()
                                .unwrap_or_else(|| "Provider process exited".to_owned()),
                            code: None,
                            title: None,
                            detail: None,
                            details: None,
                        },
                    }
                };
            }
            if is_settled(&agent.status) {
                return agent.status.clone();
            }
            return if exit.deliberate {
                AgentStatus::Interrupted
            } else {
                AgentStatus::Failed {
                    error: crate::status::AgentError {
                        kind: "process_exit".to_owned(),
                        message: exit
                            .message
                            .clone()
                            .unwrap_or_else(|| "Provider process exited".to_owned()),
                        code: None,
                        title: None,
                        detail: None,
                        details: None,
                    },
                }
            };
        }
        let empty_interactions: Vec<&crate::entity_model::Interaction> = Vec::new();
        let interactions = self
            .inputs
            .interactions_by_agent
            .get(&agent.id)
            .map(|items| items.as_slice())
            .unwrap_or(&empty_interactions);
        let blocking: Vec<String> = interactions
            .iter()
            .filter(|interaction| interaction.blocking)
            .map(|interaction| interaction.id.clone())
            .collect();
        if !blocking.is_empty() {
            return AgentStatus::Blocked {
                on: "human".to_owned(),
                refs: blocking,
                until: None,
                attempt: None,
                message: None,
            };
        }
        if let Some(disconnected_at) = record.disconnected_at {
            return AgentStatus::Unresponsive {
                last_signal_at: disconnected_at,
            };
        }
        if let Some(retry) = &record.retry {
            return AgentStatus::Blocked {
                on: retry.on.clone(),
                refs: Vec::new(),
                until: retry.until,
                attempt: retry.attempt,
                message: retry.message.clone(),
            };
        }
        let empty_children: Vec<String> = Vec::new();
        let _ = &empty_children;
        if record.active_run.is_some() {
            return self.derive_active(record, key, depth);
        }
        if record.wake_until.is_some_and(|until| self.now < until) {
            return AgentStatus::Working {
                activity: "starting_turn".to_owned(),
                item_id: None,
                detail: None,
            };
        }
        if let Some(settled) = &record.process_settled_status {
            return settled.clone();
        }
        if record.last_run.is_none() {
            if Some(key) == self.state.root_key.as_deref()
                && !self.state.has_run
                && agent.fidelity != "placeholder"
            {
                return AgentStatus::Starting;
            }
            let signal = self.inputs.last_subtree_signal.read(key);
            if (self.now - signal) as f64 > self.state.config.silence_ms {
                return AgentStatus::Unresponsive {
                    last_signal_at: signal,
                };
            }
            return AgentStatus::Starting;
        }
        let background_refs = self.background_refs(agent, depth);
        if !background_refs.is_empty() {
            return AgentStatus::Blocked {
                on: "background_task".to_owned(),
                refs: background_refs,
                until: None,
                attempt: None,
                message: None,
            };
        }
        let last_run = record.last_run.as_deref().unwrap_or("");
        let run_state = self.state.runs.get(last_run).map(|run| run.state.clone());
        match run_state.as_deref() {
            Some("interrupted") => AgentStatus::Interrupted,
            Some("failed") => AgentStatus::Failed {
                error: record
                    .last_error
                    .clone()
                    .unwrap_or(crate::status::AgentError {
                        kind: "unknown".to_owned(),
                        message: "Agent turn failed".to_owned(),
                        code: None,
                        title: None,
                        detail: None,
                        details: None,
                    }),
            },
            _ => AgentStatus::Idle,
        }
    }

    /// Live children of one agent, for deadline eligibility.
    pub fn live_children_count(&mut self, agent_id: &str) -> usize {
        self.live_children(agent_id, 0).len()
    }

    fn live_children(&mut self, agent_id: &str, depth: usize) -> Vec<String> {
        let children: Vec<String> = self
            .inputs
            .children
            .get(agent_id)
            .map(|keys| keys.keys().cloned().collect())
            .unwrap_or_default();
        children
            .into_iter()
            .filter(|child| self.holds_completion(child, depth))
            .collect()
    }

    fn derive_active(&mut self, record: &AgentRecord, key: &str, depth: usize) -> AgentStatus {
        let agent_id = record.agent.id.clone();
        let live_children = self.live_children(&agent_id, depth);
        let waits: Vec<crate::status_inputs::WaitEntry> = self
            .inputs
            .waits_by_agent
            .get(&agent_id)
            .cloned()
            .unwrap_or_default();
        if !waits.is_empty() {
            let mut refs = Vec::new();
            for child in &live_children {
                let awaited = waits.iter().any(|wait| {
                    wait.targets.is_empty() || wait.targets.iter().any(|target| target == child)
                });
                if awaited {
                    if let Some(child_record) = get(&self.state.agents, child) {
                        refs.push(child_record.agent.id.clone());
                    }
                }
            }
            return AgentStatus::Blocked {
                on: "subagents".to_owned(),
                refs,
                until: None,
                attempt: None,
                message: None,
            };
        }
        let tools: Vec<&Item> = self
            .inputs
            .tools_by_agent
            .get(&agent_id)
            .cloned()
            .unwrap_or_default();
        let mut foreground: Vec<String> = Vec::new();
        for item in tools.iter() {
            if let Item::ToolCall { call, .. } = item {
                if !matches!(
                    &call.detail,
                    crate::item_model::ToolDetail::AgentSpawn { .. }
                ) {
                    continue;
                }
                let child_id = match &call.detail {
                    crate::item_model::ToolDetail::AgentSpawn { child_agent_id, .. } => {
                        child_agent_id.clone()
                    }
                    _ => None,
                };
                let Some(child_id) = child_id else {
                    continue;
                };
                let child_key = match get(&self.inputs.by_id, &child_id) {
                    Some(key) => key.clone(),
                    None => continue,
                };
                let child_record = match get(&self.state.agents, &child_key) {
                    Some(record) => record,
                    None => continue,
                };
                if child_record.agent.background || !self.holds_completion(&child_key, depth) {
                    continue;
                }
                foreground.push(child_record.agent.id.clone());
            }
        }
        let mut newest: Option<&Item> = None;
        let mut newest_key: (i64, i64) = (i64::MIN, i64::MIN);
        for item in tools.iter() {
            let Item::ToolCall { call, .. } = item else {
                continue;
            };
            let is_foreground = match &call.detail {
                crate::item_model::ToolDetail::AgentSpawn { child_agent_id, .. } => child_agent_id
                    .as_ref()
                    .is_some_and(|id| foreground.iter().any(|known| known == id)),
                _ => false,
            };
            if is_foreground {
                continue;
            }
            let item_key = (call.started_at, created_of(item));
            if newest.is_none() || item_key >= newest_key {
                newest = Some(*item);
                newest_key = item_key;
            }
        }
        if let Some(Item::ToolCall { call, .. }) = newest {
            return AgentStatus::Working {
                activity: "tool".to_owned(),
                item_id: Some(call.id.clone()),
                detail: None,
            };
        }
        if !foreground.is_empty() {
            let mut refs = foreground;
            refs.sort();
            refs.dedup();
            return AgentStatus::Blocked {
                on: "subagents".to_owned(),
                refs,
                until: None,
                attempt: None,
                message: None,
            };
        }
        let signal = self.inputs.last_subtree_signal.read(key);
        if self.state.config.liveness.as_deref() != Some("transport")
            && !suppresses_active_silence(
                &self.inputs.waiting_owners,
                &agent_id,
                live_children.len(),
            )
            && (self.now - signal) as f64 > self.state.config.silence_ms
        {
            return AgentStatus::Unresponsive {
                last_signal_at: signal,
            };
        }
        AgentStatus::Working {
            activity: record.activity.clone(),
            detail: record.detail.clone(),
            item_id: None,
        }
    }

    fn background_refs(&mut self, agent: &crate::state::Agent, depth: usize) -> Vec<String> {
        let tasks: Vec<(String, Option<String>)> = self
            .inputs
            .tasks_by_agent
            .get(&agent.id)
            .map(|items| {
                items
                    .iter()
                    .map(|task| (task.id.clone(), task.child_agent_id.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut refs: Vec<String> = tasks.iter().map(|(id, _)| id.clone()).collect();
        let live_children = self.live_children(&agent.id, depth);
        for child in &live_children {
            let covered = tasks.iter().any(|(_, child_id)| {
                child_id.as_ref().is_some_and(|child_id| {
                    get(&self.state.agents, child)
                        .map(|record| &record.agent.id == child_id)
                        .unwrap_or(false)
                })
            });
            if !covered {
                if let Some(record) = get(&self.state.agents, child) {
                    refs.push(record.agent.id.clone());
                }
            }
        }
        refs
    }

    /// Whether an agent still owns live work, memoized bottom-up.
    pub fn holds_completion(&mut self, key: &str, depth: usize) -> bool {
        if let Some(cached) = self.relevant_cache.get(key) {
            return *cached;
        }
        if depth > RESOLVE_DEPTH_LIMIT {
            return true;
        }
        if !self.relevant_visiting.insert(key.to_owned()) {
            return true;
        }
        let result = self.relevant_inner(key, depth + 1);
        self.relevant_visiting.remove(key);
        self.relevant_cache.insert(key.to_owned(), result);
        result
    }

    fn relevant_inner(&mut self, key: &str, depth: usize) -> bool {
        let record = match get(&self.state.agents, key) {
            Some(record) => record.clone(),
            None => return false,
        };
        let status = self.resolve_inner(key, depth);
        if is_settled(&status) {
            return false;
        }
        if record.external_status.is_some() {
            return true;
        }
        let waiting = self.waiting.clone();
        let limited_at_rest = key != self.state.root_key.as_deref().unwrap_or("")
            && record.limited.is_some()
            && record.active_run.is_none()
            && record.retry.is_none()
            && record.disconnected_at.is_none()
            && !waiting.contains(&record.agent.id);
        if !limited_at_rest
            && (key == self.state.root_key.as_deref().unwrap_or("")
                || status.state() != "unresponsive"
                || record.disconnected_at.is_some()
                || record.active_run.is_some()
                || record.last_run.is_some()
                || record.retry.is_some()
                || waiting.contains(&record.agent.id))
        {
            return true;
        }
        let agent_id = record.agent.id.clone();
        let children: Vec<String> = self
            .inputs
            .children
            .get(&agent_id)
            .map(|keys| keys.keys().cloned().collect())
            .unwrap_or_default();
        children
            .iter()
            .any(|child| self.holds_completion(child, depth))
    }
}

fn created_of(item: &Item) -> i64 {
    match item {
        Item::Html { base, .. } => base.created_at,
        Item::Image { base, .. } => base.created_at,
        Item::Message { base, .. } => base.created_at,
        Item::DelegationStarted { base, .. } => base.created_at,
        Item::DelegationSettled { base, .. } => base.created_at,
        Item::Reasoning { base, .. } => base.created_at,
        Item::ToolCall { base, .. } => base.created_at,
        Item::Notice { base, .. } => base.created_at,
        Item::Compaction { base, .. } => base.created_at,
        Item::Unknown { base, .. } => base.created_at,
        Item::Artifact { base, .. } => base.created_at,
    }
}

/// Whether an unstarted silent child still counts for completion.
pub fn completion_relevant(resolver: &mut StatusResolver<'_>, key: &str) -> bool {
    resolver.holds_completion(key, 0)
}
