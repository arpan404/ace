// SPDX-License-Identifier: Apache-2.0
use super::chunks::chunk_append;
use super::json::{J, is_low, lossy};
use super::parse::{parse_error, parse_json};
use super::{ReadError, Result, Trust, all, cell, int, one, opt_int, text, trusted};
use crate::{Connection, Value};
use std::sync::Arc;

/// A stream's size lookup and a byte-range read, over the connection or prefetched rows.
pub(crate) type SizeFn<'a> = &'a dyn Fn(&str) -> Result<i64>;

pub(crate) type SliceFn<'a> = &'a dyn Fn(&str, i64, i64) -> Result<Vec<u16>>;

/// A stored preview, trusted by its item's creation sequence like the item body.
pub(crate) fn preview_row(
    conn: &Arc<Connection>,
    id: &str,
) -> Result<Option<(String, Option<i64>)>> {
    let row = one(
        conn,
        "SELECT p.item, i.created_seq FROM item_previews p LEFT JOIN items i ON i.id = p.id WHERE p.id = ?",
        &[Value::Text(id.to_owned())],
    )?;
    match row.as_deref() {
        None => Ok(None),
        Some([item, created]) => Ok(Some((text(item)?.to_owned(), opt_int(created)?))),
        _ => Err(ReadError::Row("Invalid stored item")),
    }
}

/// The stream's whole length now, which the stored descriptor may trail.
pub(crate) fn stream_size(conn: &Arc<Connection>, stream_id: &str) -> Result<i64> {
    let row = one(
        conn,
        "SELECT size FROM item_text_streams WHERE id = ?",
        &[Value::Text(stream_id.to_owned())],
    )?;
    match row.as_deref() {
        Some([size]) => {
            let size = int(size)?;
            if (0..=9_007_199_254_740_991i64).contains(&size) {
                Ok(size)
            } else {
                Err(ReadError::Row("Invalid text stream"))
            }
        }
        _ => Err(ReadError::Row("Invalid text stream")),
    }
}

/// Byte rows already read, cut to `[start, end)` and decoded as UTF-16LE.
pub(crate) fn cut_slice(rows: &[(i64, Vec<u8>)], start: i64, end: i64) -> Vec<u16> {
    let mut bytes = Vec::new();
    for (offset, chunk) in rows {
        let from = (start - offset).max(0).min(chunk.len() as i64);
        let to = (end - offset).max(0).min(chunk.len() as i64);
        if to > from {
            bytes.extend_from_slice(&chunk[from as usize..to as usize]);
        }
    }
    // Whole units only; a trailing odd byte is left off, as the decoder does.
    let mut units = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 2 <= bytes.len() {
        units.push(u16::from_le_bytes([bytes[index], bytes[index + 1]]));
        index += 2;
    }
    units
}

/// The text in bytes `[start, end)` of a stream, read from the chunks that hold it.
pub(crate) fn stream_slice(
    conn: &Arc<Connection>,
    stream_id: &str,
    start: i64,
    end: i64,
) -> Result<Vec<u16>> {
    if end <= start {
        return Ok(Vec::new());
    }
    let rows = all(
        conn,
        "SELECT offset, bytes FROM item_source_chunks WHERE stream_id = ? AND offset > ? AND offset < ? ORDER BY offset",
        &[
            Value::Text(stream_id.to_owned()),
            Value::Integer(start.saturating_sub(65536)),
            Value::Integer(end),
        ],
    )?;
    let mut chunks = Vec::new();
    for row in &rows {
        let offset = int(cell(row, 0)?)?;
        let Value::Blob(bytes) = cell(row, 1)? else {
            return Err(ReadError::Row("Invalid text chunk"));
        };
        chunks.push((offset, bytes.clone()));
    }
    Ok(cut_slice(&chunks, start, end))
}

/// The stream's first `units`: the preview of finished text, read from the top.
pub(crate) fn stream_head(
    source: &mut J,
    stream_id: &str,
    units: i64,
    size: i64,
    slice: SliceFn<'_>,
) -> Result<Vec<u16>> {
    source.set("bytes", J::Num(size.to_string()));
    source.remove("offset");
    slice(stream_id, 0, (units * 2).min(size))
}

/// The stream's last `units`, marked with where they start. Never starts in a surrogate pair.
pub(crate) fn stream_tail(
    source: &mut J,
    stream_id: &str,
    units: i64,
    size: i64,
    slice: SliceFn<'_>,
) -> Result<Vec<u16>> {
    let mut start = (size - units * 2).max(0);
    let mut text = slice(stream_id, start, size)?;
    if text.first().is_some_and(|first| is_low(*first)) {
        text.remove(0);
        start += 2;
    }
    source.set("bytes", J::Num(size.to_string()));
    if start > 0 {
        source.set("offset", J::Num(start.to_string()));
    } else {
        source.remove("offset");
    }
    Ok(text)
}

/// Fill one text source's carried text, from the head or the tail like the reader does.
pub(crate) fn fill_source(
    item: &mut J,
    streaming: bool,
    remaining: i64,
    size_of: SizeFn<'_>,
    slice: SliceFn<'_>,
) -> Result<i64> {
    let source_id = item
        .get("source")
        .and_then(|source| source.get("streamId"))
        .and_then(|id| match id {
            J::Str(units) => Some(lossy(units)),
            _ => None,
        });
    let Some(stream_id) = source_id else {
        return Ok(remaining);
    };
    let size = size_of(&stream_id)?;
    let text = {
        let Some(source) = item.get_mut("source") else {
            return Ok(remaining);
        };
        if streaming {
            stream_tail(source, &stream_id, remaining, size, slice)?
        } else {
            stream_head(source, &stream_id, remaining, size, slice)?
        }
    };
    let used = text.len() as i64;
    let Some(target) = item.get_mut("text") else {
        return Err(parse_error());
    };
    *target = J::Str(text);
    Ok(remaining - used)
}

/// An item's chunks in sequence order: each row's sequence, field and decoded append.
pub(crate) fn item_chunks(
    conn: &Arc<Connection>,
    id: &str,
) -> Result<Vec<(i64, String, Vec<u16>)>> {
    let rows = all(
        conn,
        "SELECT seq, field, append FROM item_text_chunks WHERE item_id = ? ORDER BY seq",
        &[Value::Text(id.to_owned())],
    )?;
    rows.iter()
        .map(|row| {
            let seq = int(cell(row, 0)?)?;
            let field = text(cell(row, 1)?)?.to_owned();
            let append = chunk_append(text(cell(row, 2)?)?)?;
            Ok((seq, field, append))
        })
        .collect()
}

/// A parsed preview with its stream text filled, as `ItemTextStore.read` gives it.
pub(crate) fn preview_fill(item: &mut J, size_of: SizeFn<'_>, slice: SliceFn<'_>) -> Result<()> {
    // Absent `complete` reads finished: the schema defaults it to true.
    let complete = match item.get("complete") {
        None => true,
        Some(J::Bool(done)) => *done,
        Some(_) => return Err(ReadError::Row("Invalid stored item")),
    };
    let streaming = !complete;
    let mut remaining = 4096i64;
    let kind = item
        .get("type")
        .and_then(|kind| match kind {
            J::Str(units) => Some(lossy(units)),
            _ => None,
        })
        .ok_or_else(parse_error)?;
    if kind == "message" {
        let order: Vec<usize> = match item.get("parts") {
            Some(J::Arr(parts)) => {
                let mut order: Vec<usize> = (0..parts.len()).collect();
                if streaming {
                    order.reverse();
                }
                order
            }
            _ => return Err(parse_error()),
        };
        for index in order {
            let fill = match item.get("parts") {
                Some(J::Arr(parts)) => parts.get(index).is_some_and(|part| {
                    part.get("type").and_then(|kind| match kind {
                        J::Str(units) => Some(lossy(units)),
                        _ => None,
                    }) == Some("text".to_owned())
                        && part.get("source").is_some()
                }),
                _ => false,
            };
            if !fill {
                continue;
            }
            let Some(J::Arr(parts)) = item.get_mut("parts") else {
                return Err(parse_error());
            };
            let Some(part) = parts.get_mut(index) else {
                return Err(parse_error());
            };
            remaining = fill_source(part, streaming, remaining, size_of, slice)?;
        }
    } else if kind == "reasoning" || kind == "notice" {
        if item.get("source").is_some() {
            remaining = fill_source(item, streaming, remaining, size_of, slice)?;
        }
        let _ = remaining;
    }
    Ok(())
}

/// A stored preview with its stream text filled, as `ItemTextStore.read` gives it.
pub(crate) fn read_preview(
    conn: &Arc<Connection>,
    id: &str,
    trust: Trust,
    untrusted: &mut Vec<String>,
) -> Result<J> {
    let Some((stored, created)) = preview_row(conn, id)? else {
        return Err(ReadError::Row("Missing item preview"));
    };
    let mut item = parse_json(&stored)?;
    if !trusted(trust, created.unwrap_or(i64::MIN)) {
        untrusted.push(id.to_owned());
    }
    preview_fill(
        &mut item,
        &|stream| stream_size(conn, stream),
        &|stream, start, end| stream_slice(conn, stream, start, end),
    )?;
    Ok(item)
}
