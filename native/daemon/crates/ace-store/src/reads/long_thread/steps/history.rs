// SPDX-License-Identifier: Apache-2.0
//! An agent's earlier steps, read for a later page's carried site.
//!
//! A browser step without its own URL takes the site its agent was on before.

use super::super::common::{LongError, all_rows_raw};
use super::super::row::text_at;
use super::items::{batch_items, parse_item};
use super::span::extract_call;
use super::surface::tool_surface;
use crate::{Connection, Value};
use std::sync::Arc;

/// The site an agent's browser was on before `seq` in the same turn.
pub fn site_before(
    conn: &Arc<Connection>,
    thread_id: &str,
    ordinal: i64,
    agent_id: Option<&str>,
    seq: i64,
) -> Result<Option<String>, LongError> {
    let agent_param = match agent_id {
        Some(agent) => Value::Text(agent.to_owned()),
        None => Value::Null,
    };
    // SQLite `IS ?` matches NULL, so an agent-less step finds agent-less history.
    let rows = all_rows_raw(
        conn,
        "SELECT i.item_id FROM long_items i JOIN item_heads h ON h.id=i.item_id AND h.thread_id=i.thread_id WHERE i.thread_id=? AND i.ordinal=? AND i.agent_id IS ? AND i.created_seq<? AND h.item_type='tool_call' ORDER BY i.created_seq DESC LIMIT 16",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(ordinal),
            agent_param,
            Value::Integer(seq),
        ],
    )?;
    let mut batch_ids = Vec::new();
    for row in rows {
        batch_ids.push(text_at(&row, 0)?.to_owned());
    }
    let batch_map = batch_items(conn, thread_id, &batch_ids)?;
    for item_id in batch_ids {
        let Some(body) = batch_map.body(&item_id) else {
            continue;
        };
        let Ok(item) = parse_item(body) else {
            continue;
        };
        if item.type_.as_deref() != Some("tool_call") {
            continue;
        }
        let Some(call_body) = extract_call(body) else {
            continue;
        };
        let Ok(surface) = tool_surface(call_body, None) else {
            continue;
        };
        if let Some(surface) = surface
            && let Some(super::surface::Icon::Site { origin }) = surface.icon
        {
            return Ok(Some(origin));
        }
    }
    Ok(None)
}
