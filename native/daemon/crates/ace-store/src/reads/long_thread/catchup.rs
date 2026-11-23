// SPDX-License-Identifier: Apache-2.0
//! `threadCatchUp`, as `long-thread/reader.ts` reads it.

use super::common::{LongError, all_rows, get_row, invalid, row_value};
use super::digests::Counters;
use crate::{Connection, Value};
use std::sync::Arc;

pub(crate) fn counts(
    conn: &Arc<Connection>,
    thread: &str,
    ordinal: i64,
) -> Result<Counters, LongError> {
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
    let keys: Vec<String> = current.keys().cloned().collect();
    if !keys.is_empty() {
        let list = serde_json::to_string(&keys).map_err(|error| invalid(&error.to_string()))?;
        let prev_rows = all_rows(
            conn,
            "SELECT j.value AS key,(SELECT value FROM long_prefix WHERE thread_id=? AND key=j.value AND seq<=? ORDER BY seq DESC LIMIT 1) AS value FROM json_each(?) j",
            vec![
                Value::Text(thread.to_owned()),
                Value::Integer(seq),
                Value::Text(list),
            ],
        )?;
        let mut prev_map = std::collections::BTreeMap::new();
        for row in prev_rows {
            let key = match row.get("key") {
                Some(Value::Text(text)) => text.clone(),
                _ => continue,
            };
            let value = match row.get("value") {
                Some(Value::Integer(n)) => *n,
                Some(Value::Real(n)) => *n as i64,
                _ => 0,
            };
            prev_map.insert(key, value);
        }
        for key in keys {
            let prev = prev_map.get(&key).copied().unwrap_or(0);
            let value = current
                .get(&key)
                .copied()
                .unwrap_or(0)
                .saturating_sub(prev)
                .max(0);
            current.insert(key, value);
        }
    }
    Ok(current)
}

pub(crate) fn summary_digest(
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

pub(crate) fn parse_file_row(
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

pub(crate) fn read_since_seq(
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
    let paths: Vec<String> = files
        .iter()
        .filter_map(|row| match row.get("path") {
            Some(Value::Text(text)) => Some(text.clone()),
            _ => None,
        })
        .collect();
    let prev_map = if paths.is_empty() {
        std::collections::BTreeMap::new()
    } else {
        let list = serde_json::to_string(&paths).map_err(|error| invalid(&error.to_string()))?;
        let prev_rows = all_rows(
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
        let mut map = std::collections::BTreeMap::new();
        for row in prev_rows {
            let path = match row.get("path") {
                Some(Value::Text(text)) => text.clone(),
                _ => continue,
            };
            let added = match row.get("added") {
                Some(Value::Integer(n)) => *n,
                Some(Value::Real(n)) => *n as i64,
                _ => 0,
            };
            let removed = match row.get("removed") {
                Some(Value::Integer(n)) => *n,
                Some(Value::Real(n)) => *n as i64,
                _ => 0,
            };
            let unknown = match row.get("unknown") {
                Some(Value::Integer(n)) => *n,
                Some(Value::Real(n)) => *n as i64,
                _ => 0,
            };
            map.insert(path, (added, removed, unknown));
        }
        map
    };
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
        let (prev_added, prev_removed, prev_unknown) =
            prev_map.get(&path).copied().unwrap_or((0, 0, 0));
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
