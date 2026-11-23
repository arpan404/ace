// SPDX-License-Identifier: Apache-2.0
use super::bounded::{FillOut, fits_alone, item_id_units, reduced_page};
use super::cache::WindowRead;
use super::fetch::{Head, assemble_candidate, entry_overhead, fetch_wire_data, is_preview_kind};
use super::json::{J, encode_units, json_bytes, push_string, string_len, write_json};
use super::{ReadError, Result, Trust, all, cell, int, one, text, trusted};
use crate::{Connection, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// One single-item wire read from prefetched rows: the item, or `Capacity` when the page
/// cannot start with it. Other failures propagate, like `pageItem`'s do.
pub(crate) fn wire_single(
    read: &mut WindowRead,
    head: &Head,
    byte_limit: f64,
    used: i64,
) -> Result<J> {
    let overhead = entry_overhead(&head.id);
    let preview = is_preview_kind(&head.kind);
    if !preview && used.saturating_add(head.size).saturating_add(overhead) as f64 > byte_limit {
        return Err(ReadError::Capacity);
    }
    let item = assemble_candidate(read.cache, &head.id, &head.kind, read.trust, read.untrusted)?;
    let size = if !preview && trusted(read.trust, head.seq) {
        head.size
    } else {
        json_bytes(&item) as i64
    }
    .saturating_add(overhead);
    if used.saturating_add(size) as f64 > byte_limit {
        return Err(ReadError::Capacity);
    }
    Ok(item)
}

/// Read the target and one neighbor into the window, until the budget is reached.
pub(crate) fn window_add(
    read: &mut WindowRead,
    head: &Head,
    target_seq: i64,
    byte_limit: f64,
    used: &mut i64,
    selected: &mut Vec<(i64, J)>,
    omitted: &mut Vec<J>,
) -> Result<bool> {
    let remaining = byte_limit - *used as f64 + 512.0;
    let seq = head.seq;
    let out = match wire_single(read, head, remaining, *used) {
        Ok(item) => FillOut {
            items: vec![item],
            seqs: vec![(head.id.clone(), seq)],
            omitted: Vec::new(),
        },
        Err(ReadError::Capacity) => {
            if seq != target_seq && fits_alone(read, seq, byte_limit)? {
                return Ok(false);
            }
            reduced_page(
                read,
                seq,
                (byte_limit - *used as f64).min(byte_limit / 8.0) + 512.0,
            )?
        }
        Err(error) => return Err(error),
    };
    let Some(item) = out.items.into_iter().next() else {
        if seq == target_seq {
            return Err(ReadError::Row("Item detail exceeds window capacity"));
        }
        return Ok(false);
    };
    let id = item_id_units(&item);
    let size = json_bytes(&item) as f64 + string_len(&id) as f64 + 64.0;
    let marks = if out.omitted.is_empty() {
        0.0
    } else {
        json_bytes(&J::Arr(out.omitted.clone())) as f64
    };
    *used = used.saturating_add((size + marks) as i64);
    omitted.extend(out.omitted);
    selected.push((seq, item));
    Ok(true)
}

/// An items window around `around_seq`: the jump point and its neighbors that fit.
pub fn window(
    conn: &Arc<Connection>,
    thread_id: &str,
    around_seq: f64,
    before_count: f64,
    after_count: f64,
    byte_limit: f64,
    trust: Trust,
) -> Result<String> {
    let target = one(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? AND created_seq >= ? ORDER BY created_seq LIMIT 1",
        &[Value::Text(thread_id.to_owned()), Value::Real(around_seq)],
    )?
    .or(one(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? ORDER BY created_seq DESC LIMIT 1",
        &[Value::Text(thread_id.to_owned())],
    )?);
    let Some(target) = target else {
        let mut text = String::from("{\"threadId\":");
        push_string(&mut text, &encode_units(thread_id));
        text.push_str(",\"targetSeq\":null,\"items\":[],\"itemSeqs\":{},\"itemsBefore\":null,\"itemsAfter\":null,\"untrusted\":[]}");
        return Ok(text);
    };
    let target_seq = int(cell(&target, 0)?)?;
    let older: Vec<i64> = all(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Integer(target_seq),
            Value::Real(before_count),
        ],
    )?
    .iter()
    .map(|row| int(cell(row, 0)?))
    .collect::<Result<_>>()?;
    let newer: Vec<i64> = all(
        conn,
        "SELECT created_seq FROM item_heads WHERE thread_id = ? AND created_seq > ? ORDER BY created_seq LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Integer(target_seq),
            Value::Real(after_count),
        ],
    )?
    .iter()
    .map(|row| int(cell(row, 0)?))
    .collect::<Result<_>>()?;
    let mut seq_list = String::from("[");
    seq_list.push_str(&target_seq.to_string());
    for seq in older.iter().chain(newer.iter()) {
        seq_list.push(',');
        seq_list.push_str(&seq.to_string());
    }
    seq_list.push(']');
    let mut heads: HashMap<i64, Head> = HashMap::new();
    for row in all(
        conn,
        "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq IN (SELECT value FROM json_each(?))",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Text(seq_list),
        ],
    )?
    .iter()
    {
        let id = text(cell(row, 0)?)?.to_owned();
        let seq = int(cell(row, 1)?)?;
        let size = int(cell(row, 2)?)?;
        let kind = text(cell(row, 3)?)?.to_owned();
        if id.is_empty()
            || !(1..=9_007_199_254_740_991i64).contains(&seq)
            || size < 0
            || kind.is_empty()
            || encode_units(&kind).len() > 64
        {
            return Err(ReadError::Row("Invalid item page"));
        }
        heads.insert(seq, Head { id, seq, size, kind });
    }
    let mut ids: Vec<String> = heads.values().map(|head| head.id.clone()).collect();
    ids.sort();
    ids.dedup();
    let mut cache = fetch_wire_data(conn, &ids)?;
    let mut untrusted = Vec::new();
    let mut read = WindowRead {
        conn,
        thread_id,
        trust,
        untrusted: &mut untrusted,
        cache: &mut cache,
    };
    let mut selected: Vec<(i64, J)> = Vec::new();
    let mut omitted: Vec<J> = Vec::new();
    let mut used = 512i64;
    // A head read after its sequence was deleted reads nothing, like the loader's own page.
    if let Some(head) = heads.get(&target_seq) {
        if !window_add(
            &mut read,
            head,
            target_seq,
            byte_limit,
            &mut used,
            &mut selected,
            &mut omitted,
        )? {
            return Err(ReadError::Row("Item detail exceeds window capacity"));
        }
    } else {
        return Err(ReadError::Row("Item detail exceeds window capacity"));
    }
    let mut left = 0usize;
    let mut right = 0usize;
    while left < older.len() || right < newer.len() {
        if let Some(seq) = older.get(left) {
            if let Some(head) = heads.get(seq)
                && !window_add(
                    &mut read,
                    head,
                    target_seq,
                    byte_limit,
                    &mut used,
                    &mut selected,
                    &mut omitted,
                )?
            {
                break;
            }
            left += 1;
        }
        if let Some(seq) = newer.get(right) {
            if let Some(head) = heads.get(seq)
                && !window_add(
                    &mut read,
                    head,
                    target_seq,
                    byte_limit,
                    &mut used,
                    &mut selected,
                    &mut omitted,
                )?
            {
                break;
            }
            right += 1;
        }
    }
    selected.sort_by_key(|(seq, _)| *seq);
    let first = selected.first().map_or(target_seq, |(seq, _)| *seq);
    let last = selected.last().map_or(target_seq, |(seq, _)| *seq);
    let items_before = one(
        conn,
        "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq < ? LIMIT 1",
        &[Value::Text(thread_id.to_owned()), Value::Integer(first)],
    )?
    .is_some()
    .then_some(first);
    let items_after = one(
        conn,
        "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq > ? LIMIT 1",
        &[Value::Text(thread_id.to_owned()), Value::Integer(last)],
    )?
    .is_some()
    .then_some(last);
    omitted.sort_by_key(|entry| {
        entry
            .get("seq")
            .and_then(|seq| seq.as_int().ok())
            .unwrap_or(0)
    });
    let untrusted = std::mem::take(read.untrusted);
    let mut out = J::Obj(vec![
        (encode_units("threadId"), J::Str(encode_units(thread_id))),
        (encode_units("targetSeq"), J::Num(target_seq.to_string())),
        (
            encode_units("items"),
            J::Arr(selected.iter().map(|(_, item)| item.clone()).collect()),
        ),
        (
            encode_units("itemSeqs"),
            J::Obj(
                selected
                    .iter()
                    .map(|(seq, item)| (item_id_units(item), J::Num(seq.to_string())))
                    .collect(),
            ),
        ),
        (
            encode_units("itemsBefore"),
            items_before.map_or(J::Null, |seq| J::Num(seq.to_string())),
        ),
        (
            encode_units("itemsAfter"),
            items_after.map_or(J::Null, |seq| J::Num(seq.to_string())),
        ),
    ]);
    if let J::Obj(entries) = &mut out {
        if !omitted.is_empty() {
            entries.push((encode_units("omitted"), J::Arr(omitted)));
        }
        entries.push((
            encode_units("untrusted"),
            J::Arr(
                untrusted
                    .iter()
                    .map(|id| J::Str(encode_units(id)))
                    .collect(),
            ),
        ));
    }
    let mut text = String::new();
    write_json(&mut text, &out);
    Ok(text)
}
