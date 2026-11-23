// SPDX-License-Identifier: Apache-2.0
//! `threadCatchUp`, as `long-thread/reader.ts` reads it.

use super::common::{
    LongError, all_rows, as_count, as_preview, as_text, get_row, invalid, row_value,
};
use super::digests::{Counters, merge_digests};
use super::range::{range_after, range_suffix};
use super::status::parse_thread_status;
use super::turns::digest_indexed_seq;
use crate::{Connection, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

fn counts(conn: &Arc<Connection>, thread: &str, ordinal: i64) -> Result<Counters, LongError> {
    let rows = all_rows(
        conn,
        "SELECT key,value FROM long_counts WHERE thread_id=? AND ordinal=?",
        vec![Value::Text(thread.to_owned()), Value::Integer(ordinal)],
    )?;
    let mut out = Counters::new();
    for row in rows {
        let key = match row_value(&row, "key")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let value = match row_value(&row, "value")? {
            Value::Integer(n) => *n,
            Value::Real(n) => {
                if n.fract() != 0.0 {
                    return Err(invalid("invalid index row"));
                }
                *n as i64
            }
            _ => return Err(invalid("invalid index row")),
        };
        out.insert(key, value);
    }
    Ok(out)
}

fn range_counts(conn: &Arc<Connection>, thread: &str, seq: i64) -> Result<Counters, LongError> {
    let mut current = counts(conn, thread, 0)?;
    for key in current.keys().cloned().collect::<Vec<_>>() {
        let previous = get_row(
            conn,
            "SELECT value FROM long_prefix WHERE thread_id=? AND key=? AND seq<=? ORDER BY seq DESC LIMIT 1",
            vec![
                Value::Text(thread.to_owned()),
                Value::Text(key.clone()),
                Value::Integer(seq),
            ],
        )?;
        let prev = match previous.as_ref().and_then(|row| row.get("value")) {
            None | Some(Value::Null) => 0,
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            Some(_) => return Err(invalid("invalid index row")),
        };
        let value = current
            .get(&key)
            .copied()
            .unwrap_or(0)
            .saturating_sub(prev)
            .max(0);
        current.insert(key, value);
    }
    Ok(current)
}

fn summary_digest(
    current: &Counters,
    counters: &Counters,
) -> Result<serde_json::Map<String, serde_json::Value>, LongError> {
    let mut digest = super::digests::empty_digest_for_merge();
    for key in [
        "commandsRun",
        "commandsFailed",
        "approvalsAsked",
        "approvalsAnswered",
        "approvalsAutoReviewed",
        "subagentsStarted",
        "subagentsFinished",
        "errors",
    ] {
        let value = counters.get(key).copied().unwrap_or(0).max(0);
        super::common::as_count(&Value::Integer(value))?;
        digest.insert(key.to_owned(), serde_json::Value::Number(value.into()));
    }
    let mut tools = serde_json::Map::new();
    for (key, value) in counters {
        if let Some(kind) = key.strip_prefix("tool:")
            && super::common::is_tool_kind(kind)
        {
            let value = (*value).max(0);
            super::common::as_count(&Value::Integer(value))?;
            tools.insert(kind.to_owned(), serde_json::Value::Number(value.into()));
        }
    }
    digest.insert("toolCounts".to_owned(), serde_json::Value::Object(tools));
    let approvals = current.get("approvalsPending").copied().unwrap_or(0).max(0);
    super::common::as_count(&Value::Integer(approvals))?;
    digest.insert(
        "approvalsPending".to_owned(),
        serde_json::Value::Number(approvals.into()),
    );
    let token_samples = current.get("tokenSamples").copied().unwrap_or(0);
    if token_samples != 0 {
        let input = counters.get("inputTokens").copied().unwrap_or(0).max(0);
        let output = counters.get("outputTokens").copied().unwrap_or(0).max(0);
        super::common::as_count(&Value::Integer(input))?;
        super::common::as_count(&Value::Integer(output))?;
        digest.insert(
            "inputTokens".to_owned(),
            serde_json::Value::Number(input.into()),
        );
        digest.insert(
            "outputTokens".to_owned(),
            serde_json::Value::Number(output.into()),
        );
    } else {
        digest.insert("inputTokens".to_owned(), serde_json::Value::Null);
        digest.insert("outputTokens".to_owned(), serde_json::Value::Null);
    }
    Ok(digest)
}

fn parse_file_row(
    path: &str,
    added: i64,
    removed: i64,
    unknown: bool,
) -> Result<serde_json::Value, LongError> {
    super::common::as_path(&Value::Text(path.to_owned()))?;
    if path.is_empty() {
        return Err(invalid("invalid index row"));
    }
    let mut file = serde_json::Map::new();
    file.insert(
        "path".to_owned(),
        serde_json::Value::String(path.to_owned()),
    );
    if unknown {
        file.insert("added".to_owned(), serde_json::Value::Null);
        file.insert("removed".to_owned(), serde_json::Value::Null);
    } else {
        super::common::as_count(&Value::Integer(added))?;
        super::common::as_count(&Value::Integer(removed))?;
        file.insert("added".to_owned(), serde_json::Value::Number(added.into()));
        file.insert(
            "removed".to_owned(),
            serde_json::Value::Number(removed.into()),
        );
    }
    Ok(serde_json::Value::Object(file))
}

fn read_since_seq(
    conn: &Arc<Connection>,
    thread: &str,
    since: i64,
) -> Result<serde_json::Value, LongError> {
    let current = counts(conn, thread, 0)?;
    let counters = range_counts(conn, thread, since)?;
    let mut digest = summary_digest(&current, &counters)?;
    let files = all_rows(
        conn,
        "SELECT path,added,removed,unknown,refs FROM long_files WHERE thread_id=? AND ordinal=? AND last_seq>? ORDER BY last_seq,path LIMIT 65",
        vec![
            Value::Text(thread.to_owned()),
            Value::Integer(0),
            Value::Integer(since),
        ],
    )?;
    let mut file_values = Vec::new();
    for row in &files {
        let path = match row_value(row, "path")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let added = match row_value(row, "added")? {
            Value::Integer(n) => *n,
            Value::Real(n) => *n as i64,
            _ => return Err(invalid("invalid index row")),
        };
        let removed = match row_value(row, "removed")? {
            Value::Integer(n) => *n,
            Value::Real(n) => *n as i64,
            _ => return Err(invalid("invalid index row")),
        };
        let unknown = match row_value(row, "unknown")? {
            Value::Integer(n) => *n,
            Value::Real(n) => *n as i64,
            _ => return Err(invalid("invalid index row")),
        };
        let previous = get_row(
            conn,
            "SELECT added,removed,unknown FROM long_file_prefix WHERE thread_id=? AND path=? AND seq<=? ORDER BY seq DESC LIMIT 1",
            vec![
                Value::Text(thread.to_owned()),
                Value::Text(path.clone()),
                Value::Integer(since),
            ],
        )?;
        let (prev_added, prev_removed, prev_unknown) = match previous {
            None => (0, 0, 0),
            Some(row) => (
                match row.get("added") {
                    Some(Value::Integer(n)) => *n,
                    Some(Value::Real(n)) => *n as i64,
                    _ => 0,
                },
                match row.get("removed") {
                    Some(Value::Integer(n)) => *n,
                    Some(Value::Real(n)) => *n as i64,
                    _ => 0,
                },
                match row.get("unknown") {
                    Some(Value::Integer(n)) => *n,
                    Some(Value::Real(n)) => *n as i64,
                    _ => 0,
                },
            ),
        };
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
    let commands = all_rows(
        conn,
        "SELECT data FROM long_commands WHERE thread_id=? AND ordinal=? AND last_seq>? ORDER BY last_seq,item_id LIMIT 65",
        vec![
            Value::Text(thread.to_owned()),
            Value::Integer(0),
            Value::Integer(since),
        ],
    )?;
    let mut command_values = Vec::new();
    for row in &commands {
        let data = match row_value(row, "data")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let parsed = super::digests::parse_command_pub(&data)?;
        command_values.push(serde_json::Value::Object(parsed));
    }
    let truncated = files.len() > 64 || commands.len() > 64;
    digest.insert(
        "files".to_owned(),
        serde_json::Value::Array(file_values.into_iter().take(64).collect()),
    );
    digest.insert(
        "commands".to_owned(),
        serde_json::Value::Array(command_values.into_iter().take(64).collect()),
    );
    digest.insert("truncated".to_owned(), serde_json::Value::Bool(truncated));
    super::digests::validate_digest_pub(&digest)?;
    Ok(serde_json::Value::Object(digest))
}

fn file_counters(
    conn: &Arc<Connection>,
    thread: &str,
    paths: &[String],
    cutoff: i64,
) -> Result<BTreeMap<String, Counters>, LongError> {
    let owners: Vec<String> = paths.iter().map(|path| format!("file:{path}")).collect();
    let values = range_after(conn, thread, &owners, cutoff)?;
    let mut out = BTreeMap::new();
    for path in paths {
        let owner = format!("file:{path}");
        out.insert(
            path.clone(),
            values.get(&owner).cloned().unwrap_or_default(),
        );
    }
    Ok(out)
}

fn commands_after(
    conn: &Arc<Connection>,
    thread: &str,
    time: i64,
) -> Result<(Vec<serde_json::Value>, bool), LongError> {
    let items = all_rows(
        conn,
        "SELECT item_id FROM long_time_commands WHERE thread_id=? AND at>? ORDER BY at,item_id LIMIT 65",
        vec![Value::Text(thread.to_owned()), Value::Integer(time)],
    )?;
    let ids: Vec<String> = items
        .iter()
        .filter_map(|row| match row.get("item_id") {
            Some(Value::Text(text)) => Some(text.clone()),
            _ => None,
        })
        .collect();
    if ids.is_empty() {
        return Ok((Vec::new(), false));
    }
    let bounds = range_suffix(time);
    let mut sql = String::from("WITH bounds(level,low,high) AS (VALUES ");
    sql.push_str(
        &bounds
            .iter()
            .map(|_| "(?,?,?)")
            .collect::<Vec<_>>()
            .join(","),
    );
    sql.push_str(
        ") SELECT n.item_id,n.data,MAX(n.seq) AS seq FROM bounds b CROSS JOIN long_time_command_nodes n WHERE n.thread_id=? AND n.item_id IN (SELECT value FROM json_each(?)) AND n.level=b.level AND n.bucket>=b.low AND n.bucket<b.high GROUP BY n.item_id ORDER BY n.item_id",
    );
    let mut params = Vec::new();
    for (level, low, high) in &bounds {
        params.push(Value::Integer(*level));
        params.push(Value::Integer(*low));
        params.push(Value::Integer(*high));
    }
    params.push(Value::Text(thread.to_owned()));
    let list = serde_json::to_string(&ids.iter().take(64).collect::<Vec<_>>())
        .map_err(|error| invalid(&error.to_string()))?;
    params.push(Value::Text(list));
    let rows = all_rows(conn, &sql, params)?;
    let mut commands = Vec::new();
    for row in rows {
        match row.get("data") {
            None | Some(Value::Null) => continue,
            Some(Value::Text(text)) => {
                let parsed = super::digests::parse_command_pub(text)?;
                commands.push(serde_json::Value::Object(parsed));
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
) -> Result<serde_json::Value, LongError> {
    let counters = range_after(conn, thread, &["counters".to_owned()], time)?
        .get("counters")
        .cloned()
        .unwrap_or_default();
    let current = counts(conn, thread, 0)?;
    let mut digest = summary_digest(&current, &counters)?;
    let files = all_rows(
        conn,
        "SELECT t.path,COALESCE(f.refs,0) AS current_refs FROM long_time_files t LEFT JOIN long_files f ON f.thread_id=t.thread_id AND f.ordinal=0 AND f.path=t.path WHERE t.thread_id=? AND t.at>? ORDER BY t.at,t.path LIMIT 65",
        vec![Value::Text(thread.to_owned()), Value::Integer(time)],
    )?;
    let paths: Vec<String> = files
        .iter()
        .take(64)
        .filter_map(|row| match row.get("path") {
            Some(Value::Text(text)) => Some(text.clone()),
            _ => None,
        })
        .collect();
    let totals = file_counters(conn, thread, &paths, time)?;
    let mut file_values = Vec::new();
    for row in files.iter().take(64) {
        let path = match row_value(row, "path")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let current_refs = match row.get("current_refs") {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => 0,
        };
        let value = totals.get(&path).cloned().unwrap_or_default();
        let added = value.get("added").copied().unwrap_or(0);
        let removed = value.get("removed").copied().unwrap_or(0);
        let unknown = value.get("unknown").copied().unwrap_or(0);
        let refs = value.get("refs").copied().unwrap_or(0);
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
    digest.insert("files".to_owned(), serde_json::Value::Array(file_values));
    digest.insert("commands".to_owned(), serde_json::Value::Array(commands));
    digest.insert("truncated".to_owned(), serde_json::Value::Bool(truncated));
    super::digests::validate_digest_pub(&digest)?;
    Ok(serde_json::Value::Object(digest))
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
    Ok(values
        .get(owner)
        .and_then(|counters| counters.get("completed"))
        .copied()
        .unwrap_or(0)
        .max(0))
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
    let thread_row = get_row(
        conn,
        "SELECT status FROM threads WHERE id=?",
        vec![Value::Text(thread_id.to_owned())],
    )?
    .ok_or_else(|| invalid("thread_not_found"))?;
    let thread_status_text = as_text(row_value(&thread_row, "status")?)?;
    let thread_status = parse_thread_status(thread_status_text)?;
    let mut latest = String::new();
    let mut latest_seq = -1i64;
    for id in family {
        let row = get_row(
            conn,
            "SELECT preview,created_seq FROM long_items WHERE thread_id=? AND role='assistant' ORDER BY created_seq DESC LIMIT 1",
            vec![Value::Text(id.clone())],
        )?;
        if let Some(row) = row {
            let preview = match row_value(&row, "preview")? {
                Value::Text(text) => text.clone(),
                _ => return Err(invalid("invalid index row")),
            };
            let seq = match row_value(&row, "created_seq")? {
                Value::Integer(n) => *n,
                Value::Real(n) => *n as i64,
                _ => return Err(invalid("invalid index row")),
            };
            if seq > latest_seq {
                latest_seq = seq;
                latest = preview;
            }
        }
    }
    as_preview(&Value::Text(latest.clone()))?;
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
    as_count(&Value::Integer(turns_completed))?;
    as_count(&Value::Integer(head_seq))?;
    let indexed = digest_indexed_seq(conn)?;
    as_count(&Value::Integer(indexed))?;
    let mut response = serde_json::Map::new();
    response.insert(
        "type".to_owned(),
        serde_json::Value::String("thread.catchUp".to_owned()),
    );
    response.insert(
        "requestId".to_owned(),
        serde_json::Value::String(request_id.to_owned()),
    );
    response.insert(
        "threadId".to_owned(),
        serde_json::Value::String(thread_id.to_owned()),
    );
    response.insert("seq".to_owned(), serde_json::Value::Number(head_seq.into()));
    response.insert(
        "indexedSeq".to_owned(),
        serde_json::Value::Number(indexed.into()),
    );
    response.insert(
        "ready".to_owned(),
        serde_json::Value::Bool(indexed >= head_seq),
    );
    response.insert(
        "turnsCompleted".to_owned(),
        serde_json::Value::Number(turns_completed.into()),
    );
    response.insert("status".to_owned(), thread_status);
    response.insert("digest".to_owned(), digest);
    response.insert(
        "latestAgentMessagePreview".to_owned(),
        serde_json::Value::String(latest),
    );
    let text = serde_json::to_string(&serde_json::Value::Object(response))
        .map_err(|error| invalid(&error.to_string()))?;
    Ok(text)
}

pub fn descendant_threads(conn: &Arc<Connection>, thread: &str) -> Result<Vec<String>, LongError> {
    let rows = all_rows(
        conn,
        "WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT a.child_thread FROM long_agents a JOIN tree ON a.thread_id=tree.id JOIN threads t ON t.id=a.child_thread WHERE a.child_thread IS NOT NULL AND json_extract(t.client,'$.deletedAt') IS NULL) SELECT id FROM tree LIMIT 513",
        vec![Value::Text(thread.to_owned())],
    )?;
    if rows.len() > 512 {
        return Err(invalid("thread_tree_too_large"));
    }
    let mut out = Vec::new();
    for row in rows {
        match row.get("id") {
            Some(Value::Text(text)) => out.push(text.clone()),
            _ => return Err(invalid("invalid index row")),
        }
    }
    Ok(out)
}
