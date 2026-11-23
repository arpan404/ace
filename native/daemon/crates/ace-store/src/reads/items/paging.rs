// SPDX-License-Identifier: Apache-2.0
use super::cache::{WindowRead, wire_page_cached};
use super::chunks::with_chunks;
use super::fetch::{Candidate, WireData, fetch_bodies, is_preview_kind};
use super::json::{J, encode_units, string_len, write_json};
use super::parse::parse_json;
use super::text::{item_chunks, read_preview};
use super::{ReadError, Result, Trust, all, cell, int, one, text, trusted};
use crate::{Connection, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn emit_page(
    thread_id: &str,
    items: Vec<J>,
    item_seqs: Vec<(String, i64)>,
    items_before: Option<i64>,
    untrusted: &[String],
) -> String {
    let out = J::Obj(vec![
        (encode_units("threadId"), J::Str(encode_units(thread_id))),
        (encode_units("items"), J::Arr(items.into_iter().collect())),
        (
            encode_units("itemSeqs"),
            J::Obj(
                item_seqs
                    .into_iter()
                    .map(|(id, seq)| (encode_units(&id), J::Num(seq.to_string())))
                    .collect(),
            ),
        ),
        (
            encode_units("itemsBefore"),
            items_before.map_or(J::Null, |seq| J::Num(seq.to_string())),
        ),
        (
            encode_units("untrusted"),
            J::Arr(
                untrusted
                    .iter()
                    .map(|id| J::Str(encode_units(id)))
                    .collect(),
            ),
        ),
    ]);
    let mut text = String::new();
    write_json(&mut text, &out);
    text
}

/// A wire page: the newest items before `before` that fit `byteLimit`, oldest first.
pub fn wire_page(
    conn: &Arc<Connection>,
    thread_id: &str,
    before: f64,
    limit: f64,
    byte_limit: f64,
    trust: Trust,
) -> Result<String> {
    let mut untrusted = Vec::new();
    let mut data = WireData {
        bodies: HashMap::new(),
        previews: HashMap::new(),
        sizes: HashMap::new(),
        bytes: HashMap::new(),
    };
    let mut read = WindowRead {
        conn,
        thread_id,
        trust,
        untrusted: &mut untrusted,
        cache: &mut data,
        validate: Vec::new(),
        drop_reduced: Vec::new(),
    };
    let out = wire_page_cached(&mut read, before, limit, byte_limit)?;
    Ok(emit_page(
        thread_id, out.items, out.seqs, out.before, &untrusted,
    ))
}

/// One item as a step list shows it: text cut to its bounded preview, tool bodies whole.
pub(crate) fn step_item(
    conn: &Arc<Connection>,
    thread_id: &str,
    item_id: &str,
    trust: Trust,
    untrusted: &mut Vec<String>,
) -> Result<Option<J>> {
    let head = one(
        conn,
        "SELECT item_type FROM item_heads WHERE thread_id = ? AND id = ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Text(item_id.to_owned()),
        ],
    )?;
    let Some(head) = head else {
        return Ok(None);
    };
    let kind = text(cell(&head, 0)?)?;
    if is_preview_kind(kind) {
        return Ok(Some(read_preview(conn, item_id, trust, untrusted)?));
    }
    let row = one(
        conn,
        "SELECT item, created_seq FROM items WHERE id = ? AND thread_id = ?",
        &[
            Value::Text(item_id.to_owned()),
            Value::Text(thread_id.to_owned()),
        ],
    )?;
    match row {
        None => Ok(None),
        Some(row) => {
            let mut item = parse_json(text(cell(&row, 0)?)?)?;
            let created = int(cell(&row, 1)?)?;
            with_chunks(&mut item, &item_chunks(conn, item_id)?, trust)?;
            if !trusted(trust, created) && !untrusted.contains(&item_id.to_owned()) {
                untrusted.push(item_id.to_owned());
            }
            Ok(Some(item))
        }
    }
}

/// A page of whole items: the newest `limit` before `before` that fit, oldest first. A newest
/// item larger than the whole budget still shows, as its bounded text preview.
pub fn page(
    conn: &Arc<Connection>,
    thread_id: &str,
    before: f64,
    limit: f64,
    byte_limit: Option<f64>,
    trust: Trust,
) -> Result<String> {
    if before.trunc() != before
        || before < 1.0
        || before.abs() > 9_007_199_254_740_991.0
        || limit.trunc() != limit
        || !(1.0..=200.0).contains(&limit)
    {
        return Err(ReadError::Row("Invalid item page"));
    }
    let limit = limit as usize;
    let rows = all(
        conn,
        "SELECT id, created_seq, size FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Real(before),
            Value::Real(limit as f64 + 1.0),
        ],
    )?;
    let budget = byte_limit.unwrap_or(1024.0 * 1024.0);
    let mut count = 0usize;
    let mut used = 4i64;
    while count < rows.len().min(limit) {
        let row = &rows[count];
        let size = int(cell(row, 2)?)?
            .saturating_add(2 * string_len(&encode_units(text(cell(row, 0)?)?)) as i64)
            .saturating_add(1)
            .saturating_add(if count > 0 { 2 } else { 0 });
        if used.saturating_add(size) as f64 > budget && (count > 0 || byte_limit.is_some()) {
            break;
        }
        used = used.saturating_add(size);
        count += 1;
    }
    let mut untrusted = Vec::new();
    let oversized = if count == 0 && !rows.is_empty() {
        step_item(
            conn,
            thread_id,
            text(cell(&rows[0], 0)?)?,
            trust,
            &mut untrusted,
        )?
    } else {
        None
    };
    if oversized.is_some() {
        count = 1;
    }
    let oldest = if count > 0 {
        int(cell(&rows[count - 1], 1)?)? as f64
    } else {
        before
    };
    let items = if let Some(item) = oversized {
        vec![item]
    } else if count > 0 {
        let ids: Vec<String> = rows[..count]
            .iter()
            .map(|row| text(cell(row, 0)?).map(str::to_owned))
            .collect::<Result<_>>()?;
        let bodies = fetch_bodies(conn, &ids)?;
        let mut items = Vec::new();
        for id in ids.iter().rev() {
            if let Some(candidate) = bodies.get(id) {
                let Some((body, created)) = candidate.body.as_ref() else {
                    continue;
                };
                let mut item = parse_json(body)?;
                with_chunks(&mut item, &candidate.chunks, trust)?;
                if !trusted(trust, *created) && !untrusted.contains(id) {
                    untrusted.push(id.clone());
                }
                items.push(item);
            }
        }
        items
    } else {
        Vec::new()
    };
    let cursors: Vec<(String, i64)> = rows[..count]
        .iter()
        .map(|row| Ok((text(cell(row, 0)?)?.to_owned(), int(cell(row, 1)?)?)))
        .collect::<Result<_>>()?;
    let items_before = if rows.len() > count {
        Some(oldest as i64)
    } else {
        None
    };
    Ok(emit_page(
        thread_id,
        items,
        cursors,
        items_before,
        &untrusted,
    ))
}

pub(crate) fn materialize_map(
    ids: &[String],
    bodies: &HashMap<String, Candidate>,
    trust: Trust,
    untrusted: &mut Vec<String>,
) -> Result<Vec<(String, J)>> {
    let mut out = Vec::new();
    for id in ids {
        let Some(candidate) = bodies.get(id) else {
            return Err(ReadError::Row("Missing item body"));
        };
        let Some((body, created)) = candidate.body.as_ref() else {
            return Err(ReadError::Row("Missing item body"));
        };
        let mut item = parse_json(body)?;
        with_chunks(&mut item, &candidate.chunks, trust)?;
        if !trusted(trust, *created) && !untrusted.contains(id) {
            untrusted.push(id.clone());
        }
        out.push((id.clone(), item));
    }
    Ok(out)
}
