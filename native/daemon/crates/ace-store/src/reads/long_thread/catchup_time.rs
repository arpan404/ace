// SPDX-License-Identifier: Apache-2.0
//! `threadCatchUp` time-based and family reads.
//!
//! Since a time, each thread contributes its range counters and the files and
//! commands after the cutoff; the family merges into one digest. Rows arrive
//! as cells in the `SELECT` list's order, and the response serializes once.

use super::catchup::{counts, parse_file_row, read_since_seq, summary_digest};
use super::common::{LongError, all_rows_raw, as_preview_raw, check_count, get_row_raw, invalid};
use super::digests::{Counters, DigestOut, merge_digests, parse_command, validate_digest};
use super::range::{find_counters, range_after, range_suffix};
use super::row::{int_at, strs_json, text_at};
use super::status::{Status, parse_thread_status};
use super::turns::digest_indexed_seq;
use crate::{Connection, Value};
use serde::Serialize;
use std::sync::Arc;

fn file_counters(
    conn: &Arc<Connection>,
    thread: &str,
    paths: &[String],
    cutoff: i64,
) -> Result<Vec<Counters>, LongError> {
    let owners: Vec<String> = paths.iter().map(|path| format!("file:{path}")).collect();
    let values = range_after(conn, thread, &owners, cutoff)?;
    let mut out = Vec::new();
    for path in paths {
        let owner = format!("file:{path}");
        out.push(find_counters(&values, &owner).cloned().unwrap_or_default());
    }
    Ok(out)
}

fn commands_after(
    conn: &Arc<Connection>,
    thread: &str,
    time: i64,
) -> Result<(Vec<super::turns_types::CommandOut>, bool), LongError> {
    let items = all_rows_raw(
        conn,
        "SELECT item_id FROM long_time_commands WHERE thread_id=? AND at>? ORDER BY at,item_id LIMIT 65",
        vec![Value::Text(thread.to_owned()), Value::Integer(time)],
    )?;
    let mut ids: Vec<String> = Vec::new();
    for row in items {
        if let Ok(item_id) = text_at(&row, 0) {
            ids.push(item_id.to_owned());
        }
    }
    if ids.is_empty() {
        return Ok((Vec::new(), false));
    }
    let bounds = range_suffix(time);
    const SQL: &str = "WITH bounds(level,low,high) AS (VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?)) SELECT n.item_id,n.data,MAX(n.seq) AS seq FROM bounds b CROSS JOIN long_time_command_nodes n WHERE n.thread_id=? AND n.item_id IN (SELECT value FROM json_each(?)) AND n.level=b.level AND n.bucket>=b.low AND n.bucket<b.high GROUP BY n.item_id ORDER BY n.item_id";
    let mut params = Vec::new();
    for (level, low, high) in &bounds {
        params.push(Value::Integer(*level));
        params.push(Value::Integer(*low));
        params.push(Value::Integer(*high));
    }
    params.push(Value::Text(thread.to_owned()));
    let list = strs_json(&ids.iter().take(64).cloned().collect::<Vec<_>>())?;
    params.push(Value::Text(list));
    let rows = all_rows_raw(conn, SQL, params)?;
    let mut commands = Vec::new();
    for row in rows {
        match row.get(1) {
            None | Some(Value::Null) => continue,
            Some(Value::Text(text)) => {
                commands.push(parse_command(text)?);
            }
            Some(_) => return Err(invalid("invalid index row")),
        }
    }
    Ok((commands, ids.len() > 64))
}

fn read_since_time(
    conn: &Arc<Connection>,
    thread: &str,
    time: i64,
) -> Result<DigestOut, LongError> {
    let values = range_after(conn, thread, &["counters".to_owned()], time)?;
    let counters = find_counters(&values, "counters")
        .cloned()
        .unwrap_or_default();
    let current = counts(conn, thread, 0)?;
    let mut digest = summary_digest(&current, &counters)?;
    let files = all_rows_raw(
        conn,
        "SELECT t.path,COALESCE(f.refs,0) AS current_refs FROM long_time_files t LEFT JOIN long_files f ON f.thread_id=t.thread_id AND f.ordinal=0 AND f.path=t.path WHERE t.thread_id=? AND t.at>? ORDER BY t.at,t.path LIMIT 65",
        vec![Value::Text(thread.to_owned()), Value::Integer(time)],
    )?;
    let mut paths: Vec<String> = Vec::new();
    for row in files.iter().take(64) {
        if let Ok(path) = text_at(row, 0) {
            paths.push(path.to_owned());
        }
    }
    let totals = file_counters(conn, thread, &paths, time)?;
    let mut file_values = Vec::new();
    for row in files.iter().take(64) {
        let path = text_at(row, 0)?.to_owned();
        let current_refs = match row.get(1) {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => 0,
        };
        let Some(total) = paths
            .iter()
            .position(|known| *known == path)
            .and_then(|at| totals.get(at))
        else {
            continue;
        };
        let added = total.get("added").unwrap_or(0);
        let removed = total.get("removed").unwrap_or(0);
        let unknown = total.get("unknown").unwrap_or(0);
        let refs = total.get("refs").unwrap_or(0);
        let effective = current_refs > 0 || added > 0 || removed > 0 || unknown > 0 || refs > 0;
        if !effective {
            continue;
        }
        let unknown_now = unknown > 0;
        let added_now = if unknown_now { 0 } else { added.max(0) };
        let removed_now = if unknown_now { 0 } else { removed.max(0) };
        file_values.push(parse_file_row(&path, added_now, removed_now, unknown_now)?);
    }
    let (commands, truncated_commands) = commands_after(conn, thread, time)?;
    let truncated = files.len() > 64 || truncated_commands;
    digest.files = file_values;
    digest.commands = commands;
    digest.truncated = truncated;
    validate_digest(&digest)?;
    Ok(digest)
}

fn completed_after(
    conn: &Arc<Connection>,
    thread: &str,
    since_seq: Option<i64>,
    since_time: Option<i64>,
) -> Result<i64, LongError> {
    let (owner, position) = if let Some(seq) = since_seq {
        ("completed:seq", seq)
    } else if let Some(time) = since_time {
        ("completed:time", time)
    } else {
        return Err(invalid("invalid index row"));
    };
    let values = range_after(conn, thread, &[owner.to_owned()], position)?;
    Ok(find_counters(&values, owner)
        .and_then(|counters| counters.get("completed"))
        .unwrap_or(0)
        .max(0))
}

/// The response, in the protocol's field order.
#[derive(Serialize)]
struct CatchUp<'a> {
    #[serde(rename = "type")]
    type_: &'static str,
    #[serde(rename = "requestId")]
    request_id: &'a str,
    #[serde(rename = "threadId")]
    thread_id: &'a str,
    seq: i64,
    #[serde(rename = "indexedSeq")]
    indexed_seq: i64,
    ready: bool,
    #[serde(rename = "turnsCompleted")]
    turns_completed: i64,
    status: Status,
    digest: DigestOut,
    #[serde(rename = "latestAgentMessagePreview")]
    latest: String,
}

#[allow(clippy::too_many_arguments)]
pub fn thread_catch_up(
    conn: &Arc<Connection>,
    thread_id: &str,
    request_id: &str,
    since_seq: Option<i64>,
    since_time: Option<i64>,
    family: &[String],
    head_seq: i64,
) -> Result<String, LongError> {
    let thread_row = get_row_raw(
        conn,
        "SELECT status FROM threads WHERE id=?",
        vec![Value::Text(thread_id.to_owned())],
    )?
    .ok_or_else(|| invalid("thread_not_found"))?;
    let thread_status_text = text_at(&thread_row, 0)?;
    let thread_status = parse_thread_status(thread_status_text)?;
    let family_json = strs_json(family)?;
    let latest_row = get_row_raw(
        conn,
        "SELECT preview,created_seq FROM long_items WHERE thread_id IN (SELECT value FROM json_each(?)) AND role='assistant' ORDER BY created_seq DESC LIMIT 1",
        vec![Value::Text(family_json)],
    )?;
    let latest = match latest_row {
        None => String::new(),
        Some(row) => {
            let preview = text_at(&row, 0)?.to_owned();
            let seq = int_at(&row, 1)?;
            let _ = seq;
            preview
        }
    };
    as_preview_raw(&latest)?;
    let mut digests = Vec::new();
    for id in family {
        if since_seq.is_some() {
            digests.push(read_since_seq(conn, id, since_seq.unwrap_or(0))?);
        } else {
            digests.push(read_since_time(conn, id, since_time.unwrap_or(0))?);
        }
    }
    let digest = merge_digests(digests)?;
    let turns_completed = completed_after(conn, thread_id, since_seq, since_time)?;
    check_count(turns_completed)?;
    check_count(head_seq)?;
    let indexed = digest_indexed_seq(conn)?;
    check_count(indexed)?;
    let response = CatchUp {
        type_: "thread.catchUp",
        request_id,
        thread_id,
        seq: head_seq,
        indexed_seq: indexed,
        ready: indexed >= head_seq,
        turns_completed,
        status: thread_status,
        digest,
        latest,
    };
    let mut out = Vec::with_capacity(4096);
    serde_json::to_writer(&mut out, &response).map_err(|error| invalid(&error.to_string()))?;
    String::from_utf8(out).map_err(|_| invalid("invalid index row"))
}

pub fn descendant_threads(conn: &Arc<Connection>, thread: &str) -> Result<Vec<String>, LongError> {
    let rows = all_rows_raw(
        conn,
        "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT a.child_thread FROM long_agents a JOIN tree ON a.thread_id=tree.id JOIN threads t ON t.id=a.child_thread WHERE a.child_thread IS NOT NULL AND json_extract(t.client,'$.deletedAt') IS NULL) SELECT id FROM tree LIMIT 513",
        vec![Value::Text(thread.to_owned())],
    )?;
    if rows.len() > 512 {
        return Err(invalid("thread_tree_too_large"));
    }
    let mut out = Vec::new();
    for row in rows {
        match text_at(&row, 0) {
            Ok(id) => out.push(id.to_owned()),
            Err(_) => return Err(invalid("invalid index row")),
        }
    }
    Ok(out)
}
