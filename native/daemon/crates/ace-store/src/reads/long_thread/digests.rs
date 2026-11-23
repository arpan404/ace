// SPDX-License-Identifier: Apache-2.0
//! Whole-turn and per-agent digests, as `long-thread/turn-digests.ts` reads them.

use super::common::{
    LongError, Row, all_rows, as_count, as_id, as_ordinal, as_path, integer_value, invalid,
    is_tool_kind, row_opt, row_value,
};
use crate::{Connection, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

pub type Counters = BTreeMap<String, i64>;

fn counters_from(rows: &[Row]) -> Result<Counters, LongError> {
    let mut counters = Counters::new();
    for row in rows {
        let key = row_value(row, "key")?;
        let value = row_value(row, "value")?;
        let name = match key {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        counters.insert(name, integer_value(value)?);
    }
    Ok(counters)
}

fn grouped(rows: Vec<Row>, count: usize) -> Vec<Vec<Row>> {
    let mut groups: Vec<Vec<Row>> = Vec::new();
    for _ in 0..count {
        groups.push(Vec::new());
    }
    for row in rows {
        let key = match row.get("k") {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => continue,
        };
        if key >= 0 {
            let index = key as usize;
            if let Some(group) = groups.get_mut(index) {
                group.push(row);
            }
        }
    }
    groups
}

const TURN_COUNTS: &str = "SELECT j.key AS k, c.key AS key, c.value AS value FROM json_each(?) j CROSS JOIN long_counts c ON c.thread_id=json_extract(j.value,'$[0]') AND c.ordinal=json_extract(j.value,'$[1]')";
const TURN_FILES: &str = "SELECT j.key AS k, f.added AS added, f.removed AS removed, f.unknown AS unknown, f.path AS path FROM json_each(?) j CROSS JOIN long_files f WHERE f.rowid IN (SELECT rowid FROM long_files WHERE thread_id=json_extract(j.value,'$[0]') AND ordinal=json_extract(j.value,'$[1]') AND last_seq>-1 ORDER BY last_seq,path LIMIT 65) ORDER BY j.key, f.last_seq, f.path";
const TURN_COMMANDS: &str = "SELECT j.key AS k, c.data AS data FROM json_each(?) j CROSS JOIN long_commands c WHERE c.rowid IN (SELECT rowid FROM long_commands WHERE thread_id=json_extract(j.value,'$[0]') AND ordinal=json_extract(j.value,'$[1]') AND last_seq>-1 ORDER BY last_seq,item_id LIMIT 65) ORDER BY j.key, c.last_seq, c.item_id";
const AGENT_COUNTS: &str = "SELECT j.key AS k, c.key AS key, c.value AS value FROM json_each(?) j CROSS JOIN long_agent_counts c ON c.thread_id=? AND c.ordinal=json_extract(j.value,'$[0]') AND c.agent_id=json_extract(j.value,'$[1]')";
const AGENT_FILES: &str = "SELECT j.key AS k, f.added AS added, f.removed AS removed, f.unknown AS unknown, f.path AS path FROM json_each(?) j CROSS JOIN long_agent_files f WHERE f.rowid IN (SELECT rowid FROM long_agent_files WHERE thread_id=? AND ordinal=json_extract(j.value,'$[0]') AND agent_id=json_extract(j.value,'$[1]') ORDER BY path LIMIT 65) ORDER BY j.key, f.path";
const AGENT_COMMANDS: &str = "SELECT j.key AS k, c.data AS data FROM json_each(?) j CROSS JOIN long_commands c WHERE c.rowid IN (SELECT c2.rowid FROM long_commands c2 JOIN long_items i ON i.thread_id=c2.thread_id AND i.item_id=c2.item_id WHERE c2.thread_id=? AND c2.ordinal=json_extract(j.value,'$[0]') AND i.agent_id=json_extract(j.value,'$[1]') ORDER BY c2.item_id LIMIT 65) ORDER BY j.key, c.item_id";

fn empty_digest() -> serde_json::Map<String, serde_json::Value> {
    let mut digest = serde_json::Map::new();
    digest.insert(
        "toolCounts".to_owned(),
        serde_json::Value::Object(serde_json::Map::new()),
    );
    digest.insert("files".to_owned(), serde_json::Value::Array(Vec::new()));
    digest.insert("commands".to_owned(), serde_json::Value::Array(Vec::new()));
    for key in [
        "commandsRun",
        "commandsFailed",
        "approvalsAsked",
        "approvalsAnswered",
        "approvalsAutoReviewed",
        "approvalsPending",
        "subagentsStarted",
        "subagentsFinished",
        "errors",
    ] {
        digest.insert(key.to_owned(), serde_json::Value::Number(0.into()));
    }
    digest.insert("inputTokens".to_owned(), serde_json::Value::Null);
    digest.insert("outputTokens".to_owned(), serde_json::Value::Null);
    digest.insert("truncated".to_owned(), serde_json::Value::Bool(false));
    digest
}

fn digest_from_counters(counters: &Counters) -> serde_json::Map<String, serde_json::Value> {
    let mut digest = empty_digest();
    for key in [
        "commandsRun",
        "commandsFailed",
        "approvalsAsked",
        "approvalsAnswered",
        "approvalsAutoReviewed",
        "approvalsPending",
        "subagentsStarted",
        "subagentsFinished",
        "errors",
    ] {
        let value = counters.get(key).copied().unwrap_or(0).max(0);
        digest.insert(key.to_owned(), serde_json::Value::Number(value.into()));
    }
    let mut tools = serde_json::Map::new();
    for (key, value) in counters {
        if let Some(kind) = key.strip_prefix("tool:")
            && is_tool_kind(kind)
        {
            tools.insert(
                kind.to_owned(),
                serde_json::Value::Number((*value).max(0).into()),
            );
        }
    }
    digest.insert("toolCounts".to_owned(), serde_json::Value::Object(tools));
    if let Some(value) = counters.get("inputTokens") {
        digest.insert(
            "inputTokens".to_owned(),
            serde_json::Value::Number((*value).into()),
        );
    }
    if let Some(value) = counters.get("outputTokens") {
        digest.insert(
            "outputTokens".to_owned(),
            serde_json::Value::Number((*value).into()),
        );
    }
    digest
}

fn parse_command(data: &str) -> Result<serde_json::Map<String, serde_json::Value>, LongError> {
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|_| invalid("invalid index row"))?;
    let item = value
        .get("itemId")
        .and_then(|item| item.as_str())
        .ok_or_else(|| invalid("invalid index row"))?;
    if item.is_empty() {
        return Err(invalid("invalid index row"));
    }
    let command = value
        .get("command")
        .and_then(|command| command.as_str())
        .ok_or_else(|| invalid("invalid index row"))?;
    if super::common::js_len(command) > 1024 {
        return Err(invalid("invalid index row"));
    }
    let failed = value
        .get("failed")
        .and_then(|failed| failed.as_bool())
        .ok_or_else(|| invalid("invalid index row"))?;
    let mut out = serde_json::Map::new();
    out.insert(
        "itemId".to_owned(),
        serde_json::Value::String(item.to_owned()),
    );
    out.insert(
        "command".to_owned(),
        serde_json::Value::String(command.to_owned()),
    );
    out.insert("failed".to_owned(), serde_json::Value::Bool(failed));
    if let Some(exit) = value.get("exitCode")
        && !exit.is_null()
    {
        let code = exit.as_i64().ok_or_else(|| invalid("invalid index row"))?;
        out.insert(
            "exitCode".to_owned(),
            serde_json::Value::Number(code.into()),
        );
    }
    Ok(out)
}

fn turn_file(row: &Row) -> Result<serde_json::Value, LongError> {
    let unknown = match row_opt(row, "unknown") {
        Some(Value::Integer(n)) => *n,
        Some(Value::Real(n)) => *n as i64,
        _ => return Err(invalid("invalid index row")),
    };
    let path = match row_value(row, "path")? {
        Value::Text(text) => text.clone(),
        _ => return Err(invalid("invalid index row")),
    };
    as_path(&Value::Text(path.clone()))?;
    as_id(&Value::Text(path.clone()))?;
    if unknown > 0 {
        let mut file = serde_json::Map::new();
        file.insert("path".to_owned(), serde_json::Value::String(path));
        file.insert("added".to_owned(), serde_json::Value::Null);
        file.insert("removed".to_owned(), serde_json::Value::Null);
        return Ok(serde_json::Value::Object(file));
    }
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
    let added = added.max(0);
    let removed = removed.max(0);
    as_count(&Value::Integer(added))?;
    as_count(&Value::Integer(removed))?;
    let mut file = serde_json::Map::new();
    file.insert("path".to_owned(), serde_json::Value::String(path));
    file.insert("added".to_owned(), serde_json::Value::Number(added.into()));
    file.insert(
        "removed".to_owned(),
        serde_json::Value::Number(removed.into()),
    );
    Ok(serde_json::Value::Object(file))
}

fn agent_file(row: &Row) -> Result<serde_json::Value, LongError> {
    let unknown = match row_value(row, "unknown")? {
        Value::Integer(n) => *n,
        Value::Real(n) => *n as i64,
        _ => return Err(invalid("invalid index row")),
    };
    let path = match row_value(row, "path")? {
        Value::Text(text) => text.clone(),
        _ => return Err(invalid("invalid index row")),
    };
    as_path(&Value::Text(path.clone()))?;
    as_id(&Value::Text(path.clone()))?;
    if unknown != 0 {
        let mut file = serde_json::Map::new();
        file.insert("path".to_owned(), serde_json::Value::String(path));
        file.insert("added".to_owned(), serde_json::Value::Null);
        file.insert("removed".to_owned(), serde_json::Value::Null);
        return Ok(serde_json::Value::Object(file));
    }
    let added = match row_value(row, "added")? {
        Value::Integer(n) => *n,
        Value::Real(n) => {
            if n.fract() != 0.0 {
                return Err(invalid("invalid index row"));
            }
            *n as i64
        }
        _ => return Err(invalid("invalid index row")),
    };
    let removed = match row_value(row, "removed")? {
        Value::Integer(n) => *n,
        Value::Real(n) => {
            if n.fract() != 0.0 {
                return Err(invalid("invalid index row"));
            }
            *n as i64
        }
        _ => return Err(invalid("invalid index row")),
    };
    as_count(&Value::Integer(added))?;
    as_count(&Value::Integer(removed))?;
    let mut file = serde_json::Map::new();
    file.insert("path".to_owned(), serde_json::Value::String(path));
    file.insert("added".to_owned(), serde_json::Value::Number(added.into()));
    file.insert(
        "removed".to_owned(),
        serde_json::Value::Number(removed.into()),
    );
    Ok(serde_json::Value::Object(file))
}

fn finish_digest(
    mut digest: serde_json::Map<String, serde_json::Value>,
    files: Vec<serde_json::Value>,
    commands: Vec<serde_json::Value>,
) -> Result<serde_json::Value, LongError> {
    let truncated = files.len() > 64 || commands.len() > 64;
    digest.insert(
        "files".to_owned(),
        serde_json::Value::Array(files.into_iter().take(64).collect()),
    );
    digest.insert(
        "commands".to_owned(),
        serde_json::Value::Array(commands.into_iter().take(64).collect()),
    );
    digest.insert("truncated".to_owned(), serde_json::Value::Bool(truncated));
    validate_scalars(&digest)?;
    Ok(serde_json::Value::Object(digest))
}

fn validate_scalars(digest: &serde_json::Map<String, serde_json::Value>) -> Result<(), LongError> {
    for key in [
        "commandsRun",
        "commandsFailed",
        "approvalsAsked",
        "approvalsAnswered",
        "approvalsAutoReviewed",
        "approvalsPending",
        "subagentsStarted",
        "subagentsFinished",
        "errors",
    ] {
        let value = digest
            .get(key)
            .ok_or_else(|| invalid("invalid index row"))?;
        let n = value.as_i64().ok_or_else(|| invalid("invalid index row"))?;
        as_count(&Value::Integer(n))?;
    }
    let tools = digest
        .get("toolCounts")
        .and_then(|tools| tools.as_object())
        .ok_or_else(|| invalid("invalid index row"))?;
    for (kind, value) in tools {
        if !is_tool_kind(kind) {
            return Err(invalid("invalid index row"));
        }
        let n = value.as_i64().ok_or_else(|| invalid("invalid index row"))?;
        as_count(&Value::Integer(n))?;
    }
    for key in ["inputTokens", "outputTokens"] {
        if let Some(value) = digest.get(key)
            && !value.is_null()
        {
            let n = value.as_i64().ok_or_else(|| invalid("invalid index row"))?;
            as_count(&Value::Integer(n))?;
        }
    }
    let files = digest
        .get("files")
        .and_then(|files| files.as_array())
        .ok_or_else(|| invalid("invalid index row"))?;
    if files.len() > 64 {
        return Err(invalid("invalid index row"));
    }
    for file in files {
        let file = file
            .as_object()
            .ok_or_else(|| invalid("invalid index row"))?;
        let path = file
            .get("path")
            .and_then(|path| path.as_str())
            .ok_or_else(|| invalid("invalid index row"))?;
        as_path(&Value::Text(path.to_owned()))?;
        for key in ["added", "removed"] {
            let value = file.get(key).ok_or_else(|| invalid("invalid index row"))?;
            if !value.is_null() {
                let n = value.as_i64().ok_or_else(|| invalid("invalid index row"))?;
                as_count(&Value::Integer(n))?;
            }
        }
    }
    let commands = digest
        .get("commands")
        .and_then(|commands| commands.as_array())
        .ok_or_else(|| invalid("invalid index row"))?;
    if commands.len() > 64 {
        return Err(invalid("invalid index row"));
    }
    Ok(())
}

/// The whole-turn digests of `keys`, with the counters each was built from.
pub fn read_turn_digests(
    conn: &Arc<Connection>,
    keys: &[(String, i64)],
) -> Result<Vec<(serde_json::Value, Counters)>, LongError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let list = serde_json::Value::Array(
        keys.iter()
            .map(|(thread, ordinal)| {
                serde_json::Value::Array(vec![
                    serde_json::Value::String(thread.clone()),
                    serde_json::Value::Number((*ordinal).into()),
                ])
            })
            .collect(),
    );
    let list_text = serde_json::to_string(&list).map_err(|error| invalid(&error.to_string()))?;
    let counts = grouped(
        all_rows(conn, TURN_COUNTS, vec![Value::Text(list_text.clone())])?,
        keys.len(),
    );
    let files = grouped(
        all_rows(conn, TURN_FILES, vec![Value::Text(list_text.clone())])?,
        keys.len(),
    );
    let commands = grouped(
        all_rows(conn, TURN_COMMANDS, vec![Value::Text(list_text)])?,
        keys.len(),
    );
    let mut out = Vec::new();
    for (index, _) in keys.iter().enumerate() {
        let current = counters_from(counts.get(index).map(Vec::as_slice).unwrap_or(&[]))?;
        let mut digest = digest_from_counters(&current);
        let approvals = current.get("approvalsPending").copied().unwrap_or(0).max(0);
        as_count(&Value::Integer(approvals))?;
        digest.insert(
            "approvalsPending".to_owned(),
            serde_json::Value::Number(approvals.into()),
        );
        let token_samples = current.get("tokenSamples").copied().unwrap_or(0);
        if token_samples != 0 {
            let input = current.get("inputTokens").copied().unwrap_or(0).max(0);
            let output = current.get("outputTokens").copied().unwrap_or(0).max(0);
            as_count(&Value::Integer(input))?;
            as_count(&Value::Integer(output))?;
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
        let mut file_values = Vec::new();
        for row in files.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            file_values.push(turn_file(row)?);
        }
        let mut command_values = Vec::new();
        for row in commands.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let data = match row_value(row, "data")? {
                Value::Text(text) => text.clone(),
                _ => return Err(invalid("invalid index row")),
            };
            let parsed = parse_command(&data)?;
            command_values.push(serde_json::Value::Object(parsed));
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
) -> Result<Vec<serde_json::Value>, LongError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let list = serde_json::Value::Array(
        keys.iter()
            .map(|(ordinal, agent)| {
                serde_json::Value::Array(vec![
                    serde_json::Value::Number((*ordinal).into()),
                    serde_json::Value::String(agent.clone()),
                ])
            })
            .collect(),
    );
    let list_text = serde_json::to_string(&list).map_err(|error| invalid(&error.to_string()))?;
    let counts = grouped(
        all_rows(
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
        all_rows(
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
        all_rows(
            conn,
            AGENT_COMMANDS,
            vec![Value::Text(list_text), Value::Text(thread.to_owned())],
        )?,
        keys.len(),
    );
    let mut out = Vec::new();
    for index in 0..keys.len() {
        let current = counters_from(counts.get(index).map(Vec::as_slice).unwrap_or(&[]))?;
        let digest = digest_from_counters(&current);
        let mut file_values = Vec::new();
        for row in files.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            file_values.push(agent_file(row)?);
        }
        let mut command_values = Vec::new();
        for row in commands.get(index).map(Vec::as_slice).unwrap_or(&[]) {
            let data = match row_value(row, "data")? {
                Value::Text(text) => text.clone(),
                _ => return Err(invalid("invalid index row")),
            };
            let parsed = parse_command(&data)?;
            command_values.push(serde_json::Value::Object(parsed));
        }
        out.push(finish_digest(digest, file_values, command_values)?);
    }
    Ok(out)
}

/// Combine bounded summaries, as `@ace/projection` merges them.
pub fn merge_digests(digests: Vec<serde_json::Value>) -> Result<serde_json::Value, LongError> {
    let mut result = empty_digest();
    let mut files: BTreeMap<String, serde_json::Map<String, serde_json::Value>> = BTreeMap::new();
    let mut commands: BTreeMap<String, serde_json::Map<String, serde_json::Value>> =
        BTreeMap::new();
    let mut files_overflow = false;
    let mut commands_overflow = false;
    for digest in &digests {
        let digest = digest
            .as_object()
            .ok_or_else(|| invalid("invalid index row"))?;
        for key in [
            "commandsRun",
            "commandsFailed",
            "approvalsAsked",
            "approvalsAnswered",
            "approvalsAutoReviewed",
            "approvalsPending",
            "subagentsStarted",
            "subagentsFinished",
            "errors",
        ] {
            let add = digest
                .get(key)
                .and_then(|value| value.as_i64())
                .ok_or_else(|| invalid("invalid index row"))?;
            let current = result
                .get(key)
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            result.insert(
                key.to_owned(),
                serde_json::Value::Number((current + add).into()),
            );
        }
        if let Some(tools) = digest.get("toolCounts").and_then(|tools| tools.as_object()) {
            let mut current_tools = result
                .get("toolCounts")
                .and_then(|tools| tools.as_object())
                .cloned()
                .unwrap_or_default();
            for (kind, value) in tools {
                if !is_tool_kind(kind) {
                    continue;
                }
                let add = value.as_i64().ok_or_else(|| invalid("invalid index row"))?;
                let current = current_tools
                    .get(kind)
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                current_tools.insert(
                    kind.clone(),
                    serde_json::Value::Number((current + add).into()),
                );
            }
            result.insert(
                "toolCounts".to_owned(),
                serde_json::Value::Object(current_tools),
            );
        }
        for key in ["inputTokens", "outputTokens"] {
            if let Some(value) = digest.get(key).filter(|value| !value.is_null()) {
                let add = value.as_i64().ok_or_else(|| invalid("invalid index row"))?;
                let current = result
                    .get(key)
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let base = if result.get(key).is_none_or(|value| value.is_null()) {
                    0
                } else {
                    current
                };
                let is_null = result.get(key).is_none_or(|value| value.is_null());
                let _ = is_null;
                result.insert(
                    key.to_owned(),
                    serde_json::Value::Number(
                        (if result.get(key).is_none_or(|v| v.is_null()) {
                            add
                        } else {
                            base + add
                        })
                        .into(),
                    ),
                );
            }
        }
        if result.get("inputTokens").is_none_or(|_v| {
            digests.iter().all(|d| {
                d.as_object()
                    .and_then(|o| o.get("inputTokens"))
                    .is_none_or(|v| v.is_null())
            })
        }) {
            let _ = result;
        }
        if let Some(list) = digest.get("files").and_then(|files| files.as_array()) {
            for file in list {
                let file = file
                    .as_object()
                    .ok_or_else(|| invalid("invalid index row"))?;
                let path = file
                    .get("path")
                    .and_then(|path| path.as_str())
                    .ok_or_else(|| invalid("invalid index row"))?;
                if let Some(previous) = files.get_mut(path) {
                    let added = merge_nullable_count(previous.get("added"), file.get("added"))?;
                    let removed =
                        merge_nullable_count(previous.get("removed"), file.get("removed"))?;
                    previous.insert("added".to_owned(), added);
                    previous.insert("removed".to_owned(), removed);
                } else if files.len() < 64 {
                    files.insert(path.to_owned(), file.clone());
                } else {
                    files_overflow = true;
                }
            }
        }
        if let Some(list) = digest
            .get("commands")
            .and_then(|commands| commands.as_array())
        {
            for command in list {
                let command = command
                    .as_object()
                    .ok_or_else(|| invalid("invalid index row"))?;
                let id = command
                    .get("itemId")
                    .and_then(|id| id.as_str())
                    .ok_or_else(|| invalid("invalid index row"))?;
                if commands.contains_key(id) || commands.len() < 64 {
                    commands.insert(id.to_owned(), command.clone());
                } else {
                    commands_overflow = true;
                }
            }
        }
        if digest
            .get("truncated")
            .and_then(|truncated| truncated.as_bool())
            .unwrap_or(false)
        {
            result.insert("truncated".to_owned(), serde_json::Value::Bool(true));
        }
    }
    let mut file_list: Vec<serde_json::Value> =
        files.into_values().map(serde_json::Value::Object).collect();
    file_list.sort_by(|left, right| {
        let left_path = left
            .as_object()
            .and_then(|file| file.get("path"))
            .and_then(|path| path.as_str())
            .unwrap_or("");
        let right_path = right
            .as_object()
            .and_then(|file| file.get("path"))
            .and_then(|path| path.as_str())
            .unwrap_or("");
        left_path.cmp(right_path)
    });
    let command_list: Vec<serde_json::Value> = commands
        .into_values()
        .map(serde_json::Value::Object)
        .collect();
    result.insert("files".to_owned(), serde_json::Value::Array(file_list));
    result.insert(
        "commands".to_owned(),
        serde_json::Value::Array(command_list),
    );
    if files_overflow || commands_overflow {
        result.insert("truncated".to_owned(), serde_json::Value::Bool(true));
    }
    // Input and output stay null when every share has none.
    for key in ["inputTokens", "outputTokens"] {
        let every_null = digests.iter().all(|digest| {
            digest
                .as_object()
                .and_then(|digest| digest.get(key))
                .is_none_or(|value| value.is_null())
        });
        if every_null {
            result.insert(key.to_owned(), serde_json::Value::Null);
        }
    }
    Ok(serde_json::Value::Object(result))
}

fn merge_nullable_count(
    left: Option<&serde_json::Value>,
    right: Option<&serde_json::Value>,
) -> Result<serde_json::Value, LongError> {
    let left_null = left.is_none_or(|value| value.is_null());
    let right_null = right.is_none_or(|value| value.is_null());
    if left_null || right_null {
        return Ok(serde_json::Value::Null);
    }
    let left_n = left
        .and_then(|value| value.as_i64())
        .ok_or_else(|| invalid("invalid index row"))?;
    let right_n = right
        .and_then(|value| value.as_i64())
        .ok_or_else(|| invalid("invalid index row"))?;
    Ok(serde_json::Value::Number((left_n + right_n).into()))
}

pub fn empty_counters() -> Counters {
    Counters::new()
}

pub fn digest_counts(
    conn: &Arc<Connection>,
    thread: &str,
    ordinal: i64,
) -> Result<Counters, LongError> {
    let rows = all_rows(
        conn,
        "SELECT key,value FROM long_counts WHERE thread_id=? AND ordinal=?",
        vec![Value::Text(thread.to_owned()), Value::Integer(ordinal)],
    )?;
    counters_from(&rows)
}

pub fn check_ordinal(value: &Value) -> Result<i64, LongError> {
    as_ordinal(value)
}

pub(crate) fn empty_digest_for_merge() -> serde_json::Map<String, serde_json::Value> {
    empty_digest()
}

pub(crate) fn parse_command_pub(
    data: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, LongError> {
    parse_command(data)
}

pub(crate) fn validate_digest_pub(
    digest: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), LongError> {
    validate_scalars(digest)
}
