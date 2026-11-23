// SPDX-License-Identifier: Apache-2.0
//! A turns page's agent shares and thread statuses.
//!
//! Linked and owned statuses are read exactly as the loader reads them: one
//! `ORDER BY` + `LIMIT 1` row per turn, in the SQL's row order, validated only
//! once chosen. Agent rows arrive as cells in the `SELECT` list's order and
//! validate as they are read.

use super::super::common::{
    LongError, all_rows_raw, check_count, check_timestamp, get_row_raw, invalid, js_len,
};
use super::super::row::{int_at, ints_json, opt_int_at, opt_text_at, text_at};
use super::super::status::{Status, parse_thread_status};
use crate::{Connection, Value};
use std::sync::Arc;

/// One `long_agents` row the page shows, validated as it is read.
pub struct AgentRow {
    pub id: String,
    pub child_thread: Option<String>,
    pub name: Option<String>,
    pub status_text: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

fn parse_agent_row(row: &[Value]) -> Result<AgentRow, LongError> {
    let id = text_at(row, 0)?;
    if id.is_empty() {
        return Err(invalid("invalid index row"));
    }
    let child_thread = match opt_text_at(row, 1)? {
        None | Some("") => None,
        Some(child) => Some(child.to_owned()),
    };
    let name = match opt_text_at(row, 2)? {
        None => None,
        Some(name) => {
            if js_len(name) > 1024 {
                return Err(invalid("invalid index row"));
            }
            Some(name.to_owned())
        }
    };
    let status_text = text_at(row, 3)?.to_owned();
    let started_at = check_timestamp(int_at(row, 4)?)?;
    let ended_at = match opt_int_at(row, 5)? {
        None => None,
        Some(ended) => Some(check_timestamp(ended)?),
    };
    Ok(AgentRow {
        id: id.to_owned(),
        child_thread,
        name,
        status_text,
        started_at,
        ended_at,
    })
}

/// The page's `long_agents` rows, grouped by the page's turn order.
pub fn page_agents(
    conn: &Arc<Connection>,
    thread_id: &str,
    ordinals: &[i64],
    root: &str,
) -> Result<Vec<Vec<AgentRow>>, LongError> {
    let mut agents: Vec<Vec<AgentRow>> = Vec::new();
    agents.resize_with(ordinals.len(), Vec::new);
    if ordinals.is_empty() {
        return Ok(agents);
    }
    let ordinals_text = ints_json(ordinals);
    let rows = all_rows_raw(
        conn,
        "SELECT j.key AS k, a.id, a.child_thread, a.name, a.status, a.started_at, a.ended_at FROM json_each(?) j CROSS JOIN long_agents a WHERE a.rowid IN (SELECT rowid FROM long_agents WHERE thread_id=? AND ordinal=j.value AND id<>? ORDER BY id LIMIT 33) ORDER BY j.key, a.id",
        vec![
            Value::Text(ordinals_text),
            Value::Text(thread_id.to_owned()),
            Value::Text(root.to_owned()),
        ],
    )?;
    for row in rows {
        let key = int_at(&row, 0)?;
        let cells = row.get(1..).ok_or_else(|| invalid("invalid index row"))?;
        if key >= 0
            && let Some(group) = agents.get_mut(key as usize)
        {
            group.push(parse_agent_row(cells)?);
        }
    }
    Ok(agents)
}

/// The live thread's own status, when the threads table holds it.
pub fn thread_status_row(
    conn: &Arc<Connection>,
    thread_id: &str,
) -> Result<Option<Status>, LongError> {
    let row = crate::stmt_cache::get_row_raw(
        conn,
        "SELECT status FROM threads WHERE id=?",
        vec![Value::Text(thread_id.to_owned())],
    )?;
    match row {
        None => Ok(None),
        Some(row) => {
            let text = text_at(&row, 0)?;
            Ok(Some(parse_thread_status(text)?))
        }
    }
}

/// The page's `long_heads` row: head ordinal, root agent and stored status.
/// The page's `long_heads` row: head ordinal, root agent and stored status.
pub type HeadRow = (Option<i64>, Option<String>, Option<String>);

pub fn head_row(conn: &Arc<Connection>, thread_id: &str) -> Result<HeadRow, LongError> {
    let row = crate::stmt_cache::get_row_raw(
        conn,
        "SELECT ordinal,root,status FROM long_heads WHERE thread_id=?",
        vec![Value::Text(thread_id.to_owned())],
    )?;
    let Some(row) = row else {
        return Ok((None, None, None));
    };
    let ordinal = match opt_int_at(&row, 0)? {
        None => None,
        Some(ordinal) => Some(check_count(ordinal)?),
    };
    let root = match opt_text_at(&row, 1)? {
        None | Some("") => None,
        Some(root) => Some(root.to_owned()),
    };
    let status = opt_text_at(&row, 2)?.map(|status| status.to_owned());
    Ok((ordinal, root, status))
}

/// The best linked status per turn ordinal, exactly as the loader reads it:
/// one `ORDER BY` + `LIMIT 1` row per turn, validated only once chosen, so an
/// invalid chosen row fails the read instead of falling through to another.
pub fn linked_statuses(
    conn: &Arc<Connection>,
    thread: &str,
    ordinals: &[i64],
) -> Result<Vec<(i64, Status)>, LongError> {
    if ordinals.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for ordinal in ordinals {
        let row = get_row_raw(
            conn,
            "SELECT t.status FROM long_agents a JOIN threads t ON t.id=a.child_thread WHERE a.thread_id=? AND a.ordinal=? AND json_extract(t.status,'$.state')='working' AND json_extract(t.client,'$.deletedAt') IS NULL ORDER BY CASE json_extract(t.status,'$.state') WHEN 'needs_you' THEN 0 WHEN 'working' THEN 1 WHEN 'limited' THEN 2 WHEN 'waiting' THEN CASE json_extract(t.status,'$.on') WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 WHEN 'background_task' THEN 5 ELSE 7 END ELSE 6 END LIMIT 1",
            vec![Value::Text(thread.to_owned()), Value::Integer(*ordinal)],
        )?;
        if let Some(row) = row {
            let text = text_at(&row, 0)?;
            out.push((*ordinal, parse_thread_status(text)?));
        }
    }
    Ok(out)
}

/// The best owned status per turn ordinal, exactly as the loader reads it:
/// one `ORDER BY` + `LIMIT 1` row per turn, validated only once chosen, so an
/// invalid chosen row fails the read instead of falling through to another.
pub fn owned_statuses(
    conn: &Arc<Connection>,
    thread: &str,
    ordinals: &[i64],
) -> Result<Vec<(i64, Status)>, LongError> {
    if ordinals.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for ordinal in ordinals {
        let row = get_row_raw(
            conn,
            "SELECT status FROM long_agents WHERE thread_id=? AND ordinal=? AND completion_relevant=1 AND json_extract(status,'$.state') NOT IN ('idle','interrupted','failed') ORDER BY CASE json_extract(status,'$.state') WHEN 'blocked' THEN CASE json_extract(status,'$.on') WHEN 'human' THEN 0 WHEN 'subagents' THEN 1 WHEN 'rate_limit' THEN 2 WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 ELSE 5 END WHEN 'unresponsive' THEN 6 ELSE 1 END LIMIT 1",
            vec![Value::Text(thread.to_owned()), Value::Integer(*ordinal)],
        )?;
        if let Some(row) = row {
            let text = text_at(&row, 0)?;
            out.push((*ordinal, super::super::status::agent_thread_status(text)?));
        }
    }
    Ok(out)
}

/// The live threads of the page's subagents, with their validated statuses.
/// Soft-deleted child threads are not live: the loader's `getThread` filters
/// them, so the page shows the parent's recorded agent status and share.
pub fn child_statuses(
    conn: &Arc<Connection>,
    child_ids: &[String],
) -> Result<Vec<(String, Status)>, LongError> {
    let mut out = Vec::new();
    if child_ids.is_empty() {
        return Ok(out);
    }
    let list = super::super::row::strs_json(child_ids)?;
    let rows = all_rows_raw(
        conn,
        "SELECT id,status FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(client,'$.deletedAt') IS NULL",
        vec![Value::Text(list)],
    )?;
    for row in rows {
        let id = text_at(&row, 0)?.to_owned();
        let text = text_at(&row, 1)?;
        match parse_thread_status(text) {
            Ok(status) => out.push((id, status)),
            Err(_) => return Err(invalid("invalid index row")),
        }
    }
    Ok(out)
}
