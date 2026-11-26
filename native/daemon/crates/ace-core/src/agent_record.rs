// SPDX-License-Identifier: Apache-2.0
//! The agent row and its stored fold bookkeeping.

use serde::{Deserialize, Serialize};

use crate::item_meta::{AgentMachine, ThreadLineage};
use crate::item_model::NativeRef;
use crate::json_io::{Map, Maybe, de_i64};
use crate::status::{AgentError, AgentStatus, ThreadStatus};
use indexmap::IndexMap;

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
    /// Fields a newer build wrote; the TypeScript validates without stripping and writes the
    /// raw value back, so they travel with the object.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
    /// Fields a newer build wrote. The TypeScript writes this engine-internal record without a
    /// schema, so it never strips what it read: the fields travel through unchanged.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
    /// Fields a newer build wrote. The TypeScript writes this engine-internal record without a
    /// schema, so it never strips what it read: the fields travel through unchanged.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
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
    /// Fields retained from the stored record.
    pub extra: Map,
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
        let extra = map
            .iter()
            .filter(|(key, _)| {
                let key = key.as_str();
                !matches!(key, "agent" | "activity" | "lastSignalAt") && !RECORD_KEYS.contains(&key)
            })
            .map(|(key, value)| (key.clone(), value.clone()))
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
            extra,
        })
    }
}
