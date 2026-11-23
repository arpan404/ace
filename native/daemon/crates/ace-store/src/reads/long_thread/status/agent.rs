// SPDX-License-Identifier: Apache-2.0
//! Agent statuses from the long-thread index, read for what they convert to.
//!
//! An agent's status keeps only the fields its thread status is built from.

use super::super::common::{LongError, invalid};
use super::thread::Status;
use serde::Deserialize;
use std::borrow::Cow;

/// An agent's status, read only for what its thread status keeps.
enum Agent {
    Starting,
    Working,
    Blocked { on: String, until: Option<i64> },
    Settled,
    Failed,
    Unresponsive,
}

fn parse_agent(text: &str) -> Result<Agent, LongError> {
    #[derive(Deserialize)]
    struct AgentJson<'a> {
        #[serde(borrow)]
        state: Option<&'a str>,
        #[serde(borrow, default)]
        activity: Option<Cow<'a, str>>,
        #[serde(rename = "itemId", default, borrow)]
        item_id: Option<Cow<'a, str>>,
        #[serde(default, borrow)]
        detail: Option<&'a serde_json::value::RawValue>,
        #[serde(borrow, default)]
        on: Option<Cow<'a, str>>,
        #[serde(default, borrow)]
        until: Option<&'a serde_json::value::RawValue>,
        #[serde(default, borrow)]
        attempt: Option<&'a serde_json::value::RawValue>,
        #[serde(default, borrow)]
        message: Option<&'a serde_json::value::RawValue>,
        #[serde(default, borrow)]
        error: Option<&'a serde_json::value::RawValue>,
        #[serde(rename = "lastSignalAt", default, borrow)]
        last_signal_at: Option<&'a serde_json::value::RawValue>,
    }
    // `rename_all` is avoided so the wire field reads exactly as stored.
    let parsed: AgentJson<'_> =
        serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
    let state = parsed.state.ok_or_else(|| invalid("invalid index row"))?;
    match state {
        "starting" => Ok(Agent::Starting),
        "working" => {
            let activity: &str = &parsed
                .activity
                .ok_or_else(|| invalid("invalid index row"))?;
            if !matches!(
                activity,
                "thinking" | "responding" | "tool" | "compacting" | "retrying" | "starting_turn"
            ) {
                return Err(invalid("invalid index row"));
            }
            if let Some(id) = parsed.item_id
                && id.is_empty()
            {
                return Err(invalid("invalid index row"));
            }
            if let Some(detail) = parsed.detail
                && serde_json::from_str::<Cow<'_, str>>(detail.get()).is_err()
            {
                return Err(invalid("invalid index row"));
            }
            Ok(Agent::Working)
        }
        "blocked" => {
            let on: &str = &parsed.on.ok_or_else(|| invalid("invalid index row"))?;
            if !matches!(
                on,
                "human"
                    | "subagents"
                    | "queue"
                    | "background_task"
                    | "rate_limit"
                    | "network"
                    | "upstream"
            ) {
                return Err(invalid("invalid index row"));
            }
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
            if let Some(attempt) = parsed.attempt.as_ref() {
                let n: i64 = serde_json::from_str(attempt.get())
                    .map_err(|_| invalid("invalid index row"))?;
                if n < 1 {
                    return Err(invalid("invalid index row"));
                }
            }
            if let Some(message) = parsed.message
                && serde_json::from_str::<Cow<'_, str>>(message.get()).is_err()
            {
                return Err(invalid("invalid index row"));
            }
            Ok(Agent::Blocked {
                on: on.to_owned(),
                until,
            })
        }
        "idle" | "interrupted" => Ok(Agent::Settled),
        "failed" => {
            if parsed.error.is_none() {
                return Err(invalid("invalid index row"));
            }
            Ok(Agent::Failed)
        }
        "unresponsive" => {
            let raw = parsed
                .last_signal_at
                .as_ref()
                .ok_or_else(|| invalid("invalid index row"))?;
            let at: i64 =
                serde_json::from_str(raw.get()).map_err(|_| invalid("invalid index row"))?;
            if at < 0 {
                return Err(invalid("invalid index row"));
            }
            Ok(Agent::Unresponsive)
        }
        _ => Err(invalid("invalid index row")),
    }
}

/// An agent's status as the thread list shows it.
pub fn agent_thread_status(text: &str) -> Result<Status, LongError> {
    match parse_agent(text)? {
        Agent::Settled => Ok(Status::Done),
        Agent::Failed => Ok(Status::Failed),
        Agent::Unresponsive => Ok(Status::Unresponsive),
        Agent::Blocked { on, until } => match on.as_str() {
            "human" => Ok(Status::NeedsYou { interactions: 1 }),
            "subagents" => Ok(Status::Working { agents: 1 }),
            "rate_limit" => Ok(Status::Limited { until }),
            _ => Ok(Status::Waiting {
                on,
                slot_limit: None,
                slots_in_use: None,
                queue_position: None,
                waiting_for: None,
            }),
        },
        Agent::Starting | Agent::Working => Ok(Status::Working { agents: 1 }),
    }
}
