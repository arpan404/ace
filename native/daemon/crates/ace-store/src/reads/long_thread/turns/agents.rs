// SPDX-License-Identifier: Apache-2.0
//! A turns page's agent shares and thread statuses.
//!
//! Linked and owned statuses are read for the whole page at once, one statement
//! each, and the best status per turn wins by the loader's rank. Agent rows
//! arrive as cells in the `SELECT` list's order and validate as they are read.

use super::super::common::{
    LongError, all_rows_raw, check_count, check_timestamp, invalid, js_len,
};
use super::super::row::{int_at, ints_json, opt_int_at, opt_text_at, text_at};
use super::super::status::{Status, linked_rank, owned_rank, parse_thread_status};
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

/// The best linked status per turn ordinal, by the loader's rank.
pub fn linked_statuses(
    conn: &Arc<Connection>,
    thread: &str,
    ordinals: &[i64],
) -> Result<Vec<(i64, Status)>, LongError> {
    if ordinals.is_empty() {
        return Ok(Vec::new());
    }
    let list = ints_json(ordinals);
    let rows = all_rows_raw(
        conn,
        "SELECT a.ordinal AS ordinal,t.status AS status FROM long_agents a JOIN threads t ON t.id=a.child_thread WHERE a.thread_id=? AND a.ordinal IN (SELECT value FROM json_each(?)) AND json_extract(t.status,'$.state')='working' AND json_extract(t.client,'$.deletedAt') IS NULL",
        vec![Value::Text(thread.to_owned()), Value::Text(list)],
    )?;
    let mut best: Vec<(i64, i64, Status)> = Vec::new();
    for row in rows {
        let ordinal = int_at(&row, 0)?;
        let text = text_at(&row, 1)?;
        let Ok(status) = parse_thread_status(text) else {
            continue;
        };
        let rank = linked_rank(&status);
        match best.iter_mut().find(|(at, _, _)| *at == ordinal) {
            Some(slot) if rank < slot.1 => *slot = (ordinal, rank, status),
            Some(_) => {}
            None => best.push((ordinal, rank, status)),
        }
    }
    Ok(best
        .into_iter()
        .map(|(ordinal, _, status)| (ordinal, status))
        .collect())
}

/// The best owned status per turn ordinal, by the loader's rank.
pub fn owned_statuses(
    conn: &Arc<Connection>,
    thread: &str,
    ordinals: &[i64],
) -> Result<Vec<(i64, Status)>, LongError> {
    if ordinals.is_empty() {
        return Ok(Vec::new());
    }
    let list = ints_json(ordinals);
    let rows = all_rows_raw(
        conn,
        "SELECT a.ordinal AS ordinal,a.status AS status,a.id AS id FROM long_agents a WHERE a.thread_id=? AND a.ordinal IN (SELECT value FROM json_each(?)) AND a.completion_relevant=1 AND json_extract(a.status,'$.state') NOT IN ('idle','interrupted','failed') ORDER BY a.ordinal,a.id",
        vec![Value::Text(thread.to_owned()), Value::Text(list)],
    )?;
    let mut best: Vec<(i64, i64, String, Status)> = Vec::new();
    for row in rows {
        let ordinal = int_at(&row, 0)?;
        let text = text_at(&row, 1)?;
        let id = text_at(&row, 2)?.to_owned();
        let Ok(agent) = super::super::status::agent_thread_status(text) else {
            continue;
        };
        let (state, on) = raw_state_on(text);
        let rank = owned_rank(state, on.as_deref());
        match best.iter_mut().find(|(at, _, _, _)| *at == ordinal) {
            Some(slot) if rank < slot.1 => *slot = (ordinal, rank, id, agent),
            Some(slot) if rank == slot.1 && id < slot.2 => *slot = (ordinal, rank, id, agent),
            Some(_) => {}
            None => best.push((ordinal, rank, id, agent)),
        }
    }
    Ok(best
        .into_iter()
        .map(|(ordinal, _, _, status)| (ordinal, status))
        .collect())
}

/// The raw `state` and `on` of an agent status, for the loader's rank.
/// Returns empty state when the body is not an object, so the caller skips it
/// the same way the conversion does.
fn raw_state_on(text: &str) -> (&str, Option<String>) {
    #[derive(serde::Deserialize)]
    struct Raw<'a> {
        #[serde(borrow, default)]
        state: Option<&'a str>,
        #[serde(borrow, default)]
        on: Option<&'a str>,
    }
    let parsed: Result<Raw<'_>, _> = serde_json::from_str(text);
    match parsed {
        Ok(raw) => (raw.state.unwrap_or(""), raw.on.map(|on| on.to_owned())),
        Err(_) => ("", None),
    }
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
