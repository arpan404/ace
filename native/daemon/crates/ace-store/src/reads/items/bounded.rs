// SPDX-License-Identifier: Apache-2.0
use super::cache::{WindowRead, wire_page_cached};
use super::decode::decoded_size;
use super::fetch::{assemble_candidate, fetch_wire_data, is_preview_kind};
use super::json::{J, encode_units, is_high, is_low, json_bytes, lossy, string_len};
use super::{ReadError, Result, cell, int, one, text, trusted};
use crate::Value;

/// The item without its verbatim provider payloads, the part that makes tool calls huge.
pub(crate) fn without_raw(item: &J) -> J {
    let mut slim = item.clone();
    let is_tool = item
        .get("type")
        .and_then(|kind| match kind {
            J::Str(units) => Some(lossy(units)),
            _ => None,
        })
        .as_deref()
        == Some("tool_call");
    if is_tool {
        if let Some(call) = slim.get_mut("call") {
            call.set("raw", J::Arr(Vec::new()));
        }
    } else if slim.get("raw").is_some() {
        slim.set("raw", J::Arr(Vec::new()));
    }
    slim
}

pub(crate) fn entry_bytes(value: &J, id: &[u16]) -> f64 {
    json_bytes(value) as f64 + string_len(id) as f64 + 64.0
}

pub(crate) fn item_summary(item: &J, seq: i64, bytes: i64, dropped: &str) -> J {
    let id = item.get("id").cloned().unwrap_or(J::Null);
    let kind = item.get("type").cloned().unwrap_or(J::Null);
    let mut summary = J::Obj(vec![
        (
            encode_units("itemId"),
            match id {
                J::Str(units) => J::Str(units),
                _ => J::Str(Vec::new()),
            },
        ),
        (encode_units("seq"), J::Num(seq.to_string())),
        (
            encode_units("type"),
            match kind {
                J::Str(units) => J::Str(units),
                _ => J::Str(Vec::new()),
            },
        ),
        (encode_units("bytes"), J::Num(bytes.to_string())),
        (encode_units("dropped"), J::Str(encode_units(dropped))),
    ]);
    if item
        .get("type")
        .and_then(|kind| match kind {
            J::Str(units) => Some(lossy(units)),
            _ => None,
        })
        .as_deref()
        == Some("tool_call")
    {
        let call_kind = item
            .get("call")
            .and_then(|call| call.get("kind"))
            .cloned()
            .unwrap_or(J::Null);
        // The title's first 200 characters, counting a surrogate pair (or a lone surrogate,
        // which the summary keeps verbatim) as one, exactly as the loader's slice does.
        let mut kept: Vec<u16> = Vec::new();
        let mut seen = 0usize;
        if let Some(J::Str(units)) = item.get("call").and_then(|call| call.get("title")) {
            let mut index = 0;
            while seen < 200 {
                let Some(unit) = units.get(index) else {
                    break;
                };
                kept.push(*unit);
                index += 1;
                seen += 1;
                if is_high(*unit)
                    && let Some(next) = units.get(index)
                    && is_low(*next)
                {
                    kept.push(*next);
                    index += 1;
                }
            }
        }
        if let J::Obj(entries) = &mut summary {
            entries.push((encode_units("kind"), call_kind));
            entries.push((encode_units("title"), J::Str(kept)));
        }
    }
    summary
}

/// Cut a string to `cap` units, naming what was left out. Never leaves half a pair.
pub(crate) fn cut_text(units: &[u16], cap: usize) -> Vec<u16> {
    if units.len() <= cap {
        return units.to_vec();
    }
    let mut end = cap;
    if end > 0 && is_high(units[end - 1]) {
        end -= 1;
    }
    let mut out = units[..end].to_vec();
    out.extend(encode_units(&format!(
        "… [{} more characters not shown]",
        units.len() - end
    )));
    out
}

pub(crate) fn clip_value(value: &J, cap: usize) -> J {
    match value {
        J::Str(units) => J::Str(cut_text(units, cap)),
        J::Arr(items) => J::Arr(items.iter().map(|item| clip_value(item, cap)).collect()),
        J::Obj(entries) => J::Obj(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), clip_value(value, cap)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

pub(crate) fn longest_text(value: &J) -> usize {
    match value {
        J::Str(units) => units.len(),
        J::Arr(items) => items.iter().map(longest_text).max().unwrap_or(0),
        J::Obj(entries) => entries
            .iter()
            .map(|(_, value)| longest_text(value))
            .max()
            .unwrap_or(0),
        _ => 0,
    }
}

/// The item with every long string cut to the longest length that fits `max_bytes` of JSON.
/// Only reached for an item that alone exceeds a page.
pub(crate) fn clip_item(item: &J, max_bytes: f64, decoded: bool) -> Option<J> {
    let measure = |value: &J| -> f64 {
        if decoded {
            decoded_size(value) as f64
        } else {
            json_bytes(value) as f64
        }
    };
    let floor = 256usize;
    let high = longest_text(item);
    if high <= floor || measure(&clip_value(item, floor)) > max_bytes {
        return None;
    }
    let (mut low, mut high) = (floor, high);
    while low < high {
        let middle = (low + high).div_ceil(2);
        if measure(&clip_value(item, middle)) <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let clipped = clip_value(item, low);
    if measure(&clipped) <= max_bytes {
        Some(clipped)
    } else {
        None
    }
}

pub(crate) fn item_id_units(item: &J) -> Vec<u16> {
    item.get("id")
        .and_then(|id| match id {
            J::Str(units) => Some(units.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

pub(crate) struct FillOut {
    pub(crate) items: Vec<J>,
    pub(crate) seqs: Vec<(String, i64)>,
    pub(crate) omitted: Vec<J>,
}

pub(crate) fn fill_stop() -> FillOut {
    FillOut {
        items: Vec::new(),
        seqs: Vec::new(),
        omitted: Vec::new(),
    }
}

/// A bounded page: one oversized item never fails it. The item is shown without its raw
/// payloads, then with its long strings cut, and only if neither fits is it summarized.
pub(crate) fn fill(
    read: &mut WindowRead,
    before: f64,
    limit: f64,
    budget: f64,
    full: f64,
) -> Result<FillOut> {
    if budget < full && budget <= 512.0 {
        return Ok(fill_stop());
    }
    match wire_page_cached(read, before, limit, budget) {
        Ok(out) => Ok(FillOut {
            items: out.items,
            seqs: out.seqs,
            omitted: Vec::new(),
        }),
        Err(ReadError::Capacity) => {
            if budget < full {
                return Ok(fill_stop());
            }
            let Some((item, seq)) = newest_before(read, before)? else {
                return Err(ReadError::Capacity);
            };
            // The candidate is measured as decoded when the shell will decode it: the budget
            // is the JSON the client gets, whether it fits whole, cut, or only summarized.
            let decoded = !trusted(read.trust, seq);
            let measure = |value: &J| -> f64 {
                if decoded {
                    decoded_size(value) as f64
                } else {
                    json_bytes(value) as f64
                }
            };
            let bytes = measure(&item);
            let marker = json_bytes(&item_summary(&item, seq, bytes as i64, "item")) as f64 + 1.0;
            let room = budget - 512.0 - marker;
            let slim = without_raw(&item);
            let id = item_id_units(&item);
            let entry = |value: &J| measure(value) + string_len(&id) as f64 + 64.0;
            let dropped = read.drop_reduced.contains(&seq);
            let clipped = if dropped || entry(&slim) <= room {
                None
            } else {
                clip_item(
                    &slim,
                    room - entry_bytes(&J::Str(Vec::new()), &id) + 2.0,
                    decoded,
                )
            };
            let shown = if dropped {
                None
            } else {
                clipped.clone().or_else(|| {
                    if entry(&slim) <= room {
                        Some(slim.clone())
                    } else {
                        None
                    }
                })
            };
            // A clipped item shows only if the schema still accepts it cut down; the shell
            // checks that and has a dropped sequence re-read without it.
            if clipped.is_some() && shown.is_some() {
                read.validate.push(lossy(&id));
            }
            let omission = item_summary(
                &item,
                seq,
                bytes as i64,
                if clipped.is_some() {
                    "text"
                } else if shown.is_some() {
                    "raw"
                } else {
                    "item"
                },
            );
            let used = shown.as_ref().map_or(0.0, entry) + marker;
            let mut rest = if limit > 1.0 {
                fill(read, seq as f64, limit - 1.0, budget - used, full)?
            } else {
                fill_stop()
            };
            if let Some(shown) = shown {
                rest.items.push(shown);
                rest.seqs.push((lossy(&id), seq));
            }
            rest.omitted.push(omission);
            Ok(rest)
        }
        Err(error) => Err(error),
    }
}

/// The newest item created before `before`, as a page shows it, with its creation cursor.
pub(crate) fn newest_before(read: &mut WindowRead, before: f64) -> Result<Option<(J, i64)>> {
    let row = one(
        read.conn,
        "SELECT id, created_seq, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT 1",
        &[Value::Text(read.thread_id.to_owned()), Value::Real(before)],
    )?;
    let Some(row) = row else {
        return Ok(None);
    };
    let id = text(cell(&row, 0)?)?.to_owned();
    let seq = int(cell(&row, 1)?)?;
    let kind = text(cell(&row, 2)?)?.to_owned();
    if id.is_empty()
        || !(1..=9_007_199_254_740_991i64).contains(&seq)
        || kind.is_empty()
        || encode_units(&kind).len() > 64
    {
        return Err(ReadError::Row("Invalid item page"));
    }
    if !read.cache.bodies.contains_key(&id) && !read.cache.previews.contains_key(&id) {
        let (preview, body) = if is_preview_kind(&kind) {
            (std::slice::from_ref(&id), &[][..])
        } else {
            (&[][..], std::slice::from_ref(&id))
        };
        let more = fetch_wire_data(read.conn, preview, body)?;
        for (held, candidate) in more.bodies {
            read.cache.bodies.insert(held, candidate);
        }
        for (held, preview) in more.previews {
            read.cache.previews.insert(held, preview);
        }
        for (held, size) in more.sizes {
            read.cache.sizes.insert(held, size);
        }
        for (held, rows) in more.bytes {
            read.cache.bytes.entry(held).or_default().extend(rows);
        }
    }
    Ok(Some((
        assemble_candidate(&*read.cache, &id, &kind, read.trust, read.untrusted)?,
        seq,
    )))
}

/// A window's reduced page: the item at `seq` bounded to a share of the window.
pub(crate) fn reduced_page(read: &mut WindowRead, seq: i64, byte_limit: f64) -> Result<FillOut> {
    fill(read, seq as f64 + 1.0, 1.0, byte_limit, byte_limit)
}

/// Whether the item at `seq` fits a window of its own.
pub(crate) fn fits_alone(read: &mut WindowRead, seq: i64, byte_limit: f64) -> Result<bool> {
    match wire_page_cached(read, seq as f64 + 1.0, 1.0, byte_limit) {
        Ok(_) => Ok(true),
        Err(ReadError::Capacity) => Ok(false),
        Err(error) => Err(error),
    }
}
