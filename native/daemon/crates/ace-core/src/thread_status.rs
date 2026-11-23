// SPDX-License-Identifier: Apache-2.0
//! The `ThreadStatus` wire shape: lenient decoding with the Zod union's
//! semantics. Known states strip unknown fields and validate their counts;
//! anything newer than this build reads `unknown` and is kept whole in
//! `raw`, never settled.

use crate::json_io::{Json, Map};
use crate::status::{MovedTo, ThreadStatus};

/// A status with only these keys is a known protocol state.
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
        let map = Map::deserialize(deserializer)?;
        let state = map
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        if !KNOWN_THREAD_STATES.contains(&state.as_str()) {
            if state.len() < 1 || state.len() > 64 {
                return Err(D::Error::custom("invalid thread status"));
            }
            let raw = serde_json::to_string(&map).map_err(D::Error::custom)?;
            let raw = serde_json::from_str(&raw).map_err(D::Error::custom)?;
            return Ok(Self::Unknown { raw });
        }
        let value = Json::Object(map);
        if state.is_empty() {
            return Err(D::Error::custom("thread status needs a state"));
        }
        // Known states strip nothing: unknown fields reject the status, like
        // `preservesFields` does for the Zod parse.
        let known_fields: &[&str] = match state.as_str() {
            "needs_you" => &["state", "interactions"],
            "working" => &["state", "agents"],
            "waiting" => &[
                "state",
                "on",
                "slotLimit",
                "slotsInUse",
                "queuePosition",
                "waitingFor",
            ],
            "limited" => &["state", "until"],
            "failed" | "unresponsive" | "done" | "new" => &["state"],
            "moved" => &["state", "to"],
            "unknown" => &[],
            _ => &[],
        };
        if state.as_str() != "unknown" {
            let map = match &value {
                Json::Object(map) => map,
                _ => return Err(D::Error::custom("invalid thread status")),
            };
            if !ensure_only(map, known_fields) {
                return Err(D::Error::custom("invalid thread status"));
            }
        }
        match state.as_str() {
            "needs_you" => Ok(Self::NeedsYou {
                interactions: crate::json_io::as_count(Some(
                    value.get("interactions").unwrap_or(&Json::Null),
                ))
                .filter(|count| *count > 0)
                .ok_or_else(|| D::Error::custom("invalid thread status"))?,
            }),
            "working" => Ok(Self::Working {
                agents: crate::json_io::as_count(Some(value.get("agents").unwrap_or(&Json::Null)))
                    .filter(|count| *count > 0)
                    .ok_or_else(|| D::Error::custom("invalid thread status"))?,
            }),
            "waiting" => {
                let on = value.get("on").and_then(|value| value.as_str()).unwrap_or("");
                if !matches!(
                    on,
                    "background_task" | "rate_limit" | "network" | "upstream" | "queue"
                ) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                if is_null(value.get("slotLimit"))
                    || is_null(value.get("slotsInUse"))
                    || is_null(value.get("queuePosition"))
                {
                    return Err(D::Error::custom("invalid thread status"));
                }
                Ok(Self::Waiting {
                    on: on.to_owned(),
                    slot_limit: valid_queue_number(value.get("slotLimit"), 1, 64),
                    slots_in_use: valid_queue_number(value.get("slotsInUse"), 0, i64::MAX),
                    queue_position: valid_queue_number(value.get("queuePosition"), 1, i64::MAX),
                    waiting_for: match value.get("waitingFor") {
                        None => None,
                        Some(Json::Null) => {
                            return Err(D::Error::custom("invalid thread status"));
                        }
                        Some(Json::String(waiting)) if waiting == "storage" => {
                            Some(waiting.clone())
                        }
                        _ => return Err(D::Error::custom("invalid thread status")),
                    },
                })
            }
            "limited" => {
                if matches!(value.get("until"), Some(Json::Null)) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                Ok(Self::Limited {
                    until: match value.get("until") {
                        None => None,
                        Some(until) => Some(crate::json_io::as_count(Some(until)).ok_or_else(|| {
                            D::Error::custom("invalid thread status")
                        })?),
                    },
                })
            }
            "failed" => Ok(Self::Failed),
            "unresponsive" => Ok(Self::Unresponsive),
            "moved" => {
                let to = value.get("to").ok_or_else(|| D::Error::custom("invalid thread status"))?;
                let to_map = match to {
                    Json::Object(map) => map,
                    _ => return Err(D::Error::custom("invalid thread status")),
                };
                if !ensure_only(to_map, &["hostId", "name", "threadId"]) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                let host_id = to.get("hostId").and_then(|value| value.as_str()).unwrap_or("");
                let name = to.get("name").and_then(|value| value.as_str()).unwrap_or("");
                if host_id.is_empty() || name.len() < 1 || name.len() > 256 {
                    return Err(D::Error::custom("invalid thread status"));
                }
                let thread_id = to.get("threadId").and_then(|value| value.as_str()).unwrap_or("");
                if thread_id.is_empty() {
                    return Err(D::Error::custom("invalid thread status"));
                }
                Ok(Self::Moved {
                    to: MovedTo {
                        host_id: host_id.to_owned(),
                        name: name.to_owned(),
                        thread_id: thread_id.to_owned(),
                    },
                })
            }
            "done" => Ok(Self::Done),
            "new" => Ok(Self::New),
            "unknown" => {
                let map = match &value {
                    Json::Object(map) => map,
                    _ => return Err(D::Error::custom("invalid thread status")),
                };
                if !ensure_only(map, &["state", "raw"]) {
                    return Err(D::Error::custom("invalid thread status"));
                }
                let raw = match map.get("raw") {
                    Some(Json::Object(_)) => map.get("raw").unwrap_or(&Json::Null).clone(),
                    _ => return Err(D::Error::custom("invalid thread status")),
                };
                let raw = serde_json::to_string(&raw).map_err(D::Error::custom)?;
                let raw = serde_json::from_str(&raw).map_err(D::Error::custom)?;
                Ok(Self::Unknown { raw })
            }
            _ => Err(D::Error::custom("invalid thread status")),
        }
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

impl serde::Serialize for ThreadStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap as _;
        match self {
            Self::NeedsYou { interactions } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("state", "needs_you")?;
                map.serialize_entry("interactions", interactions)?;
                map.end()
            }
            Self::Working { agents } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("state", "working")?;
                map.serialize_entry("agents", agents)?;
                map.end()
            }
            Self::Waiting {
                on,
                slot_limit,
                slots_in_use,
                queue_position,
                waiting_for,
            } => {
                let mut len = 2;
                if slot_limit.is_some() {
                    len += 1;
                }
                if slots_in_use.is_some() {
                    len += 1;
                }
                if queue_position.is_some() {
                    len += 1;
                }
                if waiting_for.is_some() {
                    len += 1;
                }
                let mut map = serializer.serialize_map(Some(len))?;
                map.serialize_entry("state", "waiting")?;
                map.serialize_entry("on", on)?;
                if let Some(value) = slot_limit {
                    map.serialize_entry("slotLimit", value)?;
                }
                if let Some(value) = slots_in_use {
                    map.serialize_entry("slotsInUse", value)?;
                }
                if let Some(value) = queue_position {
                    map.serialize_entry("queuePosition", value)?;
                }
                if let Some(value) = waiting_for {
                    map.serialize_entry("waitingFor", value)?;
                }
                map.end()
            }
            Self::Limited { until } => {
                let mut map = serializer.serialize_map(Some(if until.is_some() { 2 } else { 1 }))?;
                map.serialize_entry("state", "limited")?;
                if let Some(value) = until {
                    map.serialize_entry("until", value)?;
                }
                map.end()
            }
            Self::Failed => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "failed")?;
                map.end()
            }
            Self::Unresponsive => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "unresponsive")?;
                map.end()
            }
            Self::Moved { to } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("state", "moved")?;
                map.serialize_entry("to", to)?;
                map.end()
            }
            Self::Done => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "done")?;
                map.end()
            }
            Self::New => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "new")?;
                map.end()
            }
            Self::Unknown { raw } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("state", "unknown")?;
                map.serialize_entry("raw", raw)?;
                map.end()
            }
        }
    }
}
