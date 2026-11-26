// SPDX-License-Identifier: Apache-2.0
//! Checkpoint identity and metadata (`packages/git/src/checkpoint-metadata.ts`, G5): the ref
//! namespace, the id's sequence, and the commit message every checkpoint commits carry.
//!
//! A checkpoint is a commit on `refs/ace/checkpoints/<thread>/<sequence>` whose message is the
//! JSON metadata. Its tree is the snapshot. Nothing here runs Git: `parse_commits` reads what
//! `git log -z --format=%H%x00%T%x00%B` printed, and the rest is the same strict decoding the
//! TypeScript does (`decode.ts`), so malformed output is refused with `malformed_output`.
//!
//! Proof: `malformed-output`'s `parseCommits` cases move here (guide rule 10).

use indexmap::IndexMap;

use crate::core::decode::{Records, hash, malformed, nul};
use crate::core::error::{GitError, GitErrorCode};

/// The message format every checkpoint commits.
pub const CHECKPOINT_FORMAT: &str = "ace-checkpoint-v1";
/// `Number.MAX_SAFE_INTEGER`, the sequence's bound.
pub const MAX_SEQUENCE: f64 = 9_007_199_254_740_991.0;

/// One checkpoint as the TypeScript's `Checkpoint` type carries it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Checkpoint {
    pub id: String,
    pub sha: String,
    pub tree: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub sequence: u64,
    pub label: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// A checkpoint commit's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub thread_id: String,
    pub label: String,
    pub created_at: String,
    pub sequence: Option<u64>,
}

/// One commit `git log` printed: its id, its tree and its metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommit {
    pub sha: String,
    pub tree: String,
    pub data: Metadata,
}

/// `checkpointPrefix`: the ref namespace of one thread's checkpoints.
pub fn checkpoint_prefix(thread_id: &str) -> Result<String, GitError> {
    if thread_id.is_empty()
        || !thread_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "threadId must contain only letters, digits, underscores or hyphens",
        ));
    }
    Ok(format!("refs/ace/checkpoints/{thread_id}/"))
}

/// `checkpointIdentity`: a checkpoint ref's thread and sequence. `[1-9][0-9]*`, then
/// `Number(text)`, so a sequence beyond the safe range is not an id.
pub fn checkpoint_identity(id: &str) -> Result<(String, u64), GitError> {
    let not_found = || {
        GitError::new(
            GitErrorCode::CheckpointNotFound,
            format!("Invalid checkpoint id: {id}"),
        )
    };
    let Some(rest) = id.strip_prefix("refs/ace/checkpoints/") else {
        return Err(not_found());
    };
    let Some((thread, sequence)) = rest.rsplit_once('/') else {
        return Err(not_found());
    };
    if thread.is_empty()
        || !thread
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(not_found());
    }
    let digits = sequence.as_bytes();
    if digits.is_empty() || digits[0] == b'0' || !digits.iter().all(u8::is_ascii_digit) {
        return Err(not_found());
    }
    // `Number(text)`: the decimal value rounds to the nearest double, and only a safe
    // integer is an id.
    let value: f64 = sequence.parse().map_err(|_| not_found())?;
    if !value.is_finite() || value.fract() != 0.0 || value > MAX_SEQUENCE {
        return Err(not_found());
    }
    Ok((thread.to_owned(), value as u64))
}

/// `Number.isSafeInteger` over a JSON number.
fn safe_sequence(value: f64) -> Option<u64> {
    if value.is_finite() && value.fract() == 0.0 && (1.0..=MAX_SEQUENCE).contains(&value) {
        Some(value as u64)
    } else {
        None
    }
}

/// `z.iso.datetime()`: a calendar date-time with seconds, an optional fraction and `Z` or a
/// numeric offset.
fn iso_datetime(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    let digits = |from: usize, to: usize| -> Option<u32> {
        let part = text.get(from..to)?;
        if !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(0, 4),
        digits(5, 7),
        digits(8, 10),
        digits(11, 13),
        digits(14, 16),
        digits(17, 19),
    ) else {
        return false;
    };
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return false;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let rest = &text[19..];
    let rest = match rest.strip_prefix('.') {
        Some(fraction) => {
            let digits: String = fraction.chars().take_while(char::is_ascii_digit).collect();
            if digits.is_empty() {
                return false;
            }
            &fraction[digits.len()..]
        }
        None => rest,
    };
    match rest.as_bytes() {
        [b'Z'] => true,
        [sign, hour_a, hour_b, b':', minute_a, minute_b] => {
            matches!(sign, b'+' | b'-')
                && [hour_a, hour_b, minute_a, minute_b]
                    .iter()
                    .all(|byte| byte.is_ascii_digit())
                && hour_a.saturating_sub(b'0') <= 2
                && minute_a.saturating_sub(b'0') <= 5
        }
        _ => false,
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

/// `metadata(message)`: the commit's JSON, strictly checked.
pub fn metadata(message: &str) -> Result<Metadata, GitError> {
    let value = ace_json::parse(message).map_err(|_| malformed("checkpoint JSON"))?;
    let fields = match &value {
        ace_json::Value::Object(fields) => fields,
        _ => return Err(malformed("checkpoint metadata")),
    };
    let invalid = || malformed("checkpoint metadata");
    let text = |key: &str| match fields.get(key) {
        Some(ace_json::Value::String(text)) => Some(text.as_str()),
        _ => None,
    };
    if text("format") != Some(CHECKPOINT_FORMAT) {
        return Err(invalid());
    }
    let thread_id = text("threadId").ok_or_else(invalid)?;
    if thread_id.is_empty()
        || !thread_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(invalid());
    }
    let label = text("label").ok_or_else(invalid)?;
    let created_at = text("createdAt").ok_or_else(invalid)?;
    if !iso_datetime(created_at) {
        return Err(invalid());
    }
    let sequence = match fields.get("sequence") {
        None => None,
        Some(ace_json::Value::Number(number)) => {
            Some(safe_sequence(number.as_f64().unwrap_or(0.0)).ok_or_else(invalid)?)
        }
        Some(_) => return Err(invalid()),
    };
    Ok(Metadata {
        thread_id: thread_id.to_owned(),
        label: label.to_owned(),
        created_at: created_at.to_owned(),
        sequence,
    })
}

/// The message `JSON.stringify({format, threadId, label, createdAt, sequence})` writes.
pub fn metadata_message(thread_id: &str, label: &str, created_at: &str, sequence: u64) -> String {
    ace_json::to_string(&ace_json::json!({
        "format": CHECKPOINT_FORMAT,
        "threadId": thread_id,
        "label": label,
        "createdAt": created_at,
        "sequence": sequence,
    }))
}

/// `parseCommits`: `git log -z --format=%H%x00%T%x00%B`, one sha, tree and message per commit.
pub fn parse_commits(bytes: &[u8]) -> Result<IndexMap<String, ParsedCommit>, GitError> {
    let mut commits = IndexMap::new();
    let mut records = Records::new(nul(bytes)?);
    while !records.done() {
        let sha = hash(records.next()?)?;
        let tree = hash(records.next()?)?;
        let data = metadata(records.next()?)?;
        if commits.contains_key(&sha) {
            return Err(malformed("duplicate commit record"));
        }
        commits.insert(sha.clone(), ParsedCommit { sha, tree, data });
    }
    Ok(commits)
}

/// `checkpoint`: the record for one id and its commit, with the id and the metadata agreeing.
pub fn checkpoint(id: &str, commit: &ParsedCommit) -> Result<Checkpoint, GitError> {
    let (thread_id, sequence) = checkpoint_identity(id)?;
    if thread_id != commit.data.thread_id
        || commit
            .data
            .sequence
            .is_some_and(|stored| stored != sequence)
    {
        return Err(malformed("checkpoint identity"));
    }
    Ok(Checkpoint {
        id: id.to_owned(),
        sha: commit.sha.clone(),
        tree: commit.tree.clone(),
        thread_id,
        sequence,
        label: commit.data.label.clone(),
        created_at: commit.data.created_at.clone(),
    })
}

#[cfg(test)]
mod tests;
