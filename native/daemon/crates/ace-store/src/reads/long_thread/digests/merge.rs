// SPDX-License-Identifier: Apache-2.0
//! Combine bounded summaries, as `@ace/projection` merges them.
//!
//! Files merge by path in first-seen order and sort by path at the end, exactly
//! as the loader's map does; commands keep their first-seen order and replace
//! in place, because the loader's map keeps an updated entry's position.

use super::super::common::{LongError, check_count, is_tool_kind};
use super::super::turns_types::{CommandOut, DigestOut, FileOut, empty_digest};

fn merge_counts(left: Option<i64>, right: Option<i64>) -> Result<Option<i64>, LongError> {
    match (left, right) {
        (None, None) => Ok(None),
        (Some(left), None) | (None, Some(left)) => {
            check_count(left)?;
            Ok(Some(left))
        }
        (Some(left), Some(right)) => {
            check_count(left)?;
            check_count(right)?;
            Ok(Some(left + right))
        }
    }
}

/// Combine bounded summaries. Counts remain exact when detail arrays truncate.
// Files stay in first-seen order here; the TypeScript shell sorts them with
// `localeCompare`, exactly as `@ace/projection` merges them.
pub fn merge_digests(digests: Vec<DigestOut>) -> Result<DigestOut, LongError> {
    let mut result = empty_digest();
    let mut files: Vec<FileOut> = Vec::new();
    let mut commands: Vec<CommandOut> = Vec::new();
    let mut files_overflow = false;
    let mut commands_overflow = false;
    for digest in &digests {
        result.commands_run += digest.commands_run;
        result.commands_failed += digest.commands_failed;
        result.approvals_asked += digest.approvals_asked;
        result.approvals_answered += digest.approvals_answered;
        result.approvals_auto_reviewed += digest.approvals_auto_reviewed;
        result.approvals_pending += digest.approvals_pending;
        result.subagents_started += digest.subagents_started;
        result.subagents_finished += digest.subagents_finished;
        result.errors += digest.errors;
        for (kind, value) in &digest.tool_counts.0 {
            if is_tool_kind(kind) {
                check_count(*value)?;
                if let Some(slot) = result
                    .tool_counts
                    .0
                    .iter_mut()
                    .find(|(name, _)| name == kind)
                {
                    slot.1 += *value;
                } else {
                    result.tool_counts.0.push((kind.clone(), *value));
                }
            }
        }
        result.input_tokens = merge_counts(result.input_tokens, digest.input_tokens)?;
        result.output_tokens = merge_counts(result.output_tokens, digest.output_tokens)?;
        for file in &digest.files {
            if let Some(previous) = files.iter_mut().find(|entry| entry.path == file.path) {
                previous.added = merge_nullable_count(previous.added, file.added)?;
                previous.removed = merge_nullable_count(previous.removed, file.removed)?;
            } else if files.len() < 64 {
                files.push(file.clone());
            } else {
                files_overflow = true;
            }
        }
        for command in &digest.commands {
            if let Some(previous) = commands
                .iter_mut()
                .find(|entry| entry.item_id == command.item_id)
            {
                *previous = command.clone();
            } else if commands.len() < 64 {
                commands.push(command.clone());
            } else {
                commands_overflow = true;
            }
        }
        if digest.truncated {
            result.truncated = true;
        }
    }
    result.files = files;
    result.commands = commands;
    if files_overflow || commands_overflow {
        result.truncated = true;
    }
    // Input and output stay null when every share has none.
    if digests.iter().all(|digest| digest.input_tokens.is_none()) {
        result.input_tokens = None;
    }
    if digests.iter().all(|digest| digest.output_tokens.is_none()) {
        result.output_tokens = None;
    }
    Ok(result)
}

fn merge_nullable_count(left: Option<i64>, right: Option<i64>) -> Result<Option<i64>, LongError> {
    match (left, right) {
        (None, _) | (_, None) => Ok(None),
        (Some(left), Some(right)) => Ok(Some(left + right)),
    }
}
