// SPDX-License-Identifier: Apache-2.0
//! Spade's bots, parsed leniently as the app's pages do.

use cli_out::{ErrorCode, Failure, Outcome};
use cli_wire::Connection;
use serde::Serialize;

use super::common;

#[derive(Clone, Serialize)]
pub(crate) struct BotLastMessage {
    pub(crate) from: String,
    pub(crate) text: String,
    pub(crate) at: i64,
}

#[derive(Clone, Serialize)]
pub(crate) struct BotParent {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct Bot {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) task: String,
    pub(crate) model: String,
    pub(crate) conversation: String,
    pub(crate) state: String,
    #[serde(rename = "waitingFor", skip_serializing_if = "Option::is_none")]
    pub(crate) waiting_for: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) problem: Option<String>,
    pub(crate) unseen: bool,
    pub(crate) pinned: bool,
    #[serde(rename = "lastActivity")]
    pub(crate) last_activity: i64,
    #[serde(rename = "lastMessage", skip_serializing_if = "Option::is_none")]
    pub(crate) last_message: Option<BotLastMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<BotParent>,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn list_bots(
    conn: &mut Connection,
    timeout: std::time::Duration,
    command: &'static str,
) -> Result<Vec<Bot>, Failure<'static>> {
    let (_, body) = common::spade_call(conn, timeout, "GET", "/v1/agents", None, command)
        .map_err(|failure| failure.with_command(command))?;
    parse_agents(&body).ok_or_else(|| {
        Failure::new(Outcome::Uncertain, "Spade's answer had no bots in it.")
            .with_code(ErrorCode::Uncertain)
            .with_command(command)
    })
}
fn json_number(value: &serde_json::Value) -> i64 {
    if let Some(int) = value.as_i64() {
        return int;
    }
    if let Some(uint) = value.as_u64() {
        return i64::try_from(uint).unwrap_or(0);
    }
    value.as_f64().map_or(0, round_to_i64)
}

/// A JSON number as an integer, saturating on the way in.
#[allow(
    clippy::cast_possible_truncation,
    reason = "float-to-int `as` saturates; timestamps and counts fit"
)]
fn round_to_i64(number: f64) -> i64 {
    number.round() as i64
}
fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}
pub(crate) fn parse_agents(body: &str) -> Option<Vec<Bot>> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let list = parsed.get("agents")?.as_array()?;
    let mut bots = Vec::new();
    for raw in list {
        let id = raw.get("id")?.as_str()?;
        if id.is_empty() {
            continue;
        }
        let conversation = raw.get("conversation")?.as_str()?;
        if conversation.is_empty() {
            continue;
        }
        let kind = match raw.get("kind").and_then(serde_json::Value::as_str) {
            Some("main") => "main",
            _ => "bot",
        };
        let main = kind == "main";
        let name = if main {
            "Spade".to_owned()
        } else {
            let name = json_string(raw.get("name"));
            if name.is_empty() {
                "Bot".to_owned()
            } else {
                name
            }
        };
        let state = match raw.get("state").and_then(serde_json::Value::as_str) {
            Some(state @ ("idle" | "working" | "waiting" | "paused" | "updating")) => {
                state.to_owned()
            }
            _ => {
                if raw.get("working").and_then(serde_json::Value::as_bool) == Some(true) {
                    "working".to_owned()
                } else {
                    "idle".to_owned()
                }
            }
        };
        let waiting_for = match raw.get("waiting_for").and_then(serde_json::Value::as_str) {
            Some(waiting @ ("approval" | "question" | "worker" | "callee")) => {
                Some(waiting.to_owned())
            }
            _ => None,
        };
        let status = match raw.get("status").and_then(serde_json::Value::as_str) {
            Some(status) if !status.is_empty() => Some(status.to_owned()),
            _ => None,
        };
        let problem = match raw.get("problem").and_then(serde_json::Value::as_str) {
            Some(problem) if !problem.is_empty() => Some(problem.to_owned()),
            _ => None,
        };
        let last_message = parse_last_message(raw.get("last_message"));
        let parent = parse_parent(raw.get("parent"));
        bots.push(Bot {
            id: id.to_owned(),
            kind: kind.to_owned(),
            name,
            task: raw
                .get("task")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_owned(),
            model: json_string(raw.get("model")),
            conversation: conversation.to_owned(),
            state,
            waiting_for,
            status,
            problem,
            unseen: raw
                .get("unseen")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            pinned: raw.get("pinned_at").is_some_and(|pinned| !pinned.is_null()),
            last_activity: raw.get("last_activity").map_or(0, json_number),
            last_message,
            parent,
        });
    }
    Some(bots)
}
fn parse_last_message(last: Option<&serde_json::Value>) -> Option<BotLastMessage> {
    let last = last?;
    if last.is_null() {
        return None;
    }
    let from = match last.get("from").and_then(serde_json::Value::as_str) {
        Some("person") => "person",
        _ => "agent",
    };
    Some(BotLastMessage {
        from: from.to_owned(),
        text: json_string(last.get("text")),
        at: last.get("at").map_or(0, json_number),
    })
}
fn parse_parent(parent: Option<&serde_json::Value>) -> Option<BotParent> {
    let parent = parent?;
    if parent.is_null() {
        return None;
    }
    let id = parent.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    Some(BotParent {
        id: id.to_owned(),
        name: json_string(parent.get("name")),
    })
}

/// A BOT argument: an id, a name (any case), or an unambiguous start of either.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(crate) fn find_bot(
    bots: &[Bot],
    reference: Option<&str>,
    command: &'static str,
) -> Result<Bot, Failure<'static>> {
    let Some(reference) = reference else {
        if let Some(main) = bots.iter().find(|bot| bot.kind == "main") {
            return Ok(main.clone());
        }
        return Err(Failure::new(Outcome::Refused, "Spade has no main bot yet.")
            .with_code(ErrorCode::NotFound)
            .with_hint("Name a bot: see them with ace spade bot list.")
            .with_command(command));
    };
    let typed = reference.to_lowercase();
    let exact: Vec<&Bot> = bots
        .iter()
        .filter(|bot| bot.id == reference || bot.name.to_lowercase() == typed)
        .collect();
    if exact.len() == 1
        && let Some(only) = exact.first()
    {
        return Ok((*only).clone());
    }
    let starts: Vec<&Bot> = bots
        .iter()
        .filter(|bot| bot.id.starts_with(reference) || bot.name.to_lowercase().starts_with(&typed))
        .collect();
    if starts.len() == 1
        && let Some(only) = starts.first()
    {
        return Ok((*only).clone());
    }
    if starts.len() > 1 || exact.len() > 1 {
        let ids: Vec<&str> = exact
            .iter()
            .chain(starts.iter())
            .map(|bot| bot.id.as_str())
            .collect();
        return Err(
            Failure::usage(format!("More than one bot matches {reference}."))
                .with_code(ErrorCode::BadArgument)
                .with_argument("BOT")
                .with_hint(format!("Use its id: {}.", ids.join(", ")))
                .with_command(command),
        );
    }
    Err(
        Failure::new(Outcome::Refused, format!("Spade has no bot {reference}."))
            .with_code(ErrorCode::NotFound)
            .with_argument("BOT")
            .with_hint("See your bots with ace spade bot list.")
            .with_command(command),
    )
}
