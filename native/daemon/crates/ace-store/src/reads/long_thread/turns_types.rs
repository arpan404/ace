// SPDX-License-Identifier: Apache-2.0
//! Ordered digest types for phase 2 reads, borrowing nothing.
//!
//! A digest serializes its fields in the protocol's order, as the TypeScript
//! loader writes them; `toolCounts` keeps the index rows' order rather than
//! sorting, because the loader's `Object.fromEntries` keeps it too. Counters
//! are an insertion-ordered list for the same reason.

use super::common::{LongError, check_count, invalid, is_tool_kind, js_len};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// One counter row's key and value, in the index rows' order.
#[derive(Clone, Default, Debug)]
pub struct Counters {
    entries: Vec<(String, i64)>,
}

impl Counters {
    pub fn new() -> Self {
        Counters {
            entries: Vec::new(),
        }
    }

    pub fn insert(&mut self, key: String, value: i64) {
        if let Some(slot) = self.entries.iter_mut().find(|(name, _)| *name == key) {
            slot.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    pub fn get(&self, key: &str) -> Option<i64> {
        self.entries
            .iter()
            .find(|(name, _)| name.as_str() == key)
            .map(|(_, value)| *value)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, i64)> + '_ {
        self.entries
            .iter()
            .map(|(name, value)| (name.as_str(), *value))
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// `toolCounts` in the index rows' order, serialized as one JSON object.
#[derive(Clone, Default, Debug)]
pub struct ToolCounts(pub Vec<(String, i64)>);

impl Serialize for ToolCounts {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(kind, value)| (kind, value)))
    }
}

/// One file entry, in the protocol's field order.
#[derive(Serialize, Clone, Debug)]
pub struct FileOut {
    pub path: String,
    pub added: Option<i64>,
    pub removed: Option<i64>,
}

/// One command entry, in the protocol's field order.
#[derive(Serialize, Clone, Debug)]
pub struct CommandOut {
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub command: String,
    pub failed: bool,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

/// A turn digest, in the protocol's field order.
#[derive(Serialize, Clone, Debug)]
pub struct DigestOut {
    #[serde(rename = "toolCounts")]
    pub tool_counts: ToolCounts,
    pub files: Vec<FileOut>,
    pub commands: Vec<CommandOut>,
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

/// A digest with null tokens serializes them explicitly, as the loader does.
fn counter_or_zero(counters: &Counters, key: &str) -> i64 {
    counters.get(key).unwrap_or(0).max(0)
}

/// The digest of one counter set, before its bounded details.
pub fn digest_from_counters(counters: &Counters) -> DigestOut {
    let mut tools = Vec::new();
    for (key, value) in counters.iter() {
        if let Some(kind) = key.strip_prefix("tool:")
            && is_tool_kind(kind)
        {
            tools.push((kind.to_owned(), value.max(0)));
        }
    }
    DigestOut {
        tool_counts: ToolCounts(tools),
        files: Vec::new(),
        commands: Vec::new(),
        commands_run: counter_or_zero(counters, "commandsRun"),
        commands_failed: counter_or_zero(counters, "commandsFailed"),
        approvals_asked: counter_or_zero(counters, "approvalsAsked"),
        approvals_answered: counter_or_zero(counters, "approvalsAnswered"),
        approvals_auto_reviewed: counter_or_zero(counters, "approvalsAutoReviewed"),
        approvals_pending: counter_or_zero(counters, "approvalsPending"),
        subagents_started: counter_or_zero(counters, "subagentsStarted"),
        subagents_finished: counter_or_zero(counters, "subagentsFinished"),
        input_tokens: counters.get("inputTokens"),
        output_tokens: counters.get("outputTokens"),
        errors: counter_or_zero(counters, "errors"),
        truncated: false,
    }
}

/// An empty digest, as the merge starts from.
pub fn empty_digest() -> DigestOut {
    DigestOut {
        tool_counts: ToolCounts(Vec::new()),
        files: Vec::new(),
        commands: Vec::new(),
        commands_run: 0,
        commands_failed: 0,
        approvals_asked: 0,
        approvals_answered: 0,
        approvals_auto_reviewed: 0,
        approvals_pending: 0,
        subagents_started: 0,
        subagents_finished: 0,
        input_tokens: None,
        output_tokens: None,
        errors: 0,
        truncated: false,
    }
}

/// A stored command body, validated as the loader's schema does.
pub fn parse_command(data: &str) -> Result<CommandOut, LongError> {
    #[derive(Deserialize)]
    struct CommandJson<'a> {
        #[serde(rename = "itemId", default, borrow)]
        item_id: Option<Cow<'a, str>>,
        #[serde(default, borrow)]
        command: Option<Cow<'a, str>>,
        #[serde(default, borrow)]
        failed: Option<&'a serde_json::value::RawValue>,
        #[serde(rename = "exitCode", default, borrow)]
        exit_code: Option<&'a serde_json::value::RawValue>,
    }
    let parsed: CommandJson<'_> =
        serde_json::from_str(data).map_err(|_| invalid("invalid index row"))?;
    let item_id = parsed.item_id.ok_or_else(|| invalid("invalid index row"))?;
    if item_id.is_empty() {
        return Err(invalid("invalid index row"));
    }
    let command: &str = &parsed.command.ok_or_else(|| invalid("invalid index row"))?;
    if js_len(command) > 1024 {
        return Err(invalid("invalid index row"));
    }
    let failed_raw = parsed.failed.ok_or_else(|| invalid("invalid index row"))?;
    let failed: bool =
        serde_json::from_str(failed_raw.get()).map_err(|_| invalid("invalid index row"))?;
    let exit_code = match parsed.exit_code {
        None => None,
        Some(raw) if raw.get() == "null" => None,
        Some(raw) => {
            let code: i64 =
                serde_json::from_str(raw.get()).map_err(|_| invalid("invalid index row"))?;
            Some(code)
        }
    };
    Ok(CommandOut {
        item_id: item_id.into_owned(),
        command: command.to_owned(),
        failed,
        exit_code,
    })
}

/// A whole-turn file row: unknown line counts read as nulls, counts below zero as zero.
pub fn turn_file(path: &str, added: i64, removed: i64, unknown: i64) -> Result<FileOut, LongError> {
    super::common::check_path(path)?;
    super::common::check_id(path)?;
    if unknown > 0 {
        return Ok(FileOut {
            path: path.to_owned(),
            added: None,
            removed: None,
        });
    }
    let added = check_count(added.max(0))?;
    let removed = check_count(removed.max(0))?;
    Ok(FileOut {
        path: path.to_owned(),
        added: Some(added),
        removed: Some(removed),
    })
}

/// An agent-share file row: any unknown count reads as nulls, and counts are exact.
pub fn agent_file(
    path: &str,
    added: i64,
    removed: i64,
    unknown: i64,
) -> Result<FileOut, LongError> {
    super::common::check_path(path)?;
    super::common::check_id(path)?;
    if unknown != 0 {
        return Ok(FileOut {
            path: path.to_owned(),
            added: None,
            removed: None,
        });
    }
    // Whole-valued reals are read as integers by the caller; anything else fails there.
    let added = check_count(added)?;
    let removed = check_count(removed)?;
    Ok(FileOut {
        path: path.to_owned(),
        added: Some(added),
        removed: Some(removed),
    })
}

/// The scalars a finished digest carries are all protocol counts.
pub fn validate_digest(digest: &DigestOut) -> Result<(), LongError> {
    for value in [
        digest.commands_run,
        digest.commands_failed,
        digest.approvals_asked,
        digest.approvals_answered,
        digest.approvals_auto_reviewed,
        digest.approvals_pending,
        digest.subagents_started,
        digest.subagents_finished,
        digest.errors,
    ] {
        check_count(value)?;
    }
    for (_, value) in &digest.tool_counts.0 {
        check_count(*value)?;
    }
    for value in [digest.input_tokens, digest.output_tokens]
        .into_iter()
        .flatten()
    {
        check_count(value)?;
    }
    if digest.files.len() > 64 || digest.commands.len() > 64 {
        return Err(invalid("invalid index row"));
    }
    for file in &digest.files {
        super::common::check_path(&file.path)?;
        for value in [file.added, file.removed].into_iter().flatten() {
            check_count(value)?;
        }
    }
    Ok(())
}

/// Drop a digest's bounded details for the page's byte budget.
pub fn strip_details(digest: &mut DigestOut) {
    if !digest.files.is_empty() || !digest.commands.is_empty() {
        digest.truncated = true;
    }
    digest.files.clear();
    digest.commands.clear();
}
