// SPDX-License-Identifier: Apache-2.0
//! Status shapes of `status.ts` and the protocol: priority 1, ported rule
//! for rule in the same order, with the malformed-tree guard (`starting`,
//! never settled). Optional fields serialize omitted, never `null`, exactly
//! like the TypeScript.
//!
//! Decoding here is lenient the way the Zod schemas are: unknown fields are
//! stripped, never fatal. (Items are the opposite: unknown fields reject the
//! fact. That lives in `validate`.)

use crate::json_io::{Json, json_equal};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// What the agent is doing right now while `working`.
pub fn valid_activity(value: &str) -> bool {
    matches!(
        value,
        "thinking" | "responding" | "tool" | "compacting" | "retrying" | "starting_turn"
    )
}

/// Why a non-idle agent is not making progress on its own output.
pub fn valid_blocked_on(value: &str) -> bool {
    matches!(
        value,
        "human" | "subagents" | "queue" | "background_task" | "rate_limit" | "network" | "upstream"
    )
}

/// An agent's status, exactly the protocol shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state")]
pub enum AgentStatus {
    /// Nothing runs yet, or the work has not started.
    #[serde(rename = "starting")]
    Starting,
    /// Making progress on its own output.
    #[serde(rename = "working")]
    Working {
        activity: String,
        #[serde(rename = "itemId", skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Waiting on something else.
    #[serde(rename = "blocked")]
    Blocked {
        on: String,
        #[serde(default)]
        refs: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        until: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Its last turn finished on its own.
    #[serde(rename = "idle")]
    Idle,
    /// Stopped by the user.
    #[serde(rename = "interrupted")]
    Interrupted,
    /// Its last turn failed.
    #[serde(rename = "failed")]
    Failed {
        error: AgentError,
    },
    /// Silent past the silence threshold.
    #[serde(rename = "unresponsive")]
    Unresponsive {
        #[serde(rename = "lastSignalAt")]
        last_signal_at: i64,
    },
}

/// Why an agent's turn failed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<ProviderErrorDetails>,
}

/// Structured provider error detail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderErrorDetails {
    pub code: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Where a moved thread runs now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MovedTo {
    #[serde(rename = "hostId")]
    pub host_id: String,
    pub name: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
}

/// A thread's status, exactly the protocol shape. A state newer than this
/// build reads `unknown` and is kept whole in `raw`, never settled.
#[derive(Debug, Clone)]
pub enum ThreadStatus {
    /// Someone's attention is needed, with the count.
    NeedsYou {
        interactions: i64,
    },
    /// At least one agent works.
    Working {
        agents: i64,
    },
    /// Held on a background task, a limit, or the queue.
    Waiting {
        on: String,
        slot_limit: Option<i64>,
        slots_in_use: Option<i64>,
        queue_position: Option<i64>,
        waiting_for: Option<String>,
    },
    /// Blocked on a usage limit.
    Limited {
        until: Option<i64>,
    },
    /// Something failed after the root's last success.
    Failed,
    /// A live agent went silent.
    Unresponsive,
    /// Its work moved to another machine.
    Moved {
        to: MovedTo,
    },
    /// Every agent idle, nothing pending.
    Done,
    /// Never run.
    New,
    /// A state newer than this build: kept whole, never settled.
    Unknown {
        raw: Box<RawValue>,
    },
}

impl ThreadStatus {
    /// The state tag, for the malformed-tree guard and the moved check.
    pub fn state(&self) -> &str {
        match self {
            Self::NeedsYou { .. } => "needs_you",
            Self::Working { .. } => "working",
            Self::Waiting { .. } => "waiting",
            Self::Limited { .. } => "limited",
            Self::Failed => "failed",
            Self::Unresponsive => "unresponsive",
            Self::Moved { .. } => "moved",
            Self::Done => "done",
            Self::New => "new",
            Self::Unknown { .. } => "unknown",
        }
    }
}

impl AgentStatus {
    /// The state tag, mirroring the protocol.
    pub fn state(&self) -> &str {
        match self {
            Self::Starting => "starting",
            Self::Working { .. } => "working",
            Self::Blocked { .. } => "blocked",
            Self::Idle => "idle",
            Self::Interrupted => "interrupted",
            Self::Failed { .. } => "failed",
            Self::Unresponsive { .. } => "unresponsive",
        }
    }
}

/// Whether an agent status counts as finished for thread `done`.
pub fn is_settled(status: &AgentStatus) -> bool {
    matches!(
        status,
        AgentStatus::Idle | AgentStatus::Interrupted | AgentStatus::Failed { .. }
    )
}

/// JSON equality independent of object property order, like `equal`.
pub fn status_equal(left: &AgentStatus, right: &AgentStatus) -> bool {
    let left_value = serde_json::to_value(left).unwrap_or(Json::Null);
    let right_value = serde_json::to_value(right).unwrap_or(Json::Null);
    json_equal(&left_value, &right_value)
}

/// JSON equality for thread statuses.
pub fn thread_status_equal(left: &ThreadStatus, right: &ThreadStatus) -> bool {
    let left_value = serde_json::to_value(left).unwrap_or(Json::Null);
    let right_value = serde_json::to_value(right).unwrap_or(Json::Null);
    json_equal(&left_value, &right_value)
}
