// SPDX-License-Identifier: Apache-2.0
//! Stored agent status and its wire field order.

use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "state")]
pub enum AgentStatus {
    /// Nothing runs yet, or the work has not started.
    #[serde(rename = "starting")]
    // No unknown fields are possible in this unit variant.
    Starting,
    /// Making progress on its own output.
    #[serde(rename = "working")]
    Working {
        activity: String,
        #[serde(rename = "itemId", skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
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
        /// The pending-retry rule spreads the retry object after `refs`, so its keys come out
        /// `refs, on, attempt, until, message` (see `status.ts`'s `{ state: "blocked", refs:
        /// [], ...record.retry }`). Every other rule writes `on, refs, ...`.
        #[serde(skip)]
        retry_order: bool,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Its last turn finished on its own.
    #[serde(rename = "idle")]
    // No unknown fields are possible in this unit variant.
    Idle,
    /// Stopped by the user.
    #[serde(rename = "interrupted")]
    // No unknown fields are possible in this unit variant.
    Interrupted,
    /// Its last turn failed.
    #[serde(rename = "failed")]
    Failed {
        error: AgentError,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Silent past the silence threshold.
    #[serde(rename = "unresponsive")]
    Unresponsive {
        #[serde(rename = "lastSignalAt")]
        last_signal_at: i64,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
}

impl Serialize for AgentStatus {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap as _;
        let mut map = serializer.serialize_map(None)?;
        let extra = match self {
            Self::Starting => {
                map.serialize_entry("state", "starting")?;
                None
            }
            Self::Working {
                activity,
                item_id,
                detail,
                extra,
            } => {
                map.serialize_entry("state", "working")?;
                map.serialize_entry("activity", activity)?;
                if let Some(item_id) = item_id {
                    map.serialize_entry("itemId", item_id)?;
                }
                if let Some(detail) = detail {
                    map.serialize_entry("detail", detail)?;
                }
                Some(extra)
            }
            Self::Blocked {
                on,
                refs,
                until,
                attempt,
                message,
                retry_order,
                extra,
            } => {
                map.serialize_entry("state", "blocked")?;
                let optional = |map: &mut S::SerializeMap, key: &str, text: Option<&String>| {
                    if let Some(text) = text {
                        map.serialize_entry(key, text)
                    } else {
                        Ok(())
                    }
                };
                let number = |map: &mut S::SerializeMap, key: &str, value: Option<i64>| {
                    if let Some(value) = value {
                        map.serialize_entry(key, &value)
                    } else {
                        Ok(())
                    }
                };
                if *retry_order {
                    map.serialize_entry("refs", refs)?;
                    map.serialize_entry("on", on)?;
                    number(&mut map, "attempt", *attempt)?;
                    number(&mut map, "until", *until)?;
                    optional(&mut map, "message", message.as_ref())?;
                } else {
                    map.serialize_entry("on", on)?;
                    map.serialize_entry("refs", refs)?;
                    number(&mut map, "until", *until)?;
                    number(&mut map, "attempt", *attempt)?;
                    optional(&mut map, "message", message.as_ref())?;
                }
                Some(extra)
            }
            Self::Idle => {
                map.serialize_entry("state", "idle")?;
                None
            }
            Self::Interrupted => {
                map.serialize_entry("state", "interrupted")?;
                None
            }
            Self::Failed { error, extra } => {
                map.serialize_entry("state", "failed")?;
                map.serialize_entry("error", error)?;
                Some(extra)
            }
            Self::Unresponsive {
                last_signal_at,
                extra,
            } => {
                map.serialize_entry("state", "unresponsive")?;
                map.serialize_entry("lastSignalAt", last_signal_at)?;
                Some(extra)
            }
        };
        if let Some(extra) = extra {
            for (key, value) in extra {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
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

impl AgentStatus {
    // packages/core/src/status.ts:210,231,271,298 and external.ts:9-37 build fresh blockers.
    pub(crate) fn blocked(on: &str, refs: Vec<String>, until: Option<i64>) -> Self {
        Self::Blocked {
            on: on.to_owned(),
            refs,
            until,
            attempt: None,
            message: None,
            retry_order: false,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:269-287 and external.ts:11 build fresh working statuses.
    pub(crate) fn working(activity: &str, item_id: Option<String>, detail: Option<String>) -> Self {
        Self::Working {
            activity: activity.to_owned(),
            item_id,
            detail,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:176,213,277,294 and external.ts:26 build silence statuses.
    pub(crate) fn unresponsive(last_signal_at: i64) -> Self {
        Self::Unresponsive {
            last_signal_at,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:189-204,303-306, external.ts:30, and cleanup.ts:156-161 build failures.
    pub(crate) fn failed(error: AgentError) -> Self {
        Self::Failed {
            error,
            extra: Default::default(),
        }
    }

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
