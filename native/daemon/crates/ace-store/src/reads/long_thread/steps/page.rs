// SPDX-License-Identifier: Apache-2.0
//! `turn.steps`, as `long-thread/steps.ts` reads it.
//!
//! Each step serializes once for the byte budget and once more in the finished
//! page; surfaces are worked out from the stored calls in between.

use super::super::common::{LongError, all_rows_raw, get_row_raw, invalid};
use super::super::row::{int_at, text_at};
use super::emit::{StepOut, StepsPage};
use super::history::site_before;
use super::items::{batch_items, parse_item};
use super::span::{extract_call, lightened};
use super::surface::{Surface, tool_surface, valid_surface};
use crate::{Connection, Value};
use std::sync::Arc;

#[allow(clippy::too_many_arguments)]
pub fn turn_steps(
    conn: &Arc<Connection>,
    thread_id: &str,
    turn_ordinal: i64,
    after: Option<i64>,
    limit: i64,
    request_id: &str,
    head_seq: i64,
) -> Result<String, LongError> {
    if !(1..=200).contains(&limit) {
        return Err(invalid("search_invalid_query"));
    }
    if turn_ordinal < 1 {
        return Err(invalid("turn_target_unavailable"));
    }
    let turn = get_row_raw(
        conn,
        "SELECT end_seq FROM long_turns WHERE thread_id=? AND ordinal=?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(turn_ordinal),
        ],
    )?
    .ok_or_else(|| invalid("turn_target_unavailable"))?;
    let end_seq = super::super::common::check_count(int_at(&turn, 0)?)?;
    let after_seq = after.unwrap_or(0);
    let rows = all_rows_raw(
        conn,
        "SELECT item_id,created_seq FROM long_items WHERE thread_id=? AND ordinal=? AND created_seq>? AND (role IS NULL OR role<>'user') ORDER BY created_seq LIMIT ?",
        vec![
            Value::Text(thread_id.to_owned()),
            Value::Integer(turn_ordinal),
            Value::Integer(after_seq),
            Value::Integer(limit + 1),
        ],
    )?;
    let batch_ids: Vec<String> = rows
        .iter()
        .take(limit as usize)
        .filter_map(|row| text_at(row, 0).ok().map(|text| text.to_owned()))
        .collect();
    let batch_map = batch_items(conn, thread_id, &batch_ids)?;
    let created = super::trust::created_seqs(conn, thread_id, &batch_ids)?;
    let created_at = |item_id: &str| {
        created
            .iter()
            .find(|(known, _)| known == item_id)
            .map(|(_, seq)| *seq)
    };
    let seqs: Vec<i64> = created.iter().map(|(_, seq)| *seq).collect();
    let trust = super::trust::trust_for(conn, &seqs)?;
    struct Held {
        seq: i64,
        light: String,
        agent: String,
    }
    let mut held: Vec<Held> = Vec::new();
    let mut bytes = 512usize;
    for row in rows.iter().take(limit as usize) {
        let item_id = text_at(row, 0)?.to_owned();
        let seq = super::super::common::check_count(int_at(row, 1)?)?;
        let Some(body) = batch_map.body(&item_id) else {
            continue;
        };
        // Trusted bodies read as stored; older rows decode to the schema's order.
        let decoded = if trust.trusted(created_at(&item_id)) {
            body.to_owned()
        } else {
            super::item_norm::normalize_item(body)?
        };
        let light = lightened(&decoded)?.unwrap_or_else(|| decoded.clone());
        let probe = StepOut {
            seq,
            item: serde_json::value::RawValue::from_string(light.clone())
                .map_err(|_| invalid("invalid index row"))?,
            surface: None,
        };
        let size = serde_json::to_string(&probe)
            .map_err(|error| invalid(&error.to_string()))?
            .len();
        if !held.is_empty() && bytes + size > 1024 * 1024 {
            break;
        }
        bytes += size;
        let item = parse_item(&light).map_err(|_| invalid("invalid index row"))?;
        let agent = item.agent_id.map(|id| id.into_owned()).unwrap_or_default();
        held.push(Held { seq, light, agent });
    }
    let mut surfaces: Vec<Option<Surface>> = Vec::new();
    for step in &held {
        let surface = match extract_call(&step.light) {
            None => None,
            Some(call_body) => tool_surface(call_body, None)?,
        };
        surfaces.push(surface);
    }
    let first = held.first().map(|step| step.seq);
    if after.is_some()
        && let Some(first_seq) = first
    {
        let mut carried: Vec<(String, String)> = Vec::new();
        for (index, step) in held.iter().enumerate() {
            let needs = surfaces
                .get(index)
                .and_then(|surface| surface.as_ref())
                .is_some_and(|surface| {
                    surface.kind == "browser"
                        && surface.icon.is_none()
                        && !carried.iter().any(|(agent, _)| agent == &step.agent)
                });
            if needs {
                let agent_opt = if step.agent.is_empty() {
                    None
                } else {
                    Some(step.agent.as_str())
                };
                if let Some(origin) =
                    site_before(conn, thread_id, turn_ordinal, agent_opt, first_seq)?
                {
                    carried.push((step.agent.clone(), origin));
                }
            }
        }
        if !carried.is_empty() {
            surfaces.clear();
            for step in &held {
                let carried_origin = carried
                    .iter()
                    .find(|(agent, _)| agent == &step.agent)
                    .map(|(_, origin)| origin.as_str());
                let surface = match extract_call(&step.light) {
                    None => None,
                    Some(call_body) => tool_surface(call_body, carried_origin)?,
                };
                surfaces.push(surface);
            }
        }
    }
    let mut out_steps = Vec::new();
    for (index, step) in held.into_iter().enumerate() {
        let surface = surfaces
            .get(index)
            .and_then(|surface| surface.clone())
            .and_then(valid_surface);
        out_steps.push(StepOut {
            seq: step.seq,
            item: serde_json::value::RawValue::from_string(step.light)
                .map_err(|_| invalid("invalid index row"))?,
            surface,
        });
    }
    let last = out_steps.last().map(|step| step.seq);
    let more = (out_steps.len() as i64) < (rows.len() as i64);
    let response = StepsPage {
        type_: "turn.steps",
        request_id,
        thread_id,
        turn_ordinal,
        seq: head_seq,
        end_seq,
        steps: out_steps,
        after: if more { last } else { None },
    };
    let mut out = Vec::with_capacity(bytes + 256);
    serde_json::to_writer(&mut out, &response).map_err(|error| invalid(&error.to_string()))?;
    String::from_utf8(out).map_err(|_| invalid("invalid index row"))
}
