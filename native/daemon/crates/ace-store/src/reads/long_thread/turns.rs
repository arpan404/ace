// SPDX-License-Identifier: Apache-2.0
//! `turnsPage`, as `long-thread/reader.ts` reads it.

use super::common::{
    LongError, Row, all_rows, as_count, as_id, as_ordinal, as_preview, as_text, as_timestamp,
    get_row, invalid, js_len, json_bytes, row_opt, row_value,
};
use super::digests::{Counters, digest_counts, read_agent_digests, read_turn_digests};
use super::status::{
    agent_thread_status, parse_agent_status, parse_thread_status, turn_activity_status,
    turn_is_settled,
};
use crate::{Connection, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

struct TurnRow {
    ordinal: i64,
    start_seq: i64,
    end_seq: i64,
    started_at: i64,
    ended_at: Option<i64>,
    root_outcome: String,
    settled_seq: Option<i64>,
    initiating: String,
    latest: String,
}

fn parse_turn_row(row: &Row) -> Result<TurnRow, LongError> {
    let ordinal = as_ordinal(row_value(row, "ordinal")?)?;
    let start_seq = as_count(row_value(row, "start_seq")?)?;
    let end_seq = as_count(row_value(row, "end_seq")?)?;
    let started_at = as_timestamp(row_value(row, "started_at")?)?;
    let ended_at = match row_opt(row, "ended_at") {
        None | Some(Value::Null) => None,
        Some(value) => Some(as_timestamp(value)?),
    };
    let root_outcome = match row_value(row, "root_outcome")? {
        Value::Text(text) => text.clone(),
        _ => return Err(invalid("invalid index row")),
    };
    if !matches!(
        root_outcome.as_str(),
        "active" | "completed" | "interrupted" | "failed"
    ) {
        return Err(invalid("invalid index row"));
    }
    let settled_seq = match row_opt(row, "settled_seq") {
        None | Some(Value::Null) => None,
        Some(Value::Integer(n)) => Some(*n),
        Some(Value::Real(n)) => Some(*n as i64),
        Some(_) => return Err(invalid("invalid index row")),
    };
    let initiating = as_preview(row_value(row, "initiating")?)?.to_owned();
    let latest = as_preview(row_value(row, "latest")?)?.to_owned();
    Ok(TurnRow {
        ordinal,
        start_seq,
        end_seq,
        started_at,
        ended_at,
        root_outcome,
        settled_seq,
        initiating,
        latest,
    })
}

fn thread_status_row(
    conn: &Arc<Connection>,
    thread_id: &str,
) -> Result<Option<serde_json::Value>, LongError> {
    let row = get_row(
        conn,
        "SELECT status FROM threads WHERE id=?",
        vec![Value::Text(thread_id.to_owned())],
    )?;
    if let Some(row) = row {
        let text = as_text(row_value(&row, "status")?)?;
        return Ok(Some(parse_thread_status(text)?));
    }
    Ok(None)
}

type HeadRow = (Option<i64>, Option<String>, Option<String>);

fn head_row(conn: &Arc<Connection>, thread_id: &str) -> Result<HeadRow, LongError> {
    let row = get_row(
        conn,
        "SELECT ordinal,root,status FROM long_heads WHERE thread_id=?",
        vec![Value::Text(thread_id.to_owned())],
    )?;
    if let Some(row) = row {
        let ordinal = match row_opt(&row, "ordinal") {
            None | Some(Value::Null) => None,
            Some(value) => Some(as_ordinal(value)?),
        };
        let root = match row_opt(&row, "root") {
            None | Some(Value::Null) => None,
            Some(Value::Text(text)) => {
                if text.is_empty() {
                    None
                } else {
                    Some(text.clone())
                }
            }
            Some(_) => return Err(invalid("invalid index row")),
        };
        let status = match row_opt(&row, "status") {
            None | Some(Value::Null) => None,
            Some(Value::Text(text)) => Some(text.clone()),
            Some(_) => return Err(invalid("invalid index row")),
        };
        return Ok((ordinal, root, status));
    }
    Ok((None, None, None))
}

fn linked_status(
    conn: &Arc<Connection>,
    thread: &str,
    ordinal: i64,
) -> Result<Option<serde_json::Value>, LongError> {
    let row = get_row(
        conn,
        "SELECT t.status AS status FROM long_agents a JOIN threads t ON t.id=a.child_thread WHERE a.thread_id=? AND a.ordinal=? AND json_extract(t.status,'$.state')='working' AND json_extract(t.client,'$.deletedAt') IS NULL ORDER BY CASE json_extract(t.status,'$.state') WHEN 'needs_you' THEN 0 WHEN 'working' THEN 1 WHEN 'limited' THEN 2 WHEN 'waiting' THEN CASE json_extract(t.status,'$.on') WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 WHEN 'background_task' THEN 5 ELSE 7 END ELSE 6 END LIMIT 1",
        vec![Value::Text(thread.to_owned()), Value::Integer(ordinal)],
    )?;
    if let Some(row) = row {
        let text = as_text(row_value(&row, "status")?)?;
        return Ok(Some(parse_thread_status(text)?));
    }
    Ok(None)
}

fn owned_status(
    conn: &Arc<Connection>,
    thread: &str,
    ordinal: i64,
) -> Result<Option<serde_json::Value>, LongError> {
    let row = get_row(
        conn,
        "SELECT status FROM long_agents WHERE thread_id=? AND ordinal=? AND completion_relevant=1 AND json_extract(status,'$.state') NOT IN ('idle','interrupted','failed') ORDER BY CASE json_extract(status,'$.state') WHEN 'blocked' THEN CASE json_extract(status,'$.on') WHEN 'human' THEN 0 WHEN 'subagents' THEN 1 WHEN 'rate_limit' THEN 2 WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 ELSE 5 END WHEN 'unresponsive' THEN 6 ELSE 1 END LIMIT 1",
        vec![Value::Text(thread.to_owned()), Value::Integer(ordinal)],
    )?;
    if let Some(row) = row {
        let text = as_text(row_value(&row, "status")?)?;
        let agent = parse_agent_status(text)?;
        return Ok(Some(agent_thread_status(&agent)?));
    }
    Ok(None)
}

fn turn_status(
    conn: &Arc<Connection>,
    thread: &str,
    row: &TurnRow,
    head_ordinal: Option<i64>,
    head_status_text: Option<&str>,
    thread_status: Option<&serde_json::Value>,
    counters: &Counters,
) -> Result<serde_json::Value, LongError> {
    if head_ordinal == Some(row.ordinal) {
        let status = if let Some(status) = thread_status.cloned() {
            status
        } else if let Some(text) = head_status_text {
            parse_thread_status(text)?
        } else {
            return Err(invalid("Missing turn digest"));
        };
        if !turn_is_settled(&status)
            || status
                .as_object()
                .and_then(|object| object.get("state"))
                .and_then(|state| state.as_str())
                == Some("failed")
        {
            return Ok(status);
        }
    }
    let mut candidates = Vec::new();
    if let Some(linked) = linked_status(conn, thread, row.ordinal)? {
        candidates.push(linked);
    }
    if let Some(owned) = owned_status(conn, thread, row.ordinal)? {
        candidates.push(owned);
    }
    if let Some(active) = turn_activity_status(counters, &candidates) {
        return Ok(active);
    }
    if row.settled_seq.is_none() {
        let mut out = serde_json::Map::new();
        out.insert(
            "state".to_owned(),
            serde_json::Value::String("working".to_owned()),
        );
        out.insert("agents".to_owned(), serde_json::Value::Number(1.into()));
        return Ok(serde_json::Value::Object(out));
    }
    let mut out = serde_json::Map::new();
    if row.root_outcome == "failed" {
        out.insert(
            "state".to_owned(),
            serde_json::Value::String("failed".to_owned()),
        );
    } else {
        out.insert(
            "state".to_owned(),
            serde_json::Value::String("done".to_owned()),
        );
    }
    Ok(serde_json::Value::Object(out))
}

fn agent_summary(
    conn: &Arc<Connection>,
    thread: &str,
    row: &TurnRow,
    agent: &Row,
    child_digest: Option<serde_json::Value>,
    agent_digest: Option<serde_json::Value>,
) -> Result<serde_json::Value, LongError> {
    let id = as_id(row_value(agent, "id")?)?.to_owned();
    let child_thread = match row_opt(agent, "child_thread") {
        None | Some(Value::Null) => None,
        Some(Value::Text(text)) => {
            if text.is_empty() {
                None
            } else {
                Some(text.clone())
            }
        }
        Some(_) => return Err(invalid("invalid index row")),
    };
    let name = match row_opt(agent, "name") {
        None | Some(Value::Null) => None,
        Some(Value::Text(text)) => {
            if text.is_empty() {
                return Err(invalid("invalid index row"));
            }
            if js_len(text) > 1024 {
                return Err(invalid("invalid index row"));
            }
            Some(text.clone())
        }
        Some(_) => return Err(invalid("invalid index row")),
    };
    let status_text = as_text(row_value(agent, "status")?)?;
    let started_at = as_timestamp(row_value(agent, "started_at")?)?;
    let ended_at = match row_opt(agent, "ended_at") {
        None | Some(Value::Null) => None,
        Some(value) => Some(as_timestamp(value)?),
    };
    let digest = if child_thread.is_some() {
        child_digest.ok_or_else(|| invalid("Missing turn digest"))?
    } else {
        agent_digest.ok_or_else(|| invalid("Missing turn digest"))?
    };
    let status = if let Some(child) = child_thread.clone() {
        if let Some(status) = thread_status_row(conn, &child)? {
            status
        } else {
            let agent_status = parse_agent_status(status_text)?;
            agent_thread_status(&agent_status)?
        }
    } else {
        let agent_status = parse_agent_status(status_text)?;
        agent_thread_status(&agent_status)?
    };
    let _ = (thread, row);
    let mut out = serde_json::Map::new();
    out.insert("agentId".to_owned(), serde_json::Value::String(id));
    if let Some(child) = child_thread {
        // Only a live child keeps its thread; a deleted one reads as its agent's share.
        if thread_status_row(conn, &child)?.is_some() {
            out.insert("threadId".to_owned(), serde_json::Value::String(child));
        }
    }
    if let Some(name) = name {
        out.insert("name".to_owned(), serde_json::Value::String(name));
    }
    out.insert("status".to_owned(), status);
    out.insert(
        "startedAt".to_owned(),
        serde_json::Value::Number(started_at.into()),
    );
    if let Some(ended) = ended_at {
        out.insert(
            "endedAt".to_owned(),
            serde_json::Value::Number(ended.into()),
        );
    }
    out.insert("digest".to_owned(), digest);
    Ok(serde_json::Value::Object(out))
}

#[allow(clippy::too_many_arguments)]
pub fn turns_page(
    conn: &Arc<Connection>,
    thread_id: &str,
    before: Option<i64>,
    after: Option<i64>,
    limit: i64,
    request_id: &str,
    head_seq: i64,
) -> Result<String, LongError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("invalid index row"));
    }
    let rows = if after.is_none() {
        let cursor = before.unwrap_or(9007199254740991);
        all_rows(
            conn,
            "SELECT * FROM long_turns WHERE thread_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?",
            vec![
                Value::Text(thread_id.to_owned()),
                Value::Integer(cursor),
                Value::Integer(limit),
            ],
        )?
    } else {
        let cursor = after.unwrap_or(0);
        all_rows(
            conn,
            "SELECT * FROM long_turns WHERE thread_id=? AND ordinal>? ORDER BY ordinal LIMIT ?",
            vec![
                Value::Text(thread_id.to_owned()),
                Value::Integer(cursor),
                Value::Integer(limit),
            ],
        )?
    };
    let mut parsed = Vec::new();
    for row in &rows {
        parsed.push(parse_turn_row(row)?);
    }
    let (head_ordinal, root, head_status_text) = head_row(conn, thread_id)?;
    let thread_status = thread_status_row(conn, thread_id)?;
    let ordinals: Vec<serde_json::Value> = parsed
        .iter()
        .map(|row| serde_json::Value::Number(row.ordinal.into()))
        .collect();
    let ordinals_text = serde_json::to_string(&serde_json::Value::Array(ordinals))
        .map_err(|error| invalid(&error.to_string()))?;
    let root_param = root.clone().unwrap_or_default();
    let agent_rows = all_rows(
        conn,
        "SELECT j.key AS k, a.* FROM json_each(?) j CROSS JOIN long_agents a WHERE a.rowid IN (SELECT rowid FROM long_agents WHERE thread_id=? AND ordinal=j.value AND id<>? ORDER BY id LIMIT 33) ORDER BY j.key, a.id",
        vec![
            Value::Text(ordinals_text),
            Value::Text(thread_id.to_owned()),
            Value::Text(root_param),
        ],
    )?;
    let mut agents: Vec<Vec<Row>> = Vec::new();
    for _ in 0..parsed.len() {
        agents.push(Vec::new());
    }
    for row in agent_rows {
        let key = match row.get("k") {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => continue,
        };
        if let Some(group) = agents.get_mut(key as usize) {
            group.push(row);
        }
    }
    let turn_keys: Vec<(String, i64)> = parsed
        .iter()
        .map(|row| (thread_id.to_owned(), row.ordinal))
        .collect();
    let mut agent_keys: Vec<(i64, String)> = Vec::new();
    let mut mains: Vec<Option<usize>> = Vec::new();
    for row in parsed.iter() {
        let main = if root.is_none() {
            None
        } else {
            let at = agent_keys.len();
            if let Some(root_id) = root.clone() {
                agent_keys.push((row.ordinal, root_id));
                Some(at)
            } else {
                None
            }
        };
        mains.push(main);
    }
    // Build the full key lists in the order `reader.ts` does: each turn, then each
    // agent share, then each live child's whole thread.
    let mut full_turn_keys = turn_keys.clone();
    let mut full_agent_keys = agent_keys.clone();
    let mut subagent_kinds: Vec<Vec<bool>> = Vec::new();
    for (index, row) in parsed.iter().enumerate() {
        let mut kinds = Vec::new();
        if let Some(group) = agents.get(index) {
            for agent in group.iter().take(32) {
                let child = match agent.get("child_thread") {
                    Some(Value::Text(text)) if !text.is_empty() => Some(text.clone()),
                    _ => None,
                };
                if let Some(child_id) = child {
                    let live = thread_status_row(conn, &child_id)?.is_some();
                    if live {
                        full_turn_keys.push((child_id, 0));
                        kinds.push(true);
                    } else {
                        let agent_id = as_id(row_value(agent, "id")?)?.to_owned();
                        full_agent_keys.push((row.ordinal, agent_id));
                        kinds.push(false);
                    }
                } else {
                    let agent_id = as_id(row_value(agent, "id")?)?.to_owned();
                    full_agent_keys.push((row.ordinal, agent_id));
                    kinds.push(false);
                }
            }
        }
        subagent_kinds.push(kinds);
    }
    let turn_digests = read_turn_digests(conn, &full_turn_keys)?;
    let agent_digests = read_agent_digests(conn, thread_id, &full_agent_keys)?;
    let mut summaries = Vec::new();
    let mut agent_cursor = agent_keys.len();
    let mut turn_cursor = turn_keys.len();
    // Re-walk in order, consuming the digests built above.
    for (index, row) in parsed.iter().enumerate() {
        let (own_digest, own_counters) = turn_digests
            .get(index)
            .cloned()
            .ok_or_else(|| invalid("Missing turn digest"))?;
        let own_counters: Counters = own_counters;
        let agent_count = subagent_kinds.get(index).map_or(0, |kinds| kinds.len());
        let _ = agent_count;
        let mut subagents_json = Vec::new();
        if let Some(group) = agents.get(index) {
            let kinds = subagent_kinds.get(index).cloned().unwrap_or_default();
            for (agent_index, agent) in group.iter().take(32).enumerate() {
                let is_turn = kinds.get(agent_index).copied().unwrap_or(false);
                let digest = if is_turn {
                    let digest = turn_digests
                        .get(turn_cursor)
                        .cloned()
                        .map(|(digest, _)| digest)
                        .ok_or_else(|| invalid("Missing turn digest"))?;
                    turn_cursor += 1;
                    digest
                } else {
                    let digest = agent_digests
                        .get(agent_cursor)
                        .cloned()
                        .ok_or_else(|| invalid("Missing turn digest"))?;
                    agent_cursor += 1;
                    digest
                };
                let child = match agent.get("child_thread") {
                    Some(Value::Text(text)) if !text.is_empty() => Some(text.clone()),
                    _ => None,
                };
                let live_child = if let Some(child_id) = child.clone() {
                    thread_status_row(conn, &child_id)?.is_some()
                } else {
                    false
                };
                let summary = agent_summary(
                    conn,
                    thread_id,
                    row,
                    agent,
                    if live_child {
                        Some(digest.clone())
                    } else {
                        None
                    },
                    if live_child { None } else { Some(digest) },
                )?;
                // A deleted child reads as its agent's share, without a thread id.
                let mut summary_object = summary
                    .as_object()
                    .cloned()
                    .ok_or_else(|| invalid("Missing turn digest"))?;
                if !live_child {
                    summary_object.remove("threadId");
                }
                subagents_json.push(serde_json::Value::Object(summary_object));
            }
        }
        let status = turn_status(
            conn,
            thread_id,
            row,
            head_ordinal,
            head_status_text.as_deref(),
            thread_status.as_ref(),
            &own_counters,
        )?;
        let mut summary = serde_json::Map::new();
        summary.insert(
            "threadId".to_owned(),
            serde_json::Value::String(thread_id.to_owned()),
        );
        summary.insert(
            "ordinal".to_owned(),
            serde_json::Value::Number(row.ordinal.into()),
        );
        summary.insert(
            "startSeq".to_owned(),
            serde_json::Value::Number(row.start_seq.into()),
        );
        summary.insert(
            "endSeq".to_owned(),
            serde_json::Value::Number(row.end_seq.into()),
        );
        summary.insert(
            "startedAt".to_owned(),
            serde_json::Value::Number(row.started_at.into()),
        );
        if let Some(ended) = row.ended_at {
            summary.insert(
                "endedAt".to_owned(),
                serde_json::Value::Number(ended.into()),
            );
        }
        summary.insert("status".to_owned(), status);
        summary.insert(
            "outcome".to_owned(),
            serde_json::Value::String(row.root_outcome.clone()),
        );
        summary.insert(
            "initiatingMessagePreview".to_owned(),
            serde_json::Value::String(row.initiating.clone()),
        );
        summary.insert(
            "latestAgentMessagePreview".to_owned(),
            serde_json::Value::String(row.latest.clone()),
        );
        summary.insert("digest".to_owned(), own_digest);
        if let Some(main_at) = mains.get(index).copied().flatten() {
            let digest = agent_digests
                .get(main_at)
                .cloned()
                .ok_or_else(|| invalid("Missing turn digest"))?;
            let root_id = root.clone().ok_or_else(|| invalid("Missing turn digest"))?;
            let mut main = serde_json::Map::new();
            main.insert("agentId".to_owned(), serde_json::Value::String(root_id));
            main.insert("digest".to_owned(), digest);
            summary.insert("main".to_owned(), serde_json::Value::Object(main));
        }
        summary.insert(
            "subagents".to_owned(),
            serde_json::Value::Array(subagents_json),
        );
        let truncated = agents.get(index).is_some_and(|group| group.len() > 32);
        summary.insert(
            "subagentsTruncated".to_owned(),
            serde_json::Value::Bool(truncated),
        );
        summaries.push(summary);
    }
    let mut turns: Vec<serde_json::Value> = Vec::new();
    let mut bytes = 1024usize;
    for summary in summaries {
        let mut sized = serde_json::Value::Object(summary);
        let mut size = json_bytes(&sized)?;
        if size > 1024 * 1024 - 1024 {
            {
                if let Some(object) = sized.as_object_mut() {
                    for key in ["main", "subagents"] {
                        if let Some(value) = object.get_mut(key) {
                            strip_digest_details(value);
                        }
                    }
                }
            }
            size = json_bytes(&sized)?;
            if size > 1024 * 1024 - 1024 {
                {
                    if let Some(object) = sized.as_object_mut()
                        && let Some(digest) = object.get_mut("digest")
                    {
                        strip_digest_details(digest);
                    }
                }
                size = json_bytes(&sized)?;
            }
        }
        if bytes + size > 1024 * 1024 && !turns.is_empty() {
            break;
        }
        turns.push(sized);
        bytes += size;
    }
    if after.is_none() {
        turns.reverse();
    }
    let first = turns
        .first()
        .and_then(|turn| turn.get("ordinal"))
        .and_then(|ordinal| ordinal.as_i64());
    let last = turns
        .last()
        .and_then(|turn| turn.get("ordinal"))
        .and_then(|ordinal| ordinal.as_i64());
    let before_cursor = if let Some(first) = first {
        let exists = get_row(
            conn,
            "SELECT 1 FROM long_turns WHERE thread_id=? AND ordinal<? LIMIT 1",
            vec![Value::Text(thread_id.to_owned()), Value::Integer(first)],
        )?;
        if exists.is_some() { Some(first) } else { None }
    } else {
        None
    };
    let after_cursor = if let Some(last) = last {
        let exists = get_row(
            conn,
            "SELECT 1 FROM long_turns WHERE thread_id=? AND ordinal>? LIMIT 1",
            vec![Value::Text(thread_id.to_owned()), Value::Integer(last)],
        )?;
        if exists.is_some() { Some(last) } else { None }
    } else {
        None
    };
    let indexed = digest_indexed_seq(conn)?;
    as_count(&Value::Integer(indexed))?;
    as_count(&Value::Integer(head_seq))?;
    let mut response = serde_json::Map::new();
    response.insert(
        "type".to_owned(),
        serde_json::Value::String("turns.page".to_owned()),
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
    response.insert("turns".to_owned(), serde_json::Value::Array(turns));
    response.insert(
        "before".to_owned(),
        before_cursor.map_or(serde_json::Value::Null, |cursor| {
            serde_json::Value::Number(cursor.into())
        }),
    );
    response.insert(
        "after".to_owned(),
        after_cursor.map_or(serde_json::Value::Null, |cursor| {
            serde_json::Value::Number(cursor.into())
        }),
    );
    let text = serde_json::to_string(&serde_json::Value::Object(response))
        .map_err(|error| invalid(&error.to_string()))?;
    Ok(text)
}

fn strip_digest_details(value: &mut serde_json::Value) {
    if let Some(digest) = value.get_mut("digest") {
        if let Some(object) = digest.as_object_mut() {
            let files_empty = object
                .get("files")
                .and_then(|files| files.as_array())
                .is_none_or(|files| files.is_empty());
            let commands_empty = object
                .get("commands")
                .and_then(|commands| commands.as_array())
                .is_none_or(|commands| commands.is_empty());
            let truncated = object
                .get("truncated")
                .and_then(|truncated| truncated.as_bool())
                .unwrap_or(false)
                || !files_empty
                || !commands_empty;
            object.insert("files".to_owned(), serde_json::Value::Array(Vec::new()));
            object.insert("commands".to_owned(), serde_json::Value::Array(Vec::new()));
            object.insert("truncated".to_owned(), serde_json::Value::Bool(truncated));
        }
        return;
    }
    if let Some(subagents) = value.get_mut("subagents") {
        if let Some(list) = subagents.as_array_mut() {
            for subagent in list {
                strip_digest_details(subagent);
            }
        }
        return;
    }
    if let Some(object) = value.as_object_mut()
        && (object.contains_key("files") || object.contains_key("commands"))
    {
        let files_empty = object
            .get("files")
            .and_then(|files| files.as_array())
            .is_none_or(|files| files.is_empty());
        let commands_empty = object
            .get("commands")
            .and_then(|commands| commands.as_array())
            .is_none_or(|commands| commands.is_empty());
        let truncated = object
            .get("truncated")
            .and_then(|truncated| truncated.as_bool())
            .unwrap_or(false)
            || !files_empty
            || !commands_empty;
        object.insert("files".to_owned(), serde_json::Value::Array(Vec::new()));
        object.insert("commands".to_owned(), serde_json::Value::Array(Vec::new()));
        object.insert("truncated".to_owned(), serde_json::Value::Bool(truncated));
    }
}

pub fn digest_indexed_seq(conn: &Arc<Connection>) -> Result<i64, LongError> {
    let stage = get_row(
        conn,
        "SELECT stage FROM long_range_migration WHERE id=1",
        Vec::new(),
    )?;
    let stage = match stage.as_ref().and_then(|row| row.get("stage")) {
        Some(Value::Integer(n)) => *n,
        Some(Value::Real(n)) => *n as i64,
        _ => return Ok(0),
    };
    if stage != 6 {
        return Ok(0);
    }
    let seq = get_row(conn, "SELECT seq FROM long_meta WHERE id=1", Vec::new())?;
    match seq.as_ref().and_then(|row| row.get("seq")) {
        Some(Value::Integer(n)) => Ok(*n),
        Some(Value::Real(n)) => Ok(*n as i64),
        _ => Ok(0),
    }
}

pub fn check_counts(counters: &BTreeMap<String, i64>) -> Result<(), LongError> {
    for (key, value) in counters {
        if key == "tokenSamples" {
            continue;
        }
        let _ = as_count(&Value::Integer(*value))?;
    }
    Ok(())
}

pub fn unused_helpers() -> Result<(), LongError> {
    let _ = digest_counts;
    let _ = check_counts;
    Ok(())
}
