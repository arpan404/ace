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
use crate::json_io::{Maybe, de_i64};
use crate::runs::Run;
use crate::status::{AgentError, AgentStatus, ThreadStatus};
use indexmap::IndexMap;

/// One provider the thread can run on.
pub fn valid_provider(value: &str) -> bool {
    matches!(
        value,
        "claude" | "codex" | "opencode" | "cursor" | "antigravity" | "acp" | "pi"
    )
}

/// An agent in the thread's tree. Its JSON order is written in `agent_json`.
#[derive(Debug, Clone, Deserialize)]
pub struct Agent {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    pub origin: String,
    pub native: NativeRef,
    pub fidelity: String,
    pub cwd: String,
    pub status: AgentStatus,
    /// Spawned to run in the background.
    #[serde(default)]
    pub background: bool,
    #[serde(rename = "createdAt", deserialize_with = "de_i64")]
    pub created_at: i64,
    /// Tool call in the parent's transcript that spawned this agent.
    #[serde(
        rename = "spawnedBy",
        default,
        deserialize_with = "Maybe::<String>::deserialize",
        serialize_with = "Maybe::<String>::serialize",
        skip_serializing_if = "Maybe::<String>::is_missing"
    )]
    pub spawned_by: Maybe<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<ThreadLineage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// That child runs on another paired machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<AgentMachine>,
    /// Independent ace child thread; this agent is its summary.
    #[serde(rename = "childThreadId", skip_serializing_if = "Option::is_none")]
    pub child_thread_id: Option<String>,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Keys the fold added after the placeholder: JavaScript appends a new own key at the end,
    /// so they serialize after the identity fields, in the order they first appeared.
    #[serde(skip)]
    pub appended: Vec<&'static str>,
}

impl Agent {
    /// Record a key set for the first time, as `agent[key] = value` does for a new key.
    pub fn appended(&mut self, key: &'static str) {
        if !self.appended.contains(&key) {
            self.appended.push(key);
        }
    }
}

/// Rate-limit evidence that survives retry expiry and process exit.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LimitedInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The retry the agent's turn carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryInfo {
    pub on: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One agent's record: its row plus the fold's bookkeeping. Its JSON order is written in
/// `state_json`, because the fields the fold fills in are appended as it sets them; a restored
/// record reads that order back from its JSON.
#[derive(Debug, Clone)]
pub struct AgentRecord {
    pub agent: Agent,
    pub activity: String,
    pub last_signal_at: i64,
    /// The key this record's agent hangs under; absent for a thread's root.
    pub parent_key: Option<String>,
    /// Tool call in the parent's transcript that spawned this agent.
    pub spawned_by_key: Option<String>,
    /// Fields the fold set after the record was created, in the order it first set them.
    pub appended: Vec<&'static str>,
    pub completion_relevant: Option<bool>,
    /// Process-namespaced native turn ids index the canonical run history.
    pub native_runs: Option<IndexMap<String, String>>,
    pub active_run: Option<String>,
    pub last_run: Option<String>,
    pub last_outcome_order: Option<i64>,
    pub last_successful_outcome_order: Option<i64>,
    pub external_status: Option<ThreadStatus>,
    pub last_error: Option<AgentError>,
    pub process_settled_status: Option<AgentStatus>,
    pub detail: Option<String>,
    pub disconnected_at: Option<i64>,
    pub limited: Option<LimitedInfo>,
    pub retry: Option<RetryInfo>,
    pub wake_until: Option<i64>,
}

/// The live indexes over the state's maps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveIndexes {
    #[serde(rename = "liveTools")]
    pub live_tools: IndexMap<String, bool>,
    /// Thoughts, replies and compactions the provider is still streaming into.
    #[serde(rename = "openText")]
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

impl AgentRecord {
    /// Record that a field was set for the first time, as `record[key] = value` does.
    pub fn appended(&mut self, key: &'static str) {
        if !self.appended.contains(&key) {
            self.appended.push(key);
        }
    }
}

/// Every optional key a record can carry, for reading a restored record's own order back.
const RECORD_KEYS: [&str; 16] = [
    "parentKey",
    "spawnedByKey",
    "completionRelevant",
    "nativeRuns",
    "activeRun",
    "lastRun",
    "lastOutcomeOrder",
    "lastSuccessfulOutcomeOrder",
    "externalStatus",
    "lastError",
    "processSettledStatus",
    "detail",
    "disconnectedAt",
    "limited",
    "retry",
    "wakeUntil",
];

impl<'de> serde::Deserialize<'de> for AgentRecord {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<AgentRecord, D::Error> {
        let value =
            crate::json_io::Json::deserialize(deserializer).map_err(serde::de::Error::custom)?;
        let crate::json_io::Json::Object(map) = &value else {
            return Err(serde::de::Error::custom(
                "an agent record must be an object",
            ));
        };
        /// One optional field, decoded; a key the record lacks or holds as null is absent.
        fn read<T: serde::de::DeserializeOwned, E: serde::de::Error>(
            map: &crate::json_io::Map,
            key: &str,
        ) -> Result<Option<T>, E> {
            match map.get(key) {
                None | Some(crate::json_io::Json::Null) => Ok(None),
                Some(value) => crate::json_io::decode(value)
                    .map(Some)
                    .map_err(|error| E::custom(format!("{key}: {error}"))),
            }
        }
        /// One required field, decoded.
        fn one<T: serde::de::DeserializeOwned, E: serde::de::Error>(
            map: &crate::json_io::Map,
            key: &str,
        ) -> Result<T, E> {
            match map.get(key) {
                None => Err(E::custom(format!("agent record needs {key}"))),
                Some(value) => crate::json_io::decode(value)
                    .map_err(|error| E::custom(format!("{key}: {error}"))),
            }
        }
        // The record's own order: the optional keys it carries, in the order its JSON wrote them
        // (a record the fold set out of canonical order keeps that order across a restore).
        let appended: Vec<&'static str> = map
            .keys()
            .filter_map(|key| key.as_well_formed())
            .filter_map(|key| RECORD_KEYS.iter().copied().find(|known| *known == key))
            .collect();
        Ok(AgentRecord {
            agent: one(map, "agent")?,
            activity: one(map, "activity")?,
            last_signal_at: one(map, "lastSignalAt")?,
            parent_key: read(map, "parentKey")?,
            spawned_by_key: read(map, "spawnedByKey")?,
            appended,
            completion_relevant: read(map, "completionRelevant")?,
            native_runs: read(map, "nativeRuns")?,
            active_run: read(map, "activeRun")?,
            last_run: read(map, "lastRun")?,
            last_outcome_order: read(map, "lastOutcomeOrder")?,
            last_successful_outcome_order: read(map, "lastSuccessfulOutcomeOrder")?,
            external_status: read(map, "externalStatus")?,
            last_error: read(map, "lastError")?,
            process_settled_status: read(map, "processSettledStatus")?,
            detail: read(map, "detail")?,
            disconnected_at: read(map, "disconnectedAt")?,
            limited: read(map, "limited")?,
            retry: read(map, "retry")?,
            wake_until: read(map, "wakeUntil")?,
        })
    }
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
