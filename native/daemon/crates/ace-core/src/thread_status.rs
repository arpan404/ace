// SPDX-License-Identifier: Apache-2.0
//! The `ThreadStatus` wire shape: lenient decoding with the Zod union's
//! semantics. Known states validate their fields and keep variant extras;
//! anything newer than this build reads `unknown` and is kept whole in
//! `raw`, never settled.

use crate::json_io::{Json, Map};
use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ThreadStatus {
    /// Someone's attention is needed, with the count.
    NeedsYou {
        interactions: i64,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// At least one agent works.
    Working {
        agents: i64,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Held on a background task, a limit, or the queue.
    #[serde(rename_all = "camelCase")]
    Waiting {
        on: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        slot_limit: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        slots_in_use: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        queue_position: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        waiting_for: Option<String>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Blocked on a usage limit.
    Limited {
        #[serde(skip_serializing_if = "Option::is_none")]
        until: Option<i64>,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Something failed after the root's last success.
    // No unknown fields are possible in this unit variant.
    Failed,
    /// A live agent went silent.
    // No unknown fields are possible in this unit variant.
    Unresponsive,
    /// Its work moved to another machine.
    Moved {
        to: MovedTo,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
    /// Every agent idle, nothing pending.
    // No unknown fields are possible in this unit variant.
    Done,
    /// Never run.
    // No unknown fields are possible in this unit variant.
    New,
    /// A state newer than this build: kept whole, never settled.
    Unknown {
        raw: ace_json::Raw,
        #[serde(flatten, default, skip_serializing_if = "serde_json::Map::is_empty")]
        extra: serde_json::Map<String, serde_json::Value>,
    },
}

impl ThreadStatus {
    // packages/core/src/status.ts:352 builds the attention count.
    pub(crate) fn needs_you(interactions: i64) -> Self {
        Self::NeedsYou {
            interactions,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:365 builds the working count.
    pub(crate) fn working(agents: i64) -> Self {
        Self::Working {
            agents,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:377,386,402,418 builds a fresh waiting status.
    pub(crate) fn waiting(on: &str) -> Self {
        Self::Waiting {
            on: on.to_owned(),
            slot_limit: None,
            slots_in_use: None,
            queue_position: None,
            waiting_for: None,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:375 builds a fresh limit summary.
    pub(crate) fn limited(until: Option<i64>) -> Self {
        Self::Limited {
            until,
            extra: Default::default(),
        }
    }

    // packages/core/src/status.ts:329 wraps the destination in a fresh status.
    pub(crate) fn moved(to: MovedTo) -> Self {
        Self::Moved {
            to,
            extra: Default::default(),
        }
    }

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

/// Whether the moved destination has only its protocol keys.
fn ensure_only(map: &Map, allowed: &[&str]) -> bool {
    map.keys().all(|key| allowed.contains(&key.as_str()))
}

const KNOWN_THREAD_STATES: &[&str] = &[
    "needs_you",
    "working",
    "waiting",
    "limited",
    "failed",
    "unresponsive",
    "moved",
    "done",
    "new",
    "unknown",
];

impl<'de> serde::Deserialize<'de> for ThreadStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;
        // The doorway's own value: JavaScript's numbers and key order, no second parse.
        let Json::Object(map) = Json::deserialize(deserializer)? else {
            return Err(D::Error::custom("thread status must be an object"));
        };
        let state = map.get("state").and_then(Json::as_str).unwrap_or("");
        if !KNOWN_THREAD_STATES.contains(&state) {
            if state.is_empty() || state.chars().count() > 64 {
                return Err(D::Error::custom("invalid thread status"));
            }
            // packages/protocol/src/thread-status.ts:57-60 wraps the raw future status.
            let raw = ace_json::Raw::from_value(&Json::Object(map));
            return Ok(Self::Unknown {
                raw,
                extra: Default::default(),
            });
        }
        let extras = |known: &[&str]| {
            let fields = map
                .iter()
                .filter(|(key, _)| key.as_str() != "state" && !known.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            crate::json_io::decode(&Json::Object(fields)).map_err(D::Error::custom)
        };
        match state {
            "needs_you" => Ok(Self::NeedsYou {
                interactions: crate::json_io::as_count(map.get("interactions"))
                    .filter(|count| *count > 0)
                    .ok_or_else(|| D::Error::custom("invalid thread status"))?,
                extra: extras(&["interactions"])?,
            }),
            "working" => Ok(Self::Working {
                agents: crate::json_io::as_count(map.get("agents"))
                    .filter(|count| *count > 0)
                    .ok_or_else(|| D::Error::custom("invalid thread status"))?,
                extra: extras(&["agents"])?,
            }),
            "waiting" => {
                let on = map.get("on").and_then(|value| value.as_str()).unwrap_or("");
                if !matches!(
                    on,
                    "background_task" | "rate_limit" | "network" | "upstream" | "queue"
                ) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                if is_null(map.get("slotLimit"))
                    || is_null(map.get("slotsInUse"))
                    || is_null(map.get("queuePosition"))
                {
                    return Err(D::Error::custom("invalid thread status"));
                }
                Ok(Self::Waiting {
                    on: on.to_owned(),
                    slot_limit: valid_queue_number(map.get("slotLimit"), 1, 64),
                    slots_in_use: valid_queue_number(map.get("slotsInUse"), 0, i64::MAX),
                    queue_position: valid_queue_number(map.get("queuePosition"), 1, i64::MAX),
                    waiting_for: match map.get("waitingFor") {
                        None => None,
                        Some(Json::Null) => {
                            return Err(D::Error::custom("invalid thread status"));
                        }
                        Some(Json::String(waiting)) if waiting == "storage" => {
                            Some(String::from(waiting))
                        }
                        _ => return Err(D::Error::custom("invalid thread status")),
                    },
                    extra: extras(&[
                        "on",
                        "slotLimit",
                        "slotsInUse",
                        "queuePosition",
                        "waitingFor",
                    ])?,
                })
            }
            "limited" => {
                if matches!(map.get("until"), Some(Json::Null)) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                Ok(Self::Limited {
                    until: match map.get("until") {
                        None => None,
                        Some(until) => Some(
                            crate::json_io::as_count(Some(until))
                                .ok_or_else(|| D::Error::custom("invalid thread status"))?,
                        ),
                    },
                    extra: extras(&["until"])?,
                })
            }
            "failed" if map.len() == 1 => Ok(Self::Failed),
            "unresponsive" if map.len() == 1 => Ok(Self::Unresponsive),
            "moved" => {
                let to = map
                    .get("to")
                    .ok_or_else(|| D::Error::custom("invalid thread status"))?;
                let to_map = match to {
                    Json::Object(map) => map,
                    _ => return Err(D::Error::custom("invalid thread status")),
                };
                if !ensure_only(to_map, &["hostId", "name", "threadId"]) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                let host_id = to
                    .get("hostId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let name = to
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if host_id.is_empty() || name.is_empty() || name.chars().count() > 256 {
                    return Err(D::Error::custom("invalid thread status"));
                }
                let thread_id = to
                    .get("threadId")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if thread_id.is_empty() {
                    return Err(D::Error::custom("invalid thread status"));
                }
                Ok(Self::Moved {
                    to: MovedTo {
                        host_id: host_id.to_owned(),
                        name: name.to_owned(),
                        thread_id: thread_id.to_owned(),
                    },
                    extra: extras(&["to"])?,
                })
            }
            "done" if map.len() == 1 => Ok(Self::Done),
            "new" if map.len() == 1 => Ok(Self::New),
            "unknown" => {
                let raw = match map.get("raw") {
                    Some(raw @ Json::Object(_)) => ace_json::Raw::from_value(raw),
                    _ => return Err(D::Error::custom("invalid thread status")),
                };
                Ok(Self::Unknown {
                    raw,
                    extra: extras(&["raw"])?,
                })
            }
            _ => Err(D::Error::custom("invalid thread status")),
        }
    }
}

/// Adapter facts still use the preserving schema check from packages/core/src/validate.ts:256.
pub(crate) fn valid_external_status(value: &Json) -> bool {
    match crate::json_io::decode::<ThreadStatus>(value) {
        Ok(
            ThreadStatus::NeedsYou { extra, .. }
            | ThreadStatus::Working { extra, .. }
            | ThreadStatus::Waiting { extra, .. }
            | ThreadStatus::Limited { extra, .. }
            | ThreadStatus::Moved { extra, .. }
            | ThreadStatus::Unknown { extra, .. },
        ) => extra.is_empty(),
        Ok(_) => true,
        Err(_) => false,
    }
}

fn valid_queue_number(value: Option<&Json>, min: i64, max: i64) -> Option<i64> {
    match value {
        None => None,
        // `null` is not an omitted queue fact; it rejects the status.
        Some(Json::Null) => None,
        Some(number) => {
            let int = crate::json_io::as_integer(Some(number))?;
            if int < min || int > max {
                return None;
            }
            Some(int)
        }
    }
}

/// Whether the value is an explicit `null`, which optional queue facts reject.
pub fn is_null(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::Null))
}

#[cfg(test)]
mod length_tests {
    use super::ThreadStatus;

    fn status(text: &str) -> Option<ThreadStatus> {
        let value = ace_json::parse(text).expect("fixture parses");
        ace_json::from_value(&value).ok()
    }

    #[test]
    fn an_unknown_state_counts_code_points_like_zods_max_64() {
        // 64 emoji are 128 UTF-16 units: only code points fit the bound.
        for length in [64, 65] {
            let text = format!(r#"{{"state":"{}","raw":{{}}}}"#, "😀".repeat(length));
            assert_eq!(status(&text).is_some(), length == 64, "{length}");
            if length == 64 {
                assert!(matches!(status(&text), Some(ThreadStatus::Unknown { .. })));
            }
        }
    }

    #[test]
    fn a_moved_name_counts_code_points_like_zods_max_256() {
        for length in [256, 257] {
            let text = format!(
                r#"{{"state":"moved","to":{{"hostId":"h","name":"{}","threadId":"t"}}}}"#,
                "😀".repeat(length)
            );
            assert_eq!(status(&text).is_some(), length == 256, "{length}");
        }
    }
}
