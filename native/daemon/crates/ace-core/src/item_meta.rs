// SPDX-License-Identifier: Apache-2.0
//! Item metadata: provenance, delegation records, and the deeply nested
//! leaves the fold never mutates. Such leaves are validated structurally
//! (allowed keys, scalar shapes) and stored verbatim as `Box<RawValue>`, so
//! clients read back exactly what the adapter sent.

use serde::{Deserialize, Serialize};

pub use crate::item_model::Attachment;
pub use crate::item_model::Vetted;
use crate::status::ThreadStatus;

/// Who sent a person message, and through which route.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct MessageOrigin {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<OriginClient>,
    #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(rename = "interactionId", skip_serializing_if = "Option::is_none")]
    pub interaction_id: Option<String>,
    #[serde(rename = "threadIds", skip_serializing_if = "Option::is_none")]
    pub thread_ids: Option<Vec<String>>,
    #[serde(rename = "parentThreadId", skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<OriginEndpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<OriginEndpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<HandoffModel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lossy: Option<bool>,
    #[serde(rename = "freshSession", skip_serializing_if = "Option::is_none")]
    pub fresh_session: Option<bool>,
    #[serde(rename = "afterExit", skip_serializing_if = "Option::is_none")]
    pub after_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<MessageVia>,
    /// Fields a newer build wrote; the raw record keeps them.
    #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// An outside MCP client that sent for the person.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct OriginClient {
    #[serde(rename = "grantId")]
    pub grant_id: String,
    pub name: String,
}

/// One endpoint of a context handoff.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct OriginEndpoint {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// A provider and model whose work a context handoff carries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct HandoffModel {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// A message sent from another thread by `@` its agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct MessageVia {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One addressee of a message sent with `@` bots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct AddressedTo {
    /// The addressee, kept verbatim (bots, agents, clubs).
    pub to: Vetted,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// ace's line under a message sent with `@` mentions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct AskedLine {
    pub about: String,
    pub to: Vec<AddressedTo>,
    pub devices: Vec<Vetted>,
    pub share: String,
    pub shares: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<String>,
}

/// Optional evidence for a stopped delegation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct DelegationFailure {
    pub code: String,
    pub message: String,
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(rename = "accountLabel", skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(rename = "resetsAt", skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<f64>,
}

/// The outcome of one delegated child thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct DelegationOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<DelegationFailure>,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub outcome: String,
    pub result: String,
    pub truncated: bool,
    pub before: Option<i64>,
}

/// The paired machine a delegated child runs on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct AgentMachine {
    pub machine: String,
    pub name: String,
    #[serde(rename = "hostId", skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,
}

/// A fork point: the run or item a thread was forked from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ForkPoint {
    /// Forked at a run boundary.
    #[serde(rename = "turn")]
    Turn {
        #[serde(rename = "runId")]
        run_id: String,
    },
    /// Forked at an item.
    #[serde(rename = "item")]
    Item {
        #[serde(rename = "itemId")]
        item_id: String,
    },
}

/// Native history lineage, separate from agent ancestry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct ThreadLineage {
    #[serde(rename = "parentThreadId")]
    pub parent_thread_id: String,
    #[serde(rename = "parentAgentId")]
    pub parent_agent_id: String,
    pub point: ForkPoint,
    pub mode: String,
    pub lossy: bool,
}

/// A delegation item records one delegated child thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct DelegationStarted {
    pub origin: String,
    #[serde(rename = "childThreadId")]
    pub child_thread_id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub title: String,
    pub role: String,
    pub phase: String,
    pub status: ThreadStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub generation: i64,
    pub outcome: Option<DelegationOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<AgentMachine>,
}

/// A settled delegation and its results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct DelegationSettled {
    pub origin: String,
    pub results: Vec<DelegationOutcome>,
    pub delivery: String,
}

/// Daemon-captured ace result content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)]
pub enum ToolResultContent {
    /// Text, at most 32 KiB.
    #[serde(rename = "text")]
    Text { text: String },
    /// An image by thread-owned attachment endpoint.
    #[serde(rename = "image")]
    Image { attachment: Attachment },
}

/// Daemon-captured ace results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct ToolResult {
    #[serde(rename = "isError")]
    pub is_error: bool,
    pub content: Vec<ToolResultContent>,
    #[serde(
        rename = "structuredContent",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::json_io::deserialize_opt_raw",
        serialize_with = "crate::json_io::serialize_opt_raw"
    )]
    pub structured_content: Option<ace_json::Raw>,
    #[serde(rename = "durationMs")]
    pub duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ToolResultTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<ToolResultSize>,
}

/// Where an ace result renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct ToolResultTarget {
    #[serde(rename = "bundleId")]
    pub bundle_id: String,
    #[serde(rename = "windowId", skip_serializing_if = "Option::is_none")]
    pub window_id: Option<i64>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// A rendered result's dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct ToolResultSize {
    pub width: i64,
    pub height: i64,
}

/// A bot's words on a reply it posted in the thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde()]
pub struct Speaker {
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<Vetted>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub club: Option<Vetted>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<Vetted>,
    pub about: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
}

/// Provider-internal text shown only inside the compaction's own row.
pub type CompactionSummary = String;

/// Key sets for the vetted leaves, mirroring the protocol schemas so
/// unknown fields reject the fact exactly like `preservesFields` does.
pub mod leaf_keys {
    /// `MessageOrigin`: every key the schema accepts.
    pub const MESSAGE_ORIGIN: &[&str] = &[
        "kind",
        "client",
        "commandId",
        "interactionId",
        "threadIds",
        "role",
        "from",
        "to",
        "sources",
        "lossy",
        "freshSession",
        "afterExit",
        "via",
    ];
    /// `Speaker`: every key the schema accepts.
    pub const SPEAKER: &[&str] = &[
        "kind", "id", "name", "avatar", "club", "machine", "about", "ask",
    ];
    /// `MergedForkContext`: every key the schema accepts.
    pub const MERGED_FORK: &[&str] = &["sourceThreadId", "summary", "citations", "patchApplied"];
    /// `ExecutionSource`: every key the schema accepts.
    pub const EXECUTION_SOURCE: &[&str] = &["nativeSessionId", "selection"];
    /// `InheritedItem`: every key the schema accepts.
    pub const INHERITED_ITEM: &[&str] = &["threadId", "itemId", "at"];
    /// `StepMeasurement`: every key the schema accepts.
    pub const MEASUREMENT: &[&str] = &[
        "source",
        "target",
        "action",
        "refreshHz",
        "windowMs",
        "latencyMs",
        "settleMs",
        "frames",
        "effectiveFps",
        "droppedFrames",
        "hitches",
        "hitchRatioMsPerS",
        "hitchTimeMs",
        "longTasks",
        "layoutShift",
        "verdict",
        "confidence",
        "hostLoad",
        "captureOverheadPct",
        "filmstrip",
        "notes",
        "repeat",
    ];
    /// `InteractionMeasurement` content blocks the reducer never inspects.
    pub const MEASUREMENT_DEEP: &[&str] =
        &["target", "action", "verdict", "confidence", "filmstrip"];
}

#[cfg(test)]
mod origin_extra_tests {
    #[test]
    fn a_message_origins_unknown_field_survives() {
        let json = r#"{"kind":"person","futureOrigin":{"a":1}}"#;
        let origin: super::MessageOrigin = serde_json::from_str(json).unwrap();
        let text = serde_json::to_string(&origin).unwrap();
        assert!(text.contains(r#""futureOrigin":{"a":1}"#), "{text}");
    }
}
