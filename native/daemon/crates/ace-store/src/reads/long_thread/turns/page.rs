// SPDX-License-Identifier: Apache-2.0
//! `turnsPage`, as `long-thread/reader.ts` reads it.
//!
//! Every turn, agent share and child thread of a page is read in batched
//! statements, then serialized once into its own buffer: a turn that busts the
//! page's byte budget is stripped and measured again, and finished turns are
//! spliced verbatim into the page's single response buffer.

use super::super::common::{LongError, all_rows_raw, check_count, get_row_raw, invalid};
use super::super::digests::{Counters, DigestOut, read_agent_digests, read_turn_digests};
use super::agents::{
    child_statuses, head_row, linked_statuses, owned_statuses, page_agents, thread_status_row,
};
use super::emit::{MainShare, Turn, TurnsPage, subagent_summary, turn_status};
use super::rows::{TurnRow, digest_indexed_seq, parse_turn_row};
use crate::{Connection, Value};
use std::sync::Arc;

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
        all_rows_raw(
            conn,
            "SELECT thread_id,ordinal,start_seq,end_seq,started_at,ended_at,root_run,root_outcome,settled_seq,initiating,latest FROM long_turns WHERE thread_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?",
            vec![
                Value::Text(thread_id.to_owned()),
                Value::Integer(cursor),
                Value::Integer(limit),
            ],
        )?
    } else {
        let cursor = after.unwrap_or(0);
        all_rows_raw(
            conn,
            "SELECT thread_id,ordinal,start_seq,end_seq,started_at,ended_at,root_run,root_outcome,settled_seq,initiating,latest FROM long_turns WHERE thread_id=? AND ordinal>? ORDER BY ordinal LIMIT ?",
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
    let root_param = root.clone().unwrap_or_default();
    let agents = page_agents(
        conn,
        thread_id,
        &parsed
            .iter()
            .map(|row: &TurnRow| row.ordinal)
            .collect::<Vec<_>>(),
        &root_param,
    )?;
    let mut child_ids: Vec<String> = Vec::new();
    for group in &agents {
        for agent in group.iter().take(32) {
            if let Some(child) = agent.child_thread.clone()
                && !child.is_empty()
                && !child_ids.contains(&child)
            {
                child_ids.push(child);
            }
        }
    }
    let child_map = child_statuses(conn, &child_ids)?;
    let child_status = |id: &str| {
        child_map
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, status)| status.clone())
    };
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
                let live = agent
                    .child_thread
                    .as_deref()
                    .is_some_and(|child| child_map.iter().any(|(known, _)| known == child));
                if live {
                    if let Some(child) = agent.child_thread.clone() {
                        full_turn_keys.push((child, 0));
                    }
                    kinds.push(true);
                } else {
                    full_agent_keys.push((row.ordinal, agent.id.clone()));
                    kinds.push(false);
                }
            }
        }
        subagent_kinds.push(kinds);
    }
    let turn_digests = read_turn_digests(conn, &full_turn_keys)?;
    let agent_digests = read_agent_digests(conn, thread_id, &full_agent_keys)?;
    // Each digest is consumed once, in order, so shares move instead of cloning.
    let mut turn_digests: Vec<Option<(DigestOut, Counters)>> =
        turn_digests.into_iter().map(Some).collect();
    let mut agent_digests: Vec<Option<DigestOut>> = agent_digests.into_iter().map(Some).collect();
    let take_turn = |taken: &mut Vec<Option<(DigestOut, Counters)>>, at: usize| {
        taken
            .get_mut(at)
            .and_then(|slot| slot.take())
            .ok_or_else(|| invalid("Missing turn digest"))
    };
    let take_agent = |taken: &mut Vec<Option<DigestOut>>, at: usize| {
        taken
            .get_mut(at)
            .and_then(|slot| slot.take())
            .ok_or_else(|| invalid("Missing turn digest"))
    };
    let ordinals: Vec<i64> = parsed.iter().map(|row| row.ordinal).collect();
    let linked_map = linked_statuses(conn, thread_id, &ordinals)?;
    let owned_map = owned_statuses(conn, thread_id, &ordinals)?;
    let linked = |ordinal: i64| {
        linked_map
            .iter()
            .find(|(at, _)| *at == ordinal)
            .map(|(_, status)| status.clone())
    };
    let owned = |ordinal: i64| {
        owned_map
            .iter()
            .find(|(at, _)| *at == ordinal)
            .map(|(_, status)| status.clone())
    };
    let mut turn_buffers: Vec<Box<serde_json::value::RawValue>> = Vec::new();
    let mut included: Vec<i64> = Vec::new();
    let mut bytes = 1024usize;
    let mut agent_cursor = agent_keys.len();
    let mut turn_cursor = turn_keys.len();
    // Re-walk in order, consuming the digests built above.
    for (index, row) in parsed.iter().enumerate() {
        let (own_digest, own_counters) = take_turn(&mut turn_digests, index)?;
        let kinds = subagent_kinds.get(index).cloned().unwrap_or_default();
        let mut subagents = Vec::new();
        if let Some(group) = agents.get(index) {
            for (agent_index, agent) in group.iter().take(32).enumerate() {
                let is_turn = kinds.get(agent_index).copied().unwrap_or(false);
                let digest = if is_turn {
                    let (digest, _) = take_turn(&mut turn_digests, turn_cursor)?;
                    turn_cursor += 1;
                    digest
                } else {
                    let digest = take_agent(&mut agent_digests, agent_cursor)?;
                    agent_cursor += 1;
                    digest
                };
                let child = agent.child_thread.clone();
                let live = child
                    .as_deref()
                    .is_some_and(|id| child_map.iter().any(|(known, _)| known == id));
                let status = if live {
                    child
                        .as_deref()
                        .and_then(child_status)
                        .ok_or_else(|| invalid("Missing turn digest"))?
                } else {
                    super::super::status::agent_thread_status(&agent.status_text)?
                };
                let child_stored = if live {
                    child.as_deref().and_then(child_status)
                } else {
                    None
                };
                subagents.push(subagent_summary(
                    agent,
                    child,
                    digest,
                    live,
                    child_stored,
                    status,
                )?);
            }
        }
        let status = turn_status(
            row,
            head_ordinal,
            head_status_text.as_deref(),
            thread_status.as_ref(),
            &own_counters,
            linked(row.ordinal).as_ref(),
            owned(row.ordinal).as_ref(),
        )?;
        let main = match mains.get(index).copied().flatten() {
            None => None,
            Some(at) => {
                let digest = take_agent(&mut agent_digests, at)?;
                let root_id = root.clone().ok_or_else(|| invalid("Missing turn digest"))?;
                Some(MainShare {
                    agent_id: root_id,
                    digest,
                })
            }
        };
        let mut turn = Turn {
            thread_id,
            ordinal: row.ordinal,
            start_seq: row.start_seq,
            end_seq: row.end_seq,
            started_at: row.started_at,
            ended_at: row.ended_at,
            status,
            outcome: row.root_outcome.as_str(),
            initiating: row.initiating.as_str(),
            latest: row.latest.as_str(),
            digest: own_digest,
            main,
            subagents,
            subagents_truncated: agents.get(index).is_some_and(|group| group.len() > 32),
        };
        let mut buffer = Vec::with_capacity(4096);
        serde_json::to_writer(&mut buffer, &turn).map_err(|error| invalid(&error.to_string()))?;
        if buffer.len() > 1024 * 1024 - 1024 {
            if let Some(main) = turn.main.as_mut() {
                super::super::turns_types::strip_details(&mut main.digest);
            }
            for subagent in &mut turn.subagents {
                super::super::turns_types::strip_details(&mut subagent.digest);
            }
            buffer.clear();
            serde_json::to_writer(&mut buffer, &turn)
                .map_err(|error| invalid(&error.to_string()))?;
            if buffer.len() > 1024 * 1024 - 1024 {
                super::super::turns_types::strip_details(&mut turn.digest);
                buffer.clear();
                serde_json::to_writer(&mut buffer, &turn)
                    .map_err(|error| invalid(&error.to_string()))?;
            }
        }
        let size = buffer.len();
        if bytes + size > 1024 * 1024 && !turn_buffers.is_empty() {
            break;
        }
        bytes += size;
        included.push(row.ordinal);
        let text = String::from_utf8(buffer).map_err(|_| invalid("invalid index row"))?;
        turn_buffers.push(
            serde_json::value::RawValue::from_string(text)
                .map_err(|_| invalid("invalid index row"))?,
        );
    }
    let (first, last) = if after.is_none() {
        turn_buffers.reverse();
        (included.last().copied(), included.first().copied())
    } else {
        (included.first().copied(), included.last().copied())
    };
    let before_cursor = if let Some(first) = first {
        let exists = get_row_raw(
            conn,
            "SELECT 1 FROM long_turns WHERE thread_id=? AND ordinal<? LIMIT 1",
            vec![Value::Text(thread_id.to_owned()), Value::Integer(first)],
        )?;
        if exists.is_some() { Some(first) } else { None }
    } else {
        None
    };
    let after_cursor = if let Some(last) = last {
        let exists = get_row_raw(
            conn,
            "SELECT 1 FROM long_turns WHERE thread_id=? AND ordinal>? LIMIT 1",
            vec![Value::Text(thread_id.to_owned()), Value::Integer(last)],
        )?;
        if exists.is_some() { Some(last) } else { None }
    } else {
        None
    };
    let indexed = digest_indexed_seq(conn)?;
    check_count(indexed)?;
    check_count(head_seq)?;
    let response = TurnsPage {
        type_: "turns.page",
        request_id,
        thread_id,
        seq: head_seq,
        indexed_seq: indexed,
        ready: indexed >= head_seq,
        turns: turn_buffers,
        before: before_cursor,
        after: after_cursor,
    };
    let mut out = Vec::with_capacity(bytes + 256);
    serde_json::to_writer(&mut out, &response).map_err(|error| invalid(&error.to_string()))?;
    String::from_utf8(out).map_err(|_| invalid("invalid index row"))
}
