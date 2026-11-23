// SPDX-License-Identifier: Apache-2.0
//! A turns page's wire structs, in the protocol's field order.
//!
//! Finished turns serialize once each; the page splices their bytes verbatim.

use super::super::common::{LongError, invalid};
use super::super::digests::{Counters, DigestOut};
use super::super::status::{Status, parse_thread_status, turn_activity_status, turn_is_settled};
use super::agents::AgentRow;
use super::rows::TurnRow;
use serde::Serialize;

#[allow(clippy::too_many_arguments)]
pub fn turn_status(
    row: &TurnRow,
    head_ordinal: Option<i64>,
    head_status_text: Option<&str>,
    thread_status: Option<&Status>,
    counters: &Counters,
    linked: Option<&Status>,
    owned: Option<&Status>,
) -> Result<Status, LongError> {
    if head_ordinal == Some(row.ordinal) {
        let status = if let Some(status) = thread_status {
            status.clone()
        } else if let Some(text) = head_status_text {
            parse_thread_status(text)?
        } else {
            return Err(invalid("Missing turn digest"));
        };
        if !turn_is_settled(&status) || matches!(status, Status::Failed) {
            return Ok(status);
        }
    }
    let mut candidates = Vec::new();
    if let Some(linked) = linked {
        candidates.push(linked.clone());
    }
    if let Some(owned) = owned {
        candidates.push(owned.clone());
    }
    if let Some(active) = turn_activity_status(counters, &candidates) {
        return Ok(active);
    }
    if row.settled_seq.is_none() {
        return Ok(Status::Working { agents: 1 });
    }
    if row.root_outcome == "failed" {
        return Ok(Status::Failed);
    }
    Ok(Status::Done)
}

/// One agent share of a turn, in the protocol's field order.
#[derive(Serialize)]
pub struct Subagent<'a> {
    #[serde(rename = "agentId")]
    pub agent_id: &'a str,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
    pub status: Status,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub digest: DigestOut,
}

/// The main agent's own share, in the protocol's field order.
#[derive(Serialize)]
pub struct MainShare {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub digest: DigestOut,
}

/// One turn summary, in the protocol's field order.
#[derive(Serialize)]
pub struct Turn<'a> {
    #[serde(rename = "threadId")]
    pub thread_id: &'a str,
    pub ordinal: i64,
    #[serde(rename = "startSeq")]
    pub start_seq: i64,
    #[serde(rename = "endSeq")]
    pub end_seq: i64,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub status: Status,
    pub outcome: &'a str,
    #[serde(rename = "initiatingMessagePreview")]
    pub initiating: &'a str,
    #[serde(rename = "latestAgentMessagePreview")]
    pub latest: &'a str,
    pub digest: DigestOut,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main: Option<MainShare>,
    pub subagents: Vec<Subagent<'a>>,
    #[serde(rename = "subagentsTruncated")]
    pub subagents_truncated: bool,
}

/// A page of turns, in the protocol's field order. Finished turns splice verbatim.
#[derive(Serialize)]
pub struct TurnsPage<'a> {
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(rename = "requestId")]
    pub request_id: &'a str,
    #[serde(rename = "threadId")]
    pub thread_id: &'a str,
    pub seq: i64,
    #[serde(rename = "indexedSeq")]
    pub indexed_seq: i64,
    pub ready: bool,
    pub turns: Vec<Box<serde_json::value::RawValue>>,
    pub before: Option<i64>,
    pub after: Option<i64>,
}

pub fn subagent_summary<'a>(
    agent: &'a AgentRow,
    child_id: Option<String>,
    digest: DigestOut,
    child_live: bool,
    child_status: Option<Status>,
    agent_status: Status,
) -> Result<Subagent<'a>, LongError> {
    let status = match (child_live, child_status) {
        (true, Some(status)) => status,
        _ => agent_status,
    };
    Ok(Subagent {
        agent_id: agent.id.as_str(),
        thread_id: if child_live { child_id } else { None },
        name: agent.name.as_deref(),
        status,
        started_at: agent.started_at,
        ended_at: agent.ended_at,
        digest,
    })
}
