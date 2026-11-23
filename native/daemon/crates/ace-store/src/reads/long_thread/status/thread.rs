// SPDX-License-Identifier: Apache-2.0
//! Thread statuses from the long-thread index, validated as they are read.
//!
//! Only the fields the protocol names are kept, in the protocol's order.
//! Parsing borrows from the stored text; nothing here builds a JSON tree.

use super::super::common::{LongError, invalid, js_len};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// A thread's status, with the fields the protocol names in its order.
#[derive(Serialize, Clone)]
#[serde(tag = "state")]
pub enum Status {
    #[serde(rename = "needs_you")]
    NeedsYou { interactions: i64 },
    #[serde(rename = "working")]
    Working { agents: i64 },
    #[serde(rename = "waiting")]
    Waiting {
        on: String,
        #[serde(rename = "slotLimit", skip_serializing_if = "Option::is_none")]
        slot_limit: Option<i64>,
        #[serde(rename = "slotsInUse", skip_serializing_if = "Option::is_none")]
        slots_in_use: Option<i64>,
        #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
        queue_position: Option<i64>,
        #[serde(rename = "waitingFor", skip_serializing_if = "Option::is_none")]
        waiting_for: Option<String>,
    },
    #[serde(rename = "limited")]
    Limited {
        #[serde(skip_serializing_if = "Option::is_none")]
        until: Option<i64>,
    },
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "unresponsive")]
    Unresponsive,
    #[serde(rename = "moved")]
    Moved { to: MoveTarget },
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "new")]
    New,
    #[serde(rename = "unknown")]
    Unknown {
        raw: Box<serde_json::value::RawValue>,
    },
}

/// The target a moved thread's work continues on.
#[derive(Serialize, Clone)]
pub struct MoveTarget {
    #[serde(rename = "hostId")]
    pub host_id: String,
    pub name: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
}

fn known_state(state: &str) -> bool {
    matches!(
        state,
        "needs_you"
            | "working"
            | "waiting"
            | "limited"
            | "failed"
            | "unresponsive"
            | "moved"
            | "done"
            | "new"
            | "unknown"
    )
}

#[derive(Deserialize)]
struct StateOnly<'a> {
    #[serde(borrow)]
    state: Option<&'a str>,
}

fn state_of(text: &str) -> Result<&str, LongError> {
    let parsed: StateOnly<'_> =
        serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
    let state = parsed.state.ok_or_else(|| invalid("invalid index row"))?;
    if state.is_empty() || js_len(state) > 64 {
        return Err(invalid("invalid index row"));
    }
    Ok(state)
}

#[derive(Deserialize)]
struct NeedsYou<'a> {
    #[serde(borrow)]
    interactions: Option<&'a serde_json::value::RawValue>,
}

#[derive(Deserialize)]
struct Working<'a> {
    #[serde(borrow)]
    agents: Option<&'a serde_json::value::RawValue>,
}

#[derive(Deserialize)]
struct Waiting<'a> {
    #[serde(borrow)]
    on: Option<Cow<'a, str>>,
    #[serde(rename = "slotLimit", default, borrow)]
    slot_limit: Option<&'a serde_json::value::RawValue>,
    #[serde(rename = "slotsInUse", default, borrow)]
    slots_in_use: Option<&'a serde_json::value::RawValue>,
    #[serde(rename = "queuePosition", default, borrow)]
    queue_position: Option<&'a serde_json::value::RawValue>,
    #[serde(rename = "waitingFor", default, borrow)]
    waiting_for: Option<Cow<'a, str>>,
}

fn raw_count(raw: &serde_json::value::RawValue) -> Result<i64, LongError> {
    let n: i64 = serde_json::from_str(raw.get()).map_err(|_| invalid("invalid index row"))?;
    super::super::common::check_count(n)
}

/// `ThreadStatus`, with an unknown state kept as `unknown` and its raw body.
pub fn parse_thread_status(text: &str) -> Result<Status, LongError> {
    let state = state_of(text)?;
    if !known_state(state) {
        let raw = serde_json::value::RawValue::from_string(text.to_owned())
            .map_err(|_| invalid("invalid index row"))?;
        return Ok(Status::Unknown { raw });
    }
    match state {
        "needs_you" => {
            let parsed: NeedsYou<'_> =
                serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
            let raw = parsed
                .interactions
                .ok_or_else(|| invalid("invalid index row"))?;
            let interactions = raw_count(raw)?;
            if interactions < 1 {
                return Err(invalid("invalid index row"));
            }
            Ok(Status::NeedsYou { interactions })
        }
        "working" => {
            let parsed: Working<'_> =
                serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
            let raw = parsed.agents.ok_or_else(|| invalid("invalid index row"))?;
            let agents = raw_count(raw)?;
            if agents < 1 {
                return Err(invalid("invalid index row"));
            }
            Ok(Status::Working { agents })
        }
        "waiting" => {
            let parsed: Waiting<'_> =
                serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
            let on: &str = &parsed.on.ok_or_else(|| invalid("invalid index row"))?;
            if !matches!(
                on,
                "background_task" | "rate_limit" | "network" | "upstream" | "queue"
            ) {
                return Err(invalid("invalid index row"));
            }
            let slot_limit = parsed
                .slot_limit
                .as_ref()
                .map(|raw| {
                    let n = raw_count(raw)?;
                    if (1..=64).contains(&n) {
                        Ok(n)
                    } else {
                        Err(invalid("invalid index row"))
                    }
                })
                .transpose()?;
            let slots_in_use = parsed.slots_in_use.map(raw_count).transpose()?;
            let queue_position = parsed
                .queue_position
                .map(|raw| {
                    let n = raw_count(raw)?;
                    if n >= 1 {
                        Ok(n)
                    } else {
                        Err(invalid("invalid index row"))
                    }
                })
                .transpose()?;
            let waiting_for = match parsed.waiting_for {
                None => None,
                Some(ref waiting) if waiting == "storage" => Some("storage".to_owned()),
                Some(_) => return Err(invalid("invalid index row")),
            };
            Ok(Status::Waiting {
                on: on.to_owned(),
                slot_limit,
                slots_in_use,
                queue_position,
                waiting_for,
            })
        }
        "limited" => {
            #[derive(Deserialize)]
            struct Limited<'a> {
                #[serde(borrow, default)]
                until: Option<&'a serde_json::value::RawValue>,
            }
            let parsed: Limited<'_> =
                serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
            let until = parsed
                .until
                .as_ref()
                .map(|raw| {
                    let n: i64 = serde_json::from_str(raw.get())
                        .map_err(|_| invalid("invalid index row"))?;
                    if n >= 0 {
                        Ok(n)
                    } else {
                        Err(invalid("invalid index row"))
                    }
                })
                .transpose()?;
            Ok(Status::Limited { until })
        }
        "failed" | "unresponsive" | "done" | "new" => match state {
            "failed" => Ok(Status::Failed),
            "unresponsive" => Ok(Status::Unresponsive),
            "done" => Ok(Status::Done),
            _ => Ok(Status::New),
        },
        "unknown" => {
            #[derive(Deserialize)]
            struct Unknown<'a> {
                #[serde(borrow, default)]
                raw: Option<&'a serde_json::value::RawValue>,
            }
            let parsed: Unknown<'_> =
                serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
            if parsed.raw.is_none() {
                return Err(invalid("invalid index row"));
            }
            let raw = serde_json::value::RawValue::from_string(text.to_owned())
                .map_err(|_| invalid("invalid index row"))?;
            Ok(Status::Unknown { raw })
        }
        "moved" => {
            #[derive(Deserialize)]
            struct Moved<'a> {
                #[serde(borrow)]
                to: Option<To<'a>>,
            }
            #[derive(Deserialize)]
            struct To<'a> {
                #[serde(rename = "hostId", borrow)]
                host_id: Option<Cow<'a, str>>,
                #[serde(borrow)]
                name: Option<Cow<'a, str>>,
                #[serde(rename = "threadId", borrow)]
                thread_id: Option<Cow<'a, str>>,
            }
            let parsed: Moved<'_> =
                serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
            let to = parsed.to.ok_or_else(|| invalid("invalid index row"))?;
            let host_id = to.host_id.ok_or_else(|| invalid("invalid index row"))?;
            let name = to.name.ok_or_else(|| invalid("invalid index row"))?;
            let thread_id = to.thread_id.ok_or_else(|| invalid("invalid index row"))?;
            if host_id.is_empty() || name.is_empty() || thread_id.is_empty() {
                return Err(invalid("invalid index row"));
            }
            Ok(Status::Moved {
                to: MoveTarget {
                    host_id: host_id.into_owned(),
                    name: name.into_owned(),
                    thread_id: thread_id.into_owned(),
                },
            })
        }
        _ => Err(invalid("invalid index row")),
    }
}
