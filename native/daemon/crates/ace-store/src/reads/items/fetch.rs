// SPDX-License-Identifier: Apache-2.0
use super::chunks::{chunk_append, with_chunks};
use super::json::{J, encode_units, lossy, push_string, string_len};
use super::parse::parse_error;
use super::parse::parse_json;
use super::text::{cut_slice, preview_fill};
use super::{ReadError, Result, Trust, all, cell, int, opt_int, text, trusted};
use crate::{Connection, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Stream byte rows by stream id, in offset order.
pub(crate) type StreamRows = HashMap<String, Vec<(i64, Vec<u8>)>>;

/// One candidate's stored rows: its body and chunks, or its preview.
pub(crate) struct Candidate {
    pub(crate) body: Option<(String, i64)>,
    pub(crate) chunks: Vec<(i64, String, Vec<u16>)>,
}

/// Every candidate's body and chunks in one statement, as `materializeAll` reads them.
pub(crate) fn fetch_bodies(
    conn: &Arc<Connection>,
    ids: &[String],
) -> Result<HashMap<String, Candidate>> {
    let mut out: HashMap<String, Candidate> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let list = {
        let mut list = String::from("[");
        for (index, id) in ids.iter().enumerate() {
            if index > 0 {
                list.push(',');
            }
            push_string(&mut list, &encode_units(id));
        }
        list.push(']');
        list
    };
    let rows = all(
        conn,
        "SELECT j.value AS id, 0 AS kind, i.item, i.created_seq, NULL AS seq, NULL AS field, NULL AS append
           FROM json_each(?1) j JOIN items i ON i.id = j.value
         UNION ALL
         SELECT j.value, 1, NULL, NULL, c.seq, c.field, c.append
           FROM json_each(?1) j JOIN item_text_chunks c ON c.item_id = j.value
         ORDER BY 1, 2, 5",
        &[Value::Text(list)],
    )?;
    for row in &rows {
        let id = text(cell(row, 0)?)?.to_owned();
        let entry = out.entry(id).or_insert(Candidate {
            body: None,
            chunks: Vec::new(),
        });
        if int(cell(row, 1)?)? == 0 {
            entry.body = Some((text(cell(row, 2)?)?.to_owned(), int(cell(row, 3)?)?));
        } else {
            entry.chunks.push((
                int(cell(row, 4)?)?,
                text(cell(row, 5)?)?.to_owned(),
                chunk_append(text(cell(row, 6)?)?)?,
            ));
        }
    }
    Ok(out)
}

/// Every candidate's preview in one statement.
pub(crate) fn fetch_previews(
    conn: &Arc<Connection>,
    ids: &[String],
) -> Result<HashMap<String, (String, Option<i64>)>> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut list = String::from("[");
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            list.push(',');
        }
        push_string(&mut list, &encode_units(id));
    }
    list.push(']');
    let rows = all(
        conn,
        "SELECT p.id, p.item, i.created_seq FROM item_previews p LEFT JOIN items i ON i.id = p.id WHERE p.id IN (SELECT value FROM json_each(?))",
        &[Value::Text(list)],
    )?;
    for row in &rows {
        out.insert(
            text(cell(row, 0)?)?.to_owned(),
            (text(cell(row, 1)?)?.to_owned(), opt_int(cell(row, 2)?)?),
        );
    }
    Ok(out)
}

/// Every candidate item's stream sizes in one statement.
pub(crate) fn fetch_stream_sizes(
    conn: &Arc<Connection>,
    ids: &[String],
) -> Result<HashMap<String, i64>> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut list = String::from("[");
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            list.push(',');
        }
        push_string(&mut list, &encode_units(id));
    }
    list.push(']');
    let rows = all(
        conn,
        "SELECT id, size FROM item_text_streams WHERE item_id IN (SELECT value FROM json_each(?))",
        &[Value::Text(list)],
    )?;
    for row in &rows {
        let size = int(cell(row, 1)?)?;
        if !(0..=9_007_199_254_740_991i64).contains(&size) {
            return Err(ReadError::Row("Invalid text stream"));
        }
        out.insert(text(cell(row, 0)?)?.to_owned(), size);
    }
    Ok(out)
}

/// Stream byte rows for every `(stream, start, end)` triple in one statement.
pub(crate) fn fetch_stream_bytes(
    conn: &Arc<Connection>,
    ranges: &[(String, i64, i64)],
) -> Result<StreamRows> {
    let mut out: HashMap<String, Vec<(i64, Vec<u8>)>> = HashMap::new();
    if ranges.is_empty() {
        return Ok(out);
    }
    let mut list = String::from("[");
    for (index, (id, start, end)) in ranges.iter().enumerate() {
        if index > 0 {
            list.push(',');
        }
        let mut quoted = String::new();
        push_string(&mut quoted, &encode_units(id));
        list.push_str(&format!(
            "{{\"id\":{quoted},\"start\":{start},\"end\":{end}}}"
        ));
    }
    list.push(']');
    let rows = all(
        conn,
        "SELECT c.stream_id, c.offset, c.bytes FROM json_each(?) j
           JOIN item_source_chunks c ON c.stream_id = (j.value ->> 'id')
            AND c.offset > CAST(j.value ->> 'start' AS INTEGER) - 65536
            AND c.offset < CAST(j.value ->> 'end' AS INTEGER)
          ORDER BY 1, 2",
        &[Value::Text(list)],
    )?;
    for row in &rows {
        let id = text(cell(row, 0)?)?.to_owned();
        let offset = int(cell(row, 1)?)?;
        let Value::Blob(bytes) = cell(row, 2)? else {
            return Err(ReadError::Row("Invalid text chunk"));
        };
        out.entry(id).or_default().push((offset, bytes.clone()));
    }
    Ok(out)
}

/// One head row behind a wire page: the validated `WirePageRows` shape.
pub(crate) struct Head {
    pub(crate) id: String,
    pub(crate) seq: i64,
    pub(crate) size: i64,
    pub(crate) kind: String,
}

/// Page heads, newest first, validated like `WirePageRows`: at most 201 rows, each with a
/// positive creation sequence, a non-negative size and a named type.
pub(crate) fn wire_heads(
    conn: &Arc<Connection>,
    thread_id: &str,
    before: f64,
    limit: f64,
) -> Result<Vec<Head>> {
    let rows = all(
        conn,
        "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
        &[
            Value::Text(thread_id.to_owned()),
            Value::Real(before),
            Value::Real(limit + 1.0),
        ],
    )?;
    if rows.len() > 201 {
        return Err(ReadError::Row("Invalid item page"));
    }
    rows.iter()
        .map(|row| {
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
            Ok(Head {
                id,
                seq,
                size,
                kind,
            })
        })
        .collect()
}

pub(crate) fn is_preview_kind(kind: &str) -> bool {
    matches!(kind, "message" | "notice" | "reasoning")
}

/// A fillable text source's fetch window: the head's first bytes, or the tail's last bytes.
/// Every head read fits the first window and every tail read the last, so one window per
/// source covers whatever the page keeps, exactly for single-source items.
pub(crate) fn source_ranges(
    item: &J,
    sizes: &HashMap<String, i64>,
) -> Result<Vec<(String, i64, i64)>> {
    let complete = match item.get("complete") {
        None => true,
        Some(J::Bool(done)) => *done,
        Some(_) => return Err(ReadError::Row("Invalid stored item")),
    };
    let streaming = !complete;
    let mut ranges = Vec::new();
    let mut sources = Vec::new();
    let kind = item
        .get("type")
        .and_then(|kind| match kind {
            J::Str(units) => Some(lossy(units)),
            _ => None,
        })
        .ok_or_else(parse_error)?;
    if kind == "message" {
        let Some(J::Arr(parts)) = item.get("parts") else {
            return Err(parse_error());
        };
        for part in parts {
            let text_part = part.get("type").and_then(|kind| match kind {
                J::Str(units) => Some(lossy(units)),
                _ => None,
            }) == Some("text".to_owned());
            if text_part && let Some(source) = part.get("source") {
                sources.push(source);
            }
        }
    } else if (kind == "reasoning" || kind == "notice")
        && let Some(source) = item.get("source")
    {
        sources.push(source);
    }
    for source in sources {
        let Some(J::Str(id)) = source.get("streamId") else {
            continue;
        };
        let id = lossy(id);
        let Some(size) = sizes.get(&id).copied() else {
            return Err(ReadError::Row("Invalid text stream"));
        };
        if streaming {
            ranges.push((id, (size - 8192).max(0), size));
        } else {
            ranges.push((id, 0, 8192.min(size)));
        }
    }
    Ok(ranges)
}

/// Everything one wire page or window reads, in a handful of statements whatever the page
/// holds. Bodies and chunks travel only for ids the loader reads whole; previews, stream
/// sizes and bytes only for ids it previews: the loader never pays for rows it cannot use.
pub(crate) struct WireData {
    pub(crate) bodies: HashMap<String, Candidate>,
    pub(crate) previews: HashMap<String, (String, Option<i64>)>,
    pub(crate) sizes: HashMap<String, i64>,
    pub(crate) bytes: HashMap<String, Vec<(i64, Vec<u8>)>>,
}

pub(crate) fn fetch_wire_data(
    conn: &Arc<Connection>,
    preview_ids: &[String],
    body_ids: &[String],
) -> Result<WireData> {
    let bodies = fetch_bodies(conn, body_ids)?;
    let previews = fetch_previews(conn, preview_ids)?;
    let sizes = fetch_stream_sizes(conn, preview_ids)?;
    let mut ranges = Vec::new();
    for id in preview_ids {
        if let Some((stored, _)) = previews.get(id)
            && let Ok(item) = parse_json(stored)
        {
            ranges.extend(source_ranges(&item, &sizes).unwrap_or_default());
        }
    }
    let bytes = fetch_stream_bytes(conn, &ranges)?;
    Ok(WireData {
        bodies,
        previews,
        sizes,
        bytes,
    })
}

pub(crate) fn map_size(sizes: &HashMap<String, i64>, stream: &str) -> Result<i64> {
    sizes
        .get(stream)
        .copied()
        .ok_or(ReadError::Row("Invalid text stream"))
}

pub(crate) fn map_slice(
    bytes: &HashMap<String, Vec<(i64, Vec<u8>)>>,
    stream: &str,
    start: i64,
    end: i64,
) -> Result<Vec<u16>> {
    if end <= start {
        return Ok(Vec::new());
    }
    match bytes.get(stream) {
        None => Ok(Vec::new()),
        Some(rows) => Ok(cut_slice(rows, start, end)),
    }
}

/// One page item from prefetched rows: text cut to its bounded preview, other bodies whole.
/// Rows stay cached: a retry after a budget failure reassembles the same item, as the loader's
/// own statements would.
pub(crate) fn assemble_candidate(
    data: &WireData,
    id: &str,
    kind: &str,
    trust: Trust,
    untrusted: &mut Vec<String>,
) -> Result<J> {
    if is_preview_kind(kind) {
        let Some((stored, created)) = data.previews.get(id) else {
            return Err(ReadError::Row("Missing item preview"));
        };
        let created = *created;
        let mut item = parse_json(stored)?;
        let body_trusted = trusted(trust, created.unwrap_or(i64::MIN));
        if !body_trusted && !untrusted.contains(&id.to_owned()) {
            untrusted.push(id.to_owned());
        }
        preview_fill(
            &mut item,
            body_trusted,
            &|stream| map_size(&data.sizes, stream),
            &|stream, start, end| map_slice(&data.bytes, stream, start, end),
        )?;
        return Ok(item);
    }
    let Some(candidate) = data.bodies.get(id) else {
        return Err(ReadError::UndefinedJson);
    };
    let Some((body, created)) = candidate.body.as_ref() else {
        return Err(ReadError::UndefinedJson);
    };
    let created = *created;
    let mut item = parse_json(body)?;
    with_chunks(&mut item, &candidate.chunks, trust)?;
    if !trusted(trust, created) && !untrusted.contains(&id.to_owned()) {
        untrusted.push(id.to_owned());
    }
    Ok(item)
}

/// The JSON length of an id, as the page budgets count it: its quotes, escapes and 64 bytes.
pub(crate) fn entry_overhead(id: &str) -> i64 {
    string_len(&encode_units(id)) as i64 + 64
}
