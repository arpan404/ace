// SPDX-License-Identifier: Apache-2.0
//! Wire types for `turnsPage`, borrowing from index rows.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    pub turns: Vec<TurnSummary<'a>>,
    pub before: Option<i64>,
    pub after: Option<i64>,
}

#[derive(Serialize)]
pub struct TurnSummary<'a> {
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
    pub status: ThreadStatus<'a>,
    pub outcome: &'a str,
    #[serde(rename = "initiatingMessagePreview")]
    pub initiating: &'a str,
    #[serde(rename = "latestAgentMessagePreview")]
    pub latest: &'a str,
    pub digest: TurnDigest<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main: Option<MainShare<'a>>,
    pub subagents: Vec<Subagent<'a>>,
    #[serde(rename = "subagentsTruncated")]
    pub subagents_truncated: bool,
}

#[derive(Serialize)]
pub struct MainShare<'a> {
    #[serde(rename = "agentId")]
    pub agent_id: &'a str,
    pub digest: TurnDigest<'a>,
}

#[derive(Serialize)]
pub struct Subagent<'a> {
    #[serde(rename = "agentId")]
    pub agent_id: &'a str,
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
    pub status: ThreadStatus<'a>,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    pub digest: TurnDigest<'a>,
}

#[derive(Serialize)]
pub struct TurnDigest<'a> {
    #[serde(rename = "toolCounts")]
    pub tool_counts: BTreeMap<&'a str, i64>,
    pub files: Vec<FileEntry<'a>>,
    pub commands: Vec<CommandEntry<'a>>,
    #[serde(rename = "commandsRun")]
    pub commands_run: i64,
    #[serde(rename = "commandsFailed")]
    pub commands_failed: i64,
    #[serde(rename = "approvalsAsked")]
    pub approvals_asked: i64,
    #[serde(rename = "approvalsAnswered")]
    pub approvals_answered: i64,
    #[serde(rename = "approvalsAutoReviewed")]
    pub approvals_auto_reviewed: i64,
    #[serde(rename = "approvalsPending")]
    pub approvals_pending: i64,
    #[serde(rename = "subagentsStarted")]
    pub subagents_started: i64,
    #[serde(rename = "subagentsFinished")]
    pub subagents_finished: i64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: Option<i64>,
    #[serde(rename = "outputTokens")]
    pub output_tokens: Option<i64>,
    pub errors: i64,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct FileEntry<'a> {
    pub path: &'a str,
    pub added: Option<i64>,
    pub removed: Option<i64>,
}

#[derive(Deserialize, Serialize, Clone, Copy)]
pub struct CommandEntry<'a> {
    #[serde(rename = "itemId")]
    pub item_id: &'a str,
    pub command: &'a str,
    pub failed: bool,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "state")]
pub enum ThreadStatus<'a> {
    #[serde(rename = "needs_you")]
    NeedsYou { interactions: i64 },
    #[serde(rename = "working")]
    Working { agents: i64 },
    #[serde(rename = "waiting")]
    Waiting { on: &'a str },
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
    Moved { to: MoveTarget<'a> },
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "new")]
    New,
    #[serde(rename = "unknown")]
    Unknown {
        raw: &'a serde_json::value::RawValue,
    },
}

#[derive(Serialize, Clone, Copy)]
pub struct MoveTarget<'a> {
    #[serde(rename = "hostId")]
    pub host_id: &'a str,
    pub name: &'a str,
    #[serde(rename = "threadId")]
    pub thread_id: &'a str,
}
