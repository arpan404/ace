// SPDX-License-Identifier: Apache-2.0
//! Phase 1b, the bounded page: `bounded-item-page.ts` and `item-clip.ts`. A page that never
//! fails on one oversized item. The store refuses to start a page with an item larger than the
//! page; here that item is shown without its raw payloads, then with its long strings cut to
//! fit, and only if neither fits is it left to its summary. Every such item is listed in
//! `omitted`, and paging continues past it.
//!
//! The source (`ItemPageSource`) is the shell's: the `item_heads`/`items` query, its newest
//! item and whether anything is older. This module owns the shaping, the budgets and the
//! JavaScript string lengths (rule 17).

use ace_json::{Array, JsString, Map, Number, Value};

/// The envelope bytes every store page reserves for itself.
pub const ENVELOPE: usize = 512;
/// Strings at most this long are never cut (`item-clip.ts`'s floor), so ids, kinds, statuses
/// and paths stay whole.
pub const CLIP_FLOOR: usize = 256;

/// Why a page could not be read: the newest item alone exceeds the budget, a row a page needs
/// is missing, or the store failed. Only a capacity report is recoverable by the bounded page;
/// the rest fail the read, as the TypeScript throws out of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageError {
    /// One item is larger than a whole page's byte budget, so no page can start with it.
    Capacity,
    /// A page's item has no body (or preview) row.
    MissingItem,
    /// The store could not answer.
    Store(String),
}

/// What a bounded page reads from: a store page and the single item it could not start with.
pub trait ItemPageSource {
    /// `page(before, limit, byteLimit)`: the page, or [`ItemPageCapacityExceeded`] when the
    /// newest item before `before` alone exceeds it.
    fn page(&self, before: u64, limit: usize, byte_limit: usize) -> Result<PageRows, PageError>;
    /// `newestBefore(before)`: the newest item before the cursor, with its sequence.
    fn newest_before(&self, before: u64) -> Option<(Value, u64)>;
    /// `hasItemBefore(before)`.
    fn has_item_before(&self, before: u64) -> bool;
}

/// What a store page returns (`ItemsPage` without `seq` and `threadId`).
#[derive(Debug, Clone, PartialEq)]
pub struct PageRows {
    pub items: Vec<Value>,
    pub item_seqs: Map,
    pub items_before: Option<u64>,
}

/// `Buffer.byteLength(JSON.stringify(value))`.
pub fn json_bytes(value: &Value) -> usize {
    ace_json::to_string(value).len()
}

/// `entryBytes(value, id)`: the JSON, the id, and the row's own share.
pub fn entry_bytes(value: &Value, id: &str) -> usize {
    json_bytes(value) + json_bytes(&Value::String(JsString::from(id))) + 64
}

/// `withoutRaw(item)`: the item without its verbatim provider payloads, the part that makes
/// tool calls huge.
pub fn without_raw(item: &Value) -> Value {
    let Value::Object(map) = item else {
        return item.clone();
    };
    if map.get("type").and_then(|kind| match kind {
        Value::String(kind) => Some(kind.as_str()),
        _ => None,
    }) == Some("tool_call")
        && let Some(Value::Object(call)) = map.get("call")
    {
        let mut copy = map.clone();
        let mut call = call.clone();
        call.insert("raw", Value::Array(Array::new()));
        copy.insert("call", Value::Object(call));
        return Value::Object(copy);
    }
    if map.contains_key("raw") {
        let mut copy = map.clone();
        copy.insert("raw", Value::Array(Array::new()));
        return Value::Object(copy);
    }
    item.clone()
}

/// `summary(item, seq, bytes, dropped)`: an item left out of the page, named so a client can
/// page past it.
pub fn summary(item: &Value, seq: u64, bytes: usize, dropped: &str) -> Value {
    let Value::Object(map) = item else {
        return item.clone();
    };
    let mut out = Map::with_capacity(7);
    if let Some(id) = map.get("id") {
        out.insert("itemId", id.clone());
    }
    out.insert("seq", Value::Number(Number::from(seq)));
    if let Some(kind) = map.get("type") {
        out.insert("type", kind.clone());
    }
    out.insert("bytes", Value::Number(Number::from(bytes as u64)));
    out.insert("dropped", Value::String(JsString::from(dropped)));
    if map.get("type").and_then(|kind| match kind {
        Value::String(kind) => Some(kind.as_str()),
        _ => None,
    }) == Some("tool_call")
        && let Some(Value::Object(call)) = map.get("call")
    {
        if let Some(kind) = call.get("kind") {
            out.insert("kind", kind.clone());
        }
        if let Some(Value::String(title)) = call.get("title") {
            // `Array.from(title).slice(0, 200).join("")`: 200 code points, not units.
            let shown: String = title.as_str().chars().take(200).collect();
            out.insert("title", Value::String(JsString::from(shown)));
        }
    }
    Value::Object(out)
}

/// `boundedItemPage(source, threadId, before, limit, byteLimit)` without the message's `seq`.
pub fn bounded_item_page(
    source: &dyn ItemPageSource,
    thread_id: &str,
    before: u64,
    limit: usize,
    byte_limit: usize,
) -> Result<Value, PageError> {
    let parts = fill(
        source,
        before,
        limit,
        byte_limit as isize,
        byte_limit as isize,
    )?;
    let mut out = Map::with_capacity(5);
    out.insert("threadId", Value::String(JsString::from(thread_id)));
    out.insert("items", Value::Array(parts.items.into()));
    out.insert("itemSeqs", Value::Object(parts.item_seqs));
    out.insert(
        "itemsBefore",
        match parts.items_before {
            Some(before) => Value::Number(Number::from(before)),
            None => Value::Null,
        },
    );
    if !parts.omitted.is_empty() {
        out.insert("omitted", Value::Array(parts.omitted.into()));
    }
    Ok(Value::Object(out))
}

struct Parts {
    items: Vec<Value>,
    item_seqs: Map,
    omitted: Vec<Value>,
    items_before: Option<u64>,
}

fn stop(source: &dyn ItemPageSource, before: u64) -> Parts {
    Parts {
        items: Vec::new(),
        item_seqs: Map::new(),
        omitted: Vec::new(),
        items_before: source.has_item_before(before).then_some(before),
    }
}

fn fill(
    source: &dyn ItemPageSource,
    before: u64,
    limit: usize,
    budget: isize,
    full: isize,
) -> Result<Parts, PageError> {
    // Newer entries spent part of this page: the next page starts here with the whole budget.
    if budget < full && budget <= ENVELOPE as isize {
        return Ok(stop(source, before));
    }
    match source.page(before, limit, budget.max(0) as usize) {
        Ok(page) => {
            return Ok(Parts {
                items: page.items,
                item_seqs: page.item_seqs,
                omitted: Vec::new(),
                items_before: page.items_before,
            });
        }
        Err(PageError::Capacity) => {
            if budget < full {
                return Ok(stop(source, before));
            }
        }
        Err(other) => return Err(other),
    }
    let Some((item, seq)) = source.newest_before(before) else {
        return Ok(stop(source, before));
    };
    let bytes = json_bytes(&item);
    let marker = json_bytes(&summary(&item, seq, bytes, "item")) + 1;
    let room = budget - ENVELOPE as isize - marker as isize;
    let slim = without_raw(&item);
    let Some(Value::String(id)) = item.get("id") else {
        return Ok(stop(source, before));
    };
    let clipped = if entry_bytes(&slim, id.as_str()) as isize <= room {
        None
    } else {
        clip_item(
            &slim,
            room - entry_bytes(&Value::String(JsString::new()), id.as_str()) as isize + 2,
        )
    };
    let shown = match clipped.as_ref() {
        Some(clipped) => Some(clipped.clone()),
        None => {
            if (entry_bytes(&slim, id.as_str()) as isize) <= room {
                Some(slim)
            } else {
                None
            }
        }
    };
    let dropped = if clipped.is_some() {
        "text"
    } else if shown.is_some() {
        "raw"
    } else {
        "item"
    };
    let omission = summary(&item, seq, bytes, dropped);
    let used = shown
        .as_ref()
        .map_or(0, |shown| entry_bytes(shown, id.as_str()))
        + marker;
    let rest = if limit > 1 {
        fill(source, seq, limit - 1, budget - used as isize, full)?
    } else {
        Parts {
            items: Vec::new(),
            item_seqs: Map::new(),
            omitted: Vec::new(),
            items_before: source.has_item_before(seq).then_some(seq),
        }
    };
    let mut items = rest.items;
    let mut item_seqs = rest.item_seqs;
    if let Some(shown) = shown {
        items.push(shown);
        item_seqs.insert(id.as_str(), Value::Number(Number::from(seq)));
    }
    let mut omitted = rest.omitted;
    omitted.push(omission);
    Ok(Parts {
        items,
        item_seqs,
        omitted,
        items_before: rest.items_before,
    })
}

/// `clipItem(item, maxBytes)`: the item with every long string cut to the longest length that
/// fits, each cut saying how much it left out, or `None` when even the shortest cut does not
/// fit.
pub fn clip_item(item: &Value, max_bytes: isize) -> Option<Value> {
    let high = longest(item);
    if high <= CLIP_FLOOR || json_bytes(&clip_value(item, CLIP_FLOOR)) as isize > max_bytes {
        return None;
    }
    let mut low = CLIP_FLOOR;
    let mut high = high;
    while low < high {
        let middle = (low + high).div_ceil(2);
        if json_bytes(&clip_value(item, middle)) as isize <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let clipped = clip_value(item, low);
    if json_bytes(&clipped) as isize > max_bytes {
        return None;
    }
    Some(clipped)
}

/// `cut(text, cap)`: JavaScript's UTF-16 slice, never leaving half a surrogate pair.
fn cut(text: &JsString, cap: usize) -> JsString {
    if text.len_utf16() <= cap {
        return text.clone();
    }
    let mut end = cap;
    let units: Vec<u16> = text.units().collect();
    let last = units.get(end.saturating_sub(1)).copied().unwrap_or(0);
    if (0xd800..=0xdbff).contains(&last) {
        end = end.saturating_sub(1);
    }
    let kept = JsString::from_units(&units[..end.min(units.len())]);
    let left = text.len_utf16() - end;
    JsString::from(format!(
        "{}… [{left} more characters not shown]",
        kept.as_str()
    ))
}

fn clip_value(value: &Value, cap: usize) -> Value {
    match value {
        Value::String(text) => Value::String(cut(text, cap)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| clip_value(item, cap))
                .collect::<Vec<_>>()
                .into(),
        ),
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, entry) in map {
                out.insert(key.clone(), clip_value(entry, cap));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// `longest(value)`: the longest string, in UTF-16 units.
fn longest(value: &Value) -> usize {
    match value {
        Value::String(text) => text.len_utf16(),
        Value::Array(items) => items.iter().map(longest).max().unwrap_or(0),
        Value::Object(map) => map
            .iter()
            .map(|(_, entry)| longest(entry))
            .max()
            .unwrap_or(0),
        _ => 0,
    }
}
