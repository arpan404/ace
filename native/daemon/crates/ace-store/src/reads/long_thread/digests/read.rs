// SPDX-License-Identifier: Apache-2.0
//! Whole-turn and per-agent digests, read for a page at once.
//!
//! Each statement reads every key of a page in one round trip: a key's rows
//! come from its own indexed lookup with the same order and limit a single-key
//! read uses, so a busy turn never makes the others read more. Rows arrive as
//! cells in the `SELECT` list's order; counters keep the rows' order so
//! `toolCounts` serializes exactly as the loader's object does.

use super::super::common::{LongError, all_rows_raw, check_count};
use super::super::row::{agent_keys_json, int_at, text_at, turn_keys_json};
use super::super::turns_types::{
    Counters, DigestOut, agent_file, digest_from_counters, parse_command, turn_file,
    validate_digest,
};
use crate::{Connection, Value};
use std::sync::Arc;

fn counters_from(rows: &[Vec<Value>]) -> Result<Counters, LongError> {
    counters_at(rows, 0, 1)
}

/// Counter rows carry their page key first; the name and value follow it.
fn counters_at(
    rows: &[Vec<Value>],
    name_at: usize,
    value_at: usize,
) -> Result<Counters, LongError> {
    let mut counters = Counters::new();
    for row in rows {
        let name = text_at(row, name_at)?.to_owned();
        let value = int_at(row, value_at)?;
        counters.insert(name, value);
    }
    Ok(counters)
}

fn grouped(rows: Vec<Vec<Value>>, count: usize) -> Vec<Vec<Vec<Value>>> {
    let mut groups: Vec<Vec<Vec<Value>>> = Vec::new();
    groups.resize_with(count, Vec::new);
    for row in rows {
        let key = match row.first() {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => continue,
        };
        if key >= 0
            && let Some(group) = groups.get_mut(key as usize)
        {
            group.push(row);
        }
    }
    groups
}

const TURN_COUNTS: &str = "SELECT j.key AS k, c.key, c.value FROM json_each(?) j CROSS JOIN long_counts c ON c.thread_id=json_extract(j.value,'$[0]') AND c.ordinal=json_extract(j.value,'$[1]')";
const TURN_FILES: &str = "SELECT j.key AS k, f.added, f.removed, f.unknown, f.path FROM json_each(?) j CROSS JOIN long_files f WHERE f.rowid IN (SELECT rowid FROM long_files WHERE thread_id=json_extract(j.value,'$[0]') AND ordinal=json_extract(j.value,'$[1]') AND last_seq>-1 ORDER BY last_seq,path LIMIT 65) ORDER BY j.key, f.last_seq, f.path";
const TURN_COMMANDS: &str = "SELECT j.key AS k, c.data FROM json_each(?) j CROSS JOIN long_commands c WHERE c.rowid IN (SELECT rowid FROM long_commands WHERE thread_id=json_extract(j.value,'$[0]') AND ordinal=json_extract(j.value,'$[1]') AND last_seq>-1 ORDER BY last_seq,item_id LIMIT 65) ORDER BY j.key, c.last_seq, c.item_id";
const AGENT_COUNTS: &str = "SELECT j.key AS k, c.key, c.value FROM json_each(?) j CROSS JOIN long_agent_counts c ON c.thread_id=? AND c.ordinal=json_extract(j.value,'$[0]') AND c.agent_id=json_extract(j.value,'$[1]')";
const AGENT_FILES: &str = "SELECT j.key AS k, f.added, f.removed, f.unknown, f.path FROM json_each(?) j CROSS JOIN long_agent_files f WHERE f.rowid IN (SELECT rowid FROM long_agent_files WHERE thread_id=? AND ordinal=json_extract(j.value,'$[0]') AND agent_id=json_extract(j.value,'$[1]') ORDER BY path LIMIT 65) ORDER BY j.key, f.path";
const AGENT_COMMANDS: &str = "SELECT j.key AS k, c.data FROM json_each(?) j CROSS JOIN long_commands c WHERE c.rowid IN (SELECT c2.rowid FROM long_commands c2 JOIN long_items i ON i.thread_id=c2.thread_id AND i.item_id=c2.item_id WHERE c2.thread_id=? AND c2.ordinal=json_extract(j.value,'$[0]') AND i.agent_id=json_extract(j.value,'$[1]') ORDER BY c2.item_id LIMIT 65) ORDER BY j.key, c.item_id";

fn finish_digest(
    mut digest: DigestOut,
    files: Vec<crate::reads::long_thread::turns_types::FileOut>,
    commands: Vec<crate::reads::long_thread::turns_types::CommandOut>,
) -> Result<DigestOut, LongError> {
    let truncated = files.len() > 64 || commands.len() > 64;
    digest.files = files.into_iter().take(64).collect();
    digest.commands = commands.into_iter().take(64).collect();
    digest.truncated = truncated;
    validate_digest(&digest)?;
    Ok(digest)
}

/// The whole-turn digests of `keys`, with the counters each was built from.
pub fn read_turn_digests(
    conn: &Arc<Connection>,
    keys: &[(String, i64)],
) -> Result<Vec<(DigestOut, Counters)>, LongError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let list_text = turn_keys_json(keys)?;
    let counts = grouped(
        all_rows_raw(conn, TURN_COUNTS, vec![Value::Text(list_text.clone())])?,
        keys.len(),
    );
    let files = grouped(
        all_rows_raw(conn, TURN_FILES, vec![Value::Text(list_text.clone())])?,
        keys.len(),
    );
    let commands = grouped(
        all_rows_raw(conn, TURN_COMMANDS, vec![Value::Text(list_text)])?,
        keys.len(),
    );
    let mut out = Vec::new();
    for (index, _) in keys.iter().enumerate() {
        let current = counters_at(counts.get(index).map(Vec::as_slice).unwrap_or(&[]), 1, 2)?;
        let mut digest = digest_from_counters(&current);
        let approvals = current.get("approvalsPending").unwrap_or(0).max(0);
        check_count(approvals)?;
        digest.approvals_pending = approvals;
        let token_samples = current.get("tokenSamples").unwrap_or(0);
        if token_samples != 0 {
            let input = current.get("inputTokens").unwrap_or(0).max(0);
            let output = current.get("outputTokens").unwrap_or(0).max(0);
            check_count(input)?;
            check_count(output)?;
            digest.input_tokens = Some(input);
            digest.output_tokens = Some(output);
        } else {
            digest.input_tokens = None;
            digest.output_tokens = None;
        }
        let mut file_values = Vec::new();
        for row in files.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let added = int_at(row, 1)?;
            let removed = int_at(row, 2)?;
            let unknown = int_at(row, 3)?;
            let path = text_at(row, 4)?;
            file_values.push(turn_file(path, added, removed, unknown)?);
        }
        let mut command_values = Vec::new();
        for row in commands.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let data = text_at(row, 1)?;
            command_values.push(parse_command(data)?);
        }
        let finished = finish_digest(digest, file_values, command_values)?;
        out.push((finished, current));
    }
    Ok(out)
}

/// Each agent's own share of its turn in `thread`, in the order of `keys`.
pub fn read_agent_digests(
    conn: &Arc<Connection>,
    thread: &str,
    keys: &[(i64, String)],
) -> Result<Vec<DigestOut>, LongError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let list_text = agent_keys_json(keys)?;
    let counts = grouped(
        all_rows_raw(
            conn,
            AGENT_COUNTS,
            vec![
                Value::Text(list_text.clone()),
                Value::Text(thread.to_owned()),
            ],
        )?,
        keys.len(),
    );
    let files = grouped(
        all_rows_raw(
            conn,
            AGENT_FILES,
            vec![
                Value::Text(list_text.clone()),
                Value::Text(thread.to_owned()),
            ],
        )?,
        keys.len(),
    );
    let commands = grouped(
        all_rows_raw(
            conn,
            AGENT_COMMANDS,
            vec![Value::Text(list_text), Value::Text(thread.to_owned())],
        )?,
        keys.len(),
    );
    let mut out = Vec::new();
    for index in 0..keys.len() {
        let current = counters_at(counts.get(index).map(Vec::as_slice).unwrap_or(&[]), 1, 2)?;
        let digest = digest_from_counters(&current);
        let mut file_values = Vec::new();
        for row in files.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let added = int_at(row, 1)?;
            let removed = int_at(row, 2)?;
            let unknown = int_at(row, 3)?;
            let path = text_at(row, 4)?;
            file_values.push(agent_file(path, added, removed, unknown)?);
        }
        let mut command_values = Vec::new();
        for row in commands.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let data = text_at(row, 1)?;
            command_values.push(parse_command(data)?);
        }
        out.push(finish_digest(digest, file_values, command_values)?);
    }
    Ok(out)
}

/// One turn's counters, in the index rows' order.
pub fn digest_counts(
    conn: &Arc<Connection>,
    thread: &str,
    ordinal: i64,
) -> Result<Counters, LongError> {
    let rows = all_rows_raw(
        conn,
        "SELECT key,value FROM long_counts WHERE thread_id=? AND ordinal=?",
        vec![Value::Text(thread.to_owned()), Value::Integer(ordinal)],
    )?;
    counters_from(&rows)
}
