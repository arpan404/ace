// SPDX-License-Identifier: Apache-2.0
//! `threadCatchUp` sequence reads, as `long-thread/reader.ts` reads them.
//!
//! The summary since a sequence subtracts each counter's prefix value at the
//! cutoff, and files diff against their prefix totals; rows arrive as cells in
//! the `SELECT` list's order.

use super::common::{LongError, all_rows_raw, check_count};
use super::digests::{Counters, DigestOut, digest_counts, digest_from_counters, parse_command};
use super::range::prefix_number;
use super::row::{int_at, strs_json, text_at};
use super::turns_types::{FileOut, validate_digest};
use crate::{Connection, Value};
use std::sync::Arc;

pub(crate) fn counts(
    conn: &Arc<Connection>,
    thread: &str,
    ordinal: i64,
) -> Result<Counters, LongError> {
    digest_counts(conn, thread, ordinal)
}

fn range_counts(conn: &Arc<Connection>, thread: &str, seq: i64) -> Result<Counters, LongError> {
    let mut current = counts(conn, thread, 0)?;
    let keys: Vec<String> = current.iter().map(|(name, _)| name.to_owned()).collect();
    if !keys.is_empty() {
        let list = strs_json(&keys)?;
        let prev_rows = all_rows_raw(
            conn,
            "SELECT j.value AS key,(SELECT value FROM long_prefix WHERE thread_id=? AND key=j.value AND seq<=? ORDER BY seq DESC LIMIT 1) AS value FROM json_each(?) j",
            vec![
                Value::Text(thread.to_owned()),
                Value::Integer(seq),
                Value::Text(list),
            ],
        )?;
        let mut prev: Vec<(String, i64)> = Vec::new();
        for row in prev_rows {
            let key = match text_at(&row, 0) {
                Ok(key) => key.to_owned(),
                Err(_) => continue,
            };
            prev.push((key, prefix_number(&row, 1)));
        }
        let mut next = Counters::new();
        for (key, value) in current.iter() {
            let before = prev
                .iter()
                .find(|(name, _)| name == key)
                .map_or(0, |(_, value)| *value);
            next.insert(key.to_owned(), value.saturating_sub(before).max(0));
        }
        current = next;
    }
    Ok(current)
}

pub(crate) fn summary_digest(
    current: &Counters,
    counters: &Counters,
) -> Result<DigestOut, LongError> {
    let mut digest = digest_from_counters(counters);
    let approvals = current.get("approvalsPending").unwrap_or(0);
    check_count(approvals)?;
    digest.approvals_pending = approvals;
    let token_samples = current.get("tokenSamples").unwrap_or(0);
    if token_samples != 0 {
        let input = counters.get("inputTokens").unwrap_or(0).max(0);
        let output = counters.get("outputTokens").unwrap_or(0).max(0);
        check_count(input)?;
        check_count(output)?;
        digest.input_tokens = Some(input);
        digest.output_tokens = Some(output);
    } else {
        digest.input_tokens = None;
        digest.output_tokens = None;
    }
    Ok(digest)
}

pub(crate) fn parse_file_row(
    path: &str,
    added: i64,
    removed: i64,
    unknown: bool,
) -> Result<FileOut, LongError> {
    super::common::check_path(path)?;
    super::common::check_id(path)?;
    if unknown {
        return Ok(FileOut {
            path: path.to_owned(),
            added: None,
            removed: None,
        });
    }
    check_count(added)?;
    check_count(removed)?;
    Ok(FileOut {
        path: path.to_owned(),
        added: Some(added),
        removed: Some(removed),
    })
}

pub(crate) fn read_since_seq(
    conn: &Arc<Connection>,
    thread: &str,
    since: i64,
) -> Result<DigestOut, LongError> {
    let current = counts(conn, thread, 0)?;
    let counters = range_counts(conn, thread, since)?;
    let mut digest = summary_digest(&current, &counters)?;
    let files = all_rows_raw(
        conn,
        "SELECT path,added,removed,unknown,refs FROM long_files WHERE thread_id=? AND ordinal=? AND last_seq>? ORDER BY last_seq,path LIMIT 65",
        vec![
            Value::Text(thread.to_owned()),
            Value::Integer(0),
            Value::Integer(since),
        ],
    )?;
    let mut paths: Vec<String> = Vec::new();
    for row in &files {
        if let Ok(path) = text_at(row, 0) {
            paths.push(path.to_owned());
        }
    }
    let prev: Vec<(String, (i64, i64, i64))> = if paths.is_empty() {
        Vec::new()
    } else {
        let list = strs_json(&paths)?;
        let prev_rows = all_rows_raw(
            conn,
            "SELECT j.value AS path,(SELECT added FROM long_file_prefix WHERE thread_id=? AND path=j.value AND seq<=? ORDER BY seq DESC LIMIT 1) AS added,(SELECT removed FROM long_file_prefix WHERE thread_id=? AND path=j.value AND seq<=? ORDER BY seq DESC LIMIT 1) AS removed,(SELECT unknown FROM long_file_prefix WHERE thread_id=? AND path=j.value AND seq<=? ORDER BY seq DESC LIMIT 1) AS unknown FROM json_each(?) j",
            vec![
                Value::Text(thread.to_owned()),
                Value::Integer(since),
                Value::Text(thread.to_owned()),
                Value::Integer(since),
                Value::Text(thread.to_owned()),
                Value::Integer(since),
                Value::Text(list),
            ],
        )?;
        let mut map = Vec::new();
        for row in prev_rows {
            let Ok(path) = text_at(&row, 0) else {
                continue;
            };
            map.push((
                path.to_owned(),
                (
                    prefix_number(&row, 1),
                    prefix_number(&row, 2),
                    prefix_number(&row, 3),
                ),
            ));
        }
        map
    };
    let files_truncated = files.len() > 64;
    let mut file_values = Vec::new();
    for row in files.iter().take(64) {
        let path = text_at(row, 0)?.to_owned();
        let added = int_at(row, 1)?;
        let removed = int_at(row, 2)?;
        let unknown = int_at(row, 3)?;
        let (prev_added, prev_removed, prev_unknown) = prev
            .iter()
            .find(|(known, _)| *known == path)
            .map_or((0, 0, 0), |(_, totals)| *totals);
        let unknown_now = unknown - prev_unknown > 0;
        let added_now = if unknown_now {
            0
        } else {
            (added - prev_added).max(0)
        };
        let removed_now = if unknown_now {
            0
        } else {
            (removed - prev_removed).max(0)
        };
        file_values.push(parse_file_row(&path, added_now, removed_now, unknown_now)?);
    }
    let commands = all_rows_raw(
        conn,
        "SELECT data FROM long_commands WHERE thread_id=? AND ordinal=? AND last_seq>? ORDER BY last_seq,item_id LIMIT 65",
        vec![
            Value::Text(thread.to_owned()),
            Value::Integer(0),
            Value::Integer(since),
        ],
    )?;
    let commands_truncated = commands.len() > 64;
    let mut command_values = Vec::new();
    for row in commands.iter().take(64) {
        let data = text_at(row, 0)?;
        command_values.push(parse_command(data)?);
    }
    let truncated = files_truncated || commands_truncated;
    digest.files = file_values;
    digest.commands = command_values;
    digest.truncated = truncated;
    validate_digest(&digest)?;
    Ok(digest)
}
