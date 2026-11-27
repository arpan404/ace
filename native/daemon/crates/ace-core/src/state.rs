// SPDX-License-Identifier: Apache-2.0
//! The folded thread state of `state.ts`. Every field keeps its TypeScript
//! name and shape: the facade refreshes the `ThreadState` tests read from
//! this state after each call, so optional fields are omitted, never `null`,
//! and maps keep insertion order.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::item_meta::{AgentMachine, ThreadLineage};
use crate::item_model::NativeRef;
use crate::items::Item;
use crate::json_io::de_i64;
use crate::runs::Run;
use crate::status::ThreadStatus;

pub use crate::agent_record::{Agent, AgentRecord, LimitedInfo, RetryInfo};
use indexmap::IndexMap;

/// One provider the thread can run on.
pub fn valid_provider(value: &str) -> bool {
    matches!(
        value,
        "claude" | "codex" | "opencode" | "cursor" | "antigravity" | "acp" | "pi"
    )
}

/// The live indexes over the state's maps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveIndexes {
    #[serde(rename = "liveTools")]
    pub live_tools: IndexMap<String, bool>,
    /// Thoughts, replies and compactions the provider is still streaming into.
    /// Absent from snapshots written before the index existed; persistence starts it empty
    /// (`snapshot.ts:115`).
    #[serde(rename = "openText", default)]
    pub open_text: IndexMap<String, bool>,
    #[serde(rename = "pendingInteractions")]
    pub pending_interactions: IndexMap<String, bool>,
    #[serde(rename = "runningTasks")]
    pub running_tasks: IndexMap<String, bool>,
    #[serde(rename = "agentKeysById")]
    pub agent_keys_by_id: IndexMap<String, String>,
    #[serde(rename = "childrenByParent")]
    pub children_by_parent: IndexMap<String, IndexMap<String, bool>>,
    #[serde(rename = "pendingSpawnLinks")]
    pub pending_spawn_links: IndexMap<String, IndexMap<String, bool>>,
    #[serde(rename = "pendingItemLinks")]
    pub pending_item_links: IndexMap<String, bool>,
}

/// The process exit that ended the provider's process, if any.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessExit {
    pub deliberate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub unsettled: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unconfirmed: Option<bool>,
}

/// A deferred rejection notice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingNotice {
    #[serde(rename = "createdAt", deserialize_with = "de_i64")]
    pub created_at: i64,
    pub text: String,
    pub raw: Vec<crate::item_model::RawPayload>,
}

/// Repeats of one rejection within a root run update its first notice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RejectionNotices {
    pub run: String,
    pub notices: IndexMap<String, RejectionNotice>,
}

/// One collapsed rejection notice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RejectionNotice {
    pub item: String,
    pub count: i64,
}

/// The item links waiting on native keys from either side.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ItemLink {
    #[serde(rename = "childAgent", skip_serializing_if = "Option::is_none")]
    pub child_agent: Option<String>,
    #[serde(rename = "targetAgent", skip_serializing_if = "Option::is_none")]
    pub target_agent: Option<String>,
    #[serde(rename = "waitingFor", skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<Vec<String>>,
}

/// The whole folded thread state. Its JSON order is written in `state_json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ThreadState {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub config: CoreConfig,
    #[serde(rename = "rootKey", skip_serializing_if = "Option::is_none")]
    pub root_key: Option<String>,
    /// Consumed on first apply, so initialization needs neither time nor ids.
    #[serde(rename = "initialRoot", skip_serializing_if = "Option::is_none")]
    pub initial_root: Option<RootAgentInit>,
    /// `unconfirmed`: the provider never confirmed its close.
    #[serde(rename = "processExit", skip_serializing_if = "Option::is_none")]
    pub process_exit: Option<ProcessExit>,
    #[serde(
        rename = "lastTransportSignalAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_transport_signal_at: Option<i64>,
    /// Last clock at which derived statuses were observed.
    #[serde(rename = "statusObservedAt", skip_serializing_if = "Option::is_none")]
    pub status_observed_at: Option<i64>,
    pub agents: IndexMap<String, AgentRecord>,
    pub runs: IndexMap<String, Run>,
    pub items: IndexMap<String, Item>,
    pub interactions: IndexMap<String, crate::entity_model::Interaction>,
    pub tasks: IndexMap<String, crate::entity_model::BackgroundTask>,
    /// Optional for snapshots created before uncertain execution existed.
    #[serde(rename = "uncertainTasks", default)]
    pub uncertain_tasks: IndexMap<String, bool>,
    /// ace's own running tasks waiting on the person elsewhere.
    #[serde(rename = "personTasks", skip_serializing_if = "Option::is_none")]
    pub person_tasks: Option<IndexMap<String, bool>>,
    #[serde(rename = "interactionHistory")]
    pub interaction_history: IndexMap<String, crate::entity_model::Interaction>,
    #[serde(rename = "taskHistory")]
    pub task_history: IndexMap<String, crate::entity_model::BackgroundTask>,
    pub indexes: LiveIndexes,
    #[serde(rename = "outcomeOrder", deserialize_with = "de_i64")]
    pub outcome_order: i64,
    /// The last run's `seq`; absent until the thread's first run existed.
    #[serde(rename = "runSeq", skip_serializing_if = "Option::is_none")]
    pub run_seq: Option<i64>,
    /// Rejected facts wait for a real fact to establish their root owner.
    #[serde(rename = "pendingNotices")]
    pub pending_notices: Vec<PendingNotice>,
    #[serde(rename = "rejectionNotices", skip_serializing_if = "Option::is_none")]
    pub rejection_notices: Option<RejectionNotices>,
    #[serde(rename = "itemLinks")]
    pub item_links: IndexMap<String, ItemLink>,
    #[serde(rename = "queueCount", deserialize_with = "de_i64")]
    pub queue_count: i64,
    #[serde(rename = "queueSources")]
    pub queue_sources: QueueSources,
    /// The engine queue holds failed input for the person's retry.
    #[serde(rename = "queueHeld", skip_serializing_if = "Option::is_none")]
    pub queue_held: Option<bool>,
    /// The engine queue is paused by a Stop.
    #[serde(rename = "queueStopped", skip_serializing_if = "Option::is_none")]
    pub queue_stopped: Option<bool>,
    #[serde(rename = "hasRun")]
    pub has_run: bool,
    /// Its work moved to another machine and goes on there.
    #[serde(rename = "movedTo", skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<crate::status::MovedTo>,
    pub status: ThreadStatus,
    /// Fields the fold added after creation, in the order it first set them: JavaScript appends
    /// a new own key at the end, so the state's bytes follow the order the TypeScript built it.
    #[serde(skip)]
    pub appended: Vec<&'static str>,
}

impl ThreadState {
    /// Record that an optional field was set for the first time, as `state[key] = value` does.
    pub fn appended(&mut self, key: &'static str) {
        if !self.appended.contains(&key) {
            self.appended.push(key);
        }
    }
}

/// The engine and provider queue counts behind `queueCount`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueSources {
    pub engine: i64,
    pub provider: i64,
}

/// The fold's configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreConfig {
    /// Provider used for placeholders before an explicit root arrives.
    pub provider: String,
    /// Silence threshold, evaluated against the configured liveness source.
    #[serde(rename = "silenceMs")]
    pub silence_ms: f64,
    /// Defaults to agent silence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liveness: Option<String>,
}

/// The root agent a state starts with, before any fact arrives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootAgentInit {
    pub agent: String,
    #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<ThreadLineage>,
    pub fidelity: String,
    pub native: NativeRef,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    /// A delegated child on another paired machine: where it runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<AgentMachine>,
}

/// The ids only core allocates. Called in the same order as today, so tests
/// that count ids pass.
pub trait IdSource {
    /// Allocate the next ace id of `kind`.
    fn next(&mut self, kind: &str) -> Option<String>;
}

impl<F> IdSource for F
where
    F: FnMut(&str) -> Option<String>,
{
    fn next(&mut self, kind: &str) -> Option<String> {
        self(kind)
    }
}

/// What a fold call owns: the clock, the id sequence, and the engine's
/// resolving interactions. The engine never stores resolving state in core.
pub struct ApplyContext<'a> {
    /// The injected clock's now, a non-negative safe integer.
    pub now: i64,
    /// Core's id sequence.
    pub ids: &'a mut dyn IdSource,
    /// Native answer RPCs the engine owns; never persisted in core state.
    pub resolving_interactions: Option<HashSet<String>>,
}

/// Check a configuration the way creation does: a written config must not be one the
/// constructor would have refused.
pub fn validate_config(config: &CoreConfig) -> Result<(), crate::error::CoreError> {
    if !config.silence_ms.is_finite() || config.silence_ms < 0.0 {
        return Err(crate::error::CoreError::contract(
            "silenceMs must be finite and nonnegative",
        ));
    }
    if !valid_provider(&config.provider) {
        return Err(crate::error::CoreError::contract("unknown provider"));
    }
    if let Some(liveness) = &config.liveness
        && liveness != "agent"
        && liveness != "transport"
    {
        return Err(crate::error::CoreError::contract(
            "liveness must be agent or transport",
        ));
    }
    Ok(())
}

/// Create an empty thread state, like `createThreadState`.
pub fn create_thread_state(
    thread_id: String,
    root_agent: Option<RootAgentInit>,
    config: CoreConfig,
) -> Result<ThreadState, crate::error::CoreError> {
    validate_config(&config)?;
    Ok(ThreadState {
        thread_id,
        config,
        root_key: None,
        initial_root: root_agent,
        process_exit: None,
        last_transport_signal_at: None,
        status_observed_at: None,
        agents: IndexMap::new(),
        runs: IndexMap::new(),
        items: IndexMap::new(),
        interactions: IndexMap::new(),
        tasks: IndexMap::new(),
        uncertain_tasks: IndexMap::new(),
        person_tasks: None,
        interaction_history: IndexMap::new(),
        task_history: IndexMap::new(),
        indexes: LiveIndexes {
            live_tools: IndexMap::new(),
            open_text: IndexMap::new(),
            pending_interactions: IndexMap::new(),
            running_tasks: IndexMap::new(),
            agent_keys_by_id: IndexMap::new(),
            children_by_parent: IndexMap::new(),
            pending_spawn_links: IndexMap::new(),
            pending_item_links: IndexMap::new(),
        },
        outcome_order: 0,
        run_seq: None,
        pending_notices: Vec::new(),
        rejection_notices: None,
        item_links: IndexMap::new(),
        queue_count: 0,
        queue_sources: QueueSources {
            engine: 0,
            provider: 0,
        },
        queue_held: None,
        queue_stopped: None,
        has_run: false,
        moved_to: None,
        status: ThreadStatus::New,
        appended: Vec::new(),
    })
}

#[cfg(test)]
mod extra_tests {
    #[test]
    fn an_unknown_field_survives_a_run_and_an_agent_round_trip() {
        let json = r#"{"id":"r","threadId":"t","agentId":"a","trigger":"user","seq":1,"state":"active","startedAt":1,"futureField":{"a":1}}"#;
        let run: super::Run = serde_json::from_str(json).unwrap();
        let text = serde_json::to_string(&run).unwrap();
        assert!(text.contains(r#""futureField":{"a":1}"#), "{text}");
        let agent = r#"{"id":"a","threadId":"t","origin":"root","native":{"provider":"claude","nativeId":"n"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"background":false,"createdAt":1,"futureAgent":2}"#;
        let agent: super::Agent = serde_json::from_str(agent).unwrap();
        let text = serde_json::to_string(&agent).unwrap();
        assert!(text.contains(r#""futureAgent":2"#), "{text}");
    }
}
