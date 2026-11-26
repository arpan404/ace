// SPDX-License-Identifier: Apache-2.0
//! `transition-history.ts` and `fork-history.ts` (E5.9): the fork boundary a transition starts
//! from, the bounded handoff it carries, and the copies a fork opens with. The historical reads
//! are `history-index.ts`'s (`count`, `completion`, `opening`, `page`, `newestBefore`,
//! `hasItemBefore`, `readStream`), as of one `through` sequence, with the previews
//! `HistoryIndex.preview` fills from the frozen text streams.
//!
//! Cases ported from `historical-streams.test.ts`, `historical-handoff.process.test.ts`,
//! `context-handoff.process.test.ts`, `fork-transcript.process.test.ts`,
//! `thread-fork.process.test.ts` and `thread-merge-account.process.test.ts`; each is named in
//! the tests below.

use std::collections::HashMap;
use std::sync::Arc;

use ace_core::item_model::ContentPart;
use ace_core::items::Item;
use ace_json::{JsString, Value};
use ace_store::{Connection, Value as Cell, stmt_cache};

use crate::transitions::handoff::{self, HandoffSource, PortableHandoff};
use crate::transitions::readiness;
use crate::{EngineError, EngineStore, State};

const COUNT: &str = "SELECT ordinal FROM history_items WHERE thread_id=? AND created_seq<=? ORDER BY created_seq DESC LIMIT 1";
const COMPLETION: &str = "SELECT r.seq,r.item FROM history_item_revisions r JOIN history_items h ON h.id=r.item_id WHERE h.thread_id=? AND h.id=? AND json_extract(r.item,'$.complete')=1 ORDER BY r.seq LIMIT 1";
const ITEM_AT: &str = "SELECT seq,item FROM history_item_revisions WHERE item_id=? AND seq<=? ORDER BY seq DESC LIMIT 1";
const OPENING: &str = "SELECT id FROM history_items WHERE thread_id=? AND created_seq<=? ORDER BY created_seq ASC LIMIT ?";
const NEWEST: &str = "SELECT id,created_seq FROM history_items WHERE thread_id=? AND created_seq<=? AND created_seq<? ORDER BY created_seq DESC LIMIT 1";
const HAS_ITEM: &str = "SELECT 1 AS found FROM history_items WHERE thread_id=? AND created_seq<=? AND created_seq<? LIMIT 1";
const PAGE: &str = "SELECT id,created_seq FROM history_items WHERE thread_id=? AND created_seq<=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?";
const VERSION: &str =
    "SELECT * FROM history_stream_versions WHERE stream_id=? AND seq<=? ORDER BY seq DESC LIMIT 1";
const OUTPUT: &str = "SELECT size FROM output_streams WHERE id=?";
const TEXT: &str = "SELECT size FROM item_text_streams WHERE id=?";
const PREDECESSOR_OUTPUT: &str =
    "SELECT offset FROM output_chunks WHERE stream_id=? AND offset<=? ORDER BY offset DESC LIMIT 1";
const PREDECESSOR_TEXT: &str = "SELECT offset FROM item_source_chunks WHERE stream_id=? AND offset<=? ORDER BY offset DESC LIMIT 1";
const CHUNKS_OUTPUT: &str = "SELECT offset,bytes FROM output_chunks WHERE stream_id=? AND offset>=? AND offset<? ORDER BY offset";
const CHUNKS_TEXT: &str = "SELECT offset,bytes FROM item_source_chunks WHERE stream_id=? AND offset>=? AND offset<? ORDER BY offset";
const MESSAGES: &str = "SELECT created_seq FROM item_heads WHERE thread_id=? AND agent_id=? AND created_seq<=? AND item_type='message' ORDER BY created_seq DESC LIMIT ?";
const CITED: &str = "SELECT json_extract(item,'$.inherited') IS NOT NULL AS inherited FROM items WHERE thread_id=? AND id=?";

const PAGE_BASE: i64 = 512;
const ITEM_OVERHEAD: i64 = 64;
/// The preview's text budget, in UTF-16 units (`history-index.ts:350`).
const PREVIEW_UNITS: i64 = 4096;
/// The newest messages a fork copies (`fork-history.ts:9`).
pub const MAX_INHERITED_MESSAGES: usize = 200;
/// A copied message keeps this much text (`fork-history.ts:11`).
pub const MAX_INHERITED_TEXT_BYTES: i64 = 64 * 1024;
const INHERITED_PAGE_BYTES: i64 = 1024 * 1024;
/// The machine and switch handoffs carry about 8k tokens (`transition-history.ts:30`).
pub const SWITCH_HANDOFF_BYTES: i64 = 32768;

/// One stream version frozen as of a sequence (`history-index.ts:20`).
#[derive(Debug, Clone, PartialEq)]
pub struct Version {
    pub stream_id: String,
    pub thread_id: String,
    pub item_id: String,
    pub seq: i64,
    pub size: i64,
    pub encoding: String,
}

/// One frozen stream read (`history-index.ts:336`).
#[derive(Debug, Clone, PartialEq)]
pub struct StreamRead {
    pub bytes: Vec<u8>,
    pub next_offset: i64,
    pub eof: bool,
    pub encoding: String,
}

/// One historical page (`history-index.ts:429`), oldest first.
#[derive(Debug, Clone, Default)]
pub struct Page {
    pub items: Vec<Item>,
    pub item_seqs: HashMap<String, i64>,
    pub items_before: Option<i64>,
}

fn records(what: &str) -> EngineError {
    EngineError::Records(what.to_owned())
}

fn text(row: &stmt_cache::Row, column: &str) -> Option<String> {
    row.get(column)
        .and_then(crate::repository::residency::cell_text)
        .map(str::to_owned)
}

fn integer(row: &stmt_cache::Row, column: &str) -> i64 {
    row.get(column)
        .and_then(crate::repository::residency::cell_int)
        .unwrap_or(0)
}

fn item(value: &str) -> Result<Item, EngineError> {
    let parsed = ace_json::parse(value).map_err(|error| EngineError::Records(error.to_string()))?;
    ace_json::from_value(&parsed).map_err(|error| EngineError::Records(error.to_string()))
}

/// `history-index.ts:164`: the newest version of `stream` at or before `through`.
pub fn latest(
    conn: &Arc<Connection>,
    stream: &str,
    through: i64,
) -> Result<Option<Version>, EngineError> {
    let Some(row) = stmt_cache::get_row(
        conn,
        VERSION,
        vec![Cell::Text(stream.to_owned()), Cell::Integer(through)],
    )?
    else {
        return Ok(None);
    };
    Ok(Some(Version {
        stream_id: text(&row, "stream_id").unwrap_or_default(),
        thread_id: text(&row, "thread_id").unwrap_or_default(),
        item_id: text(&row, "item_id").unwrap_or_default(),
        seq: integer(&row, "seq"),
        size: integer(&row, "size"),
        encoding: text(&row, "encoding").unwrap_or_default(),
    }))
}

/// One frozen stream of the thread (`history-index.ts:330`).
fn frozen_stream(
    conn: &Arc<Connection>,
    thread: &str,
    stream: &str,
    through: i64,
) -> Result<Version, EngineError> {
    let Some(version) = latest(conn, stream, through)? else {
        return Err(records("Stream is outside historical scope"));
    };
    if version.thread_id != thread {
        return Err(records("Stream is outside historical scope"));
    }
    Ok(version)
}

/// The bytes `[offset, offset+limit)` of a stream's chunks (`payload-store.ts:363`), from the
/// output table for shell output (UTF-8) or the item text table (UTF-16LE).
fn read_bytes(
    conn: &Arc<Connection>,
    stream: &str,
    offset: i64,
    limit: i64,
) -> Result<Vec<u8>, EngineError> {
    let output = stmt_cache::get_row(conn, OUTPUT, vec![Cell::Text(stream.to_owned())])?
        .map(|row| integer(&row, "size"));
    let size = match output {
        Some(size) => Some(size),
        None => stmt_cache::get_row(conn, TEXT, vec![Cell::Text(stream.to_owned())])?
            .map(|row| integer(&row, "size")),
    };
    let Some(size) = size else {
        return Err(records("Unknown output stream"));
    };
    if offset >= size {
        return Ok(Vec::new());
    }
    let end = (offset + limit).min(size);
    let (predecessor_sql, chunks_sql) = if output.is_some() {
        (PREDECESSOR_OUTPUT, CHUNKS_OUTPUT)
    } else {
        (PREDECESSOR_TEXT, CHUNKS_TEXT)
    };
    let predecessor = stmt_cache::get_row(
        conn,
        predecessor_sql,
        vec![Cell::Text(stream.to_owned()), Cell::Integer(offset)],
    )?
    .map(|row| integer(&row, "offset"));
    let start = predecessor.unwrap_or(offset);
    let rows = stmt_cache::all_rows(
        conn,
        chunks_sql,
        vec![
            Cell::Text(stream.to_owned()),
            Cell::Integer(start),
            Cell::Integer(end),
        ],
    )?;
    let mut bytes = Vec::new();
    for row in rows {
        let Some(chunk) = row.get("bytes").and_then(|cell| match cell {
            Cell::Blob(bytes) => Some(bytes),
            _ => None,
        }) else {
            return Err(records("Invalid output chunk"));
        };
        let at = integer(&row, "offset");
        let from = usize::try_from((offset - at).max(0)).unwrap_or(0);
        let to = usize::try_from((end - at).min(chunk.len() as i64)).unwrap_or(0);
        if to > from {
            bytes.extend_from_slice(&chunk[from..to]);
        }
    }
    Ok(bytes)
}

/// `history-index.ts:336`: a bounded prefix of a frozen stream.
pub fn read_stream(
    conn: &Arc<Connection>,
    thread: &str,
    stream: &str,
    through: i64,
    offset: i64,
    limit: i64,
) -> Result<StreamRead, EngineError> {
    if through < 0 || offset < 0 || !(1..=256 * 1024).contains(&limit) {
        return Err(records("Invalid stream range"));
    }
    let version = frozen_stream(conn, thread, stream, through)?;
    let remaining = (version.size - offset).max(0);
    if remaining == 0 {
        return Ok(StreamRead {
            bytes: Vec::new(),
            next_offset: offset,
            eof: true,
            encoding: version.encoding,
        });
    }
    let want = limit.min(remaining);
    let bytes = read_bytes(conn, stream, offset, want)?;
    if bytes.len() as i64 != want {
        return Err(records("Historical stream prefix is unavailable"));
    }
    let next_offset = offset + bytes.len() as i64;
    Ok(StreamRead {
        bytes,
        next_offset,
        eof: next_offset >= version.size,
        encoding: version.encoding,
    })
}

fn decode_utf16le(bytes: &[u8]) -> JsString {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    JsString::from_units(&units)
}

/// `history-index.ts:312`: the thread's items through `through`.
pub fn item_count(conn: &Arc<Connection>, thread: &str, through: i64) -> Result<i64, EngineError> {
    Ok(stmt_cache::get_row(
        conn,
        COUNT,
        vec![Cell::Text(thread.to_owned()), Cell::Integer(through)],
    )?
    .map(|row| integer(&row, "ordinal"))
    .unwrap_or(0))
}

/// `history-index.ts:177`: one item as it read at `through`.
fn item_at(conn: &Arc<Connection>, id: &str, through: i64) -> Result<Option<Item>, EngineError> {
    let Some(row) = stmt_cache::get_row(
        conn,
        ITEM_AT,
        vec![Cell::Text(id.to_owned()), Cell::Integer(through)],
    )?
    else {
        return Ok(None);
    };
    text(&row, "item").map(|stored| item(&stored)).transpose()
}

/// `history-index.ts:319`: where an item first read complete.
pub fn completion(
    conn: &Arc<Connection>,
    thread: &str,
    item_id: &str,
) -> Result<(i64, Item), EngineError> {
    let Some(row) = stmt_cache::get_row(
        conn,
        COMPLETION,
        vec![
            Cell::Text(thread.to_owned()),
            Cell::Text(item_id.to_owned()),
        ],
    )?
    else {
        return Err(records("Item completion boundary is unavailable"));
    };
    let item = text(&row, "item")
        .map(|stored| item(&stored))
        .transpose()?
        .ok_or_else(|| records("Item completion boundary is unavailable"))?;
    Ok((integer(&row, "seq"), item))
}

/// `history-index.ts:349`: the previews a page shows, filled from the frozen streams.
fn preview(
    conn: &Arc<Connection>,
    thread: &str,
    item: &mut Item,
    through: i64,
) -> Result<(), EngineError> {
    let mut units = PREVIEW_UNITS;
    let fill = |source: &mut ace_core::item_model::TextSource,
                units: &mut i64|
     -> Result<(), EngineError> {
        let version = frozen_stream(conn, thread, &source.stream_id, through)?;
        source.bytes = version.size;
        let length = (*units * 2).min(source.bytes);
        let value = if length > 0 {
            decode_utf16le(&read_stream(conn, thread, &source.stream_id, through, 0, length)?.bytes)
        } else {
            JsString::new()
        };
        *units -= value.len_utf16() as i64;
        Ok(())
    };
    match item {
        Item::Message { parts, .. } => {
            for part in parts {
                if let ContentPart::Text {
                    text,
                    source: Some(source),
                    ..
                } = part
                {
                    let mut updated = source.clone();
                    fill(&mut updated, &mut units)?;
                    *text = if updated.bytes > 0 {
                        decode_utf16le(
                            &read_stream(
                                conn,
                                thread,
                                &updated.stream_id,
                                through,
                                0,
                                (PREVIEW_UNITS * 2).min(updated.bytes),
                            )?
                            .bytes,
                        )
                    } else {
                        JsString::new()
                    };
                    *source = updated;
                }
            }
        }
        Item::Reasoning {
            text,
            source: Some(source),
            ..
        }
        | Item::Notice {
            text,
            source: Some(source),
            ..
        } => {
            let mut updated = source.clone();
            fill(&mut updated, &mut units)?;
            *text = if updated.bytes > 0 {
                decode_utf16le(
                    &read_stream(
                        conn,
                        thread,
                        &updated.stream_id,
                        through,
                        0,
                        (PREVIEW_UNITS * 2).min(updated.bytes),
                    )?
                    .bytes,
                )
            } else {
                JsString::new()
            };
            *source = updated;
        }
        // A shell call's output summary (`payload-store.ts`, `summarizeOutput`) is not read by a
        // transition: the handoff quotes a tool call's title and status only.
        _ => {}
    }
    Ok(())
}

fn item_json_bytes(item: &Item) -> i64 {
    serde_json::to_string(item)
        .map(|json| json.len() as i64)
        .unwrap_or(0)
}

/// `history-index.ts:391`: the thread's first person message among its first `scan` items.
pub fn opening(
    conn: &Arc<Connection>,
    thread: &str,
    through: i64,
    scan: i64,
) -> Result<Option<Item>, EngineError> {
    let rows = stmt_cache::all_rows(
        conn,
        OPENING,
        vec![
            Cell::Text(thread.to_owned()),
            Cell::Integer(through),
            Cell::Integer(scan.min(64)),
        ],
    )?;
    for row in rows {
        let Some(id) = text(&row, "id") else {
            continue;
        };
        let Some(mut item) = item_at(conn, &id, through)? else {
            continue;
        };
        let Item::Message {
            role,
            synthetic,
            origin,
            ..
        } = &item
        else {
            continue;
        };
        if role != "user" {
            continue;
        }
        let person = match origin.as_ref().map(|origin| origin.kind.as_str()) {
            None => !synthetic,
            Some("person" | "queue") => true,
            Some(_) => false,
        };
        if !person {
            continue;
        }
        preview(conn, thread, &mut item, through)?;
        return Ok(Some(item));
    }
    Ok(None)
}

/// `history-index.ts:408`: the newest item created before `before`.
fn newest_before(
    conn: &Arc<Connection>,
    thread: &str,
    through: i64,
    before: i64,
) -> Result<Option<(Item, i64)>, EngineError> {
    let Some(row) = stmt_cache::get_row(
        conn,
        NEWEST,
        vec![
            Cell::Text(thread.to_owned()),
            Cell::Integer(through),
            Cell::Integer(before),
        ],
    )?
    else {
        return Ok(None);
    };
    let Some(id) = text(&row, "id") else {
        return Ok(None);
    };
    let Some(mut item) = item_at(conn, &id, through)? else {
        return Err(records("Historical revision is unavailable"));
    };
    preview(conn, thread, &mut item, through)?;
    Ok(Some((item, integer(&row, "created_seq"))))
}

fn has_item_before(
    conn: &Arc<Connection>,
    thread: &str,
    through: i64,
    before: i64,
) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(
        conn,
        HAS_ITEM,
        vec![
            Cell::Text(thread.to_owned()),
            Cell::Integer(through),
            Cell::Integer(before),
        ],
    )?
    .is_some())
}

/// `history-index.ts:429`: the newest items before `before`, oldest first, within a byte budget.
pub fn page(
    conn: &Arc<Connection>,
    thread: &str,
    through: i64,
    before: i64,
    limit: i64,
    byte_limit: i64,
) -> Result<Page, EngineError> {
    if through < 0
        || before < 0
        || !(1..=200).contains(&limit)
        || !(512..=1024 * 1024).contains(&byte_limit)
    {
        return Err(records("Invalid page range"));
    }
    let rows = stmt_cache::all_rows(
        conn,
        PAGE,
        vec![
            Cell::Text(thread.to_owned()),
            Cell::Integer(through),
            Cell::Integer(before),
            Cell::Integer(limit + 1),
        ],
    )?;
    let mut items = Vec::new();
    let mut cursors: Vec<(String, i64)> = Vec::new();
    let mut bytes = PAGE_BASE;
    for row in rows.iter().take(limit as usize) {
        let Some(id) = text(row, "id") else {
            continue;
        };
        let Some(mut item) = item_at(conn, &id, through)? else {
            return Err(records("Historical revision is unavailable"));
        };
        preview(conn, thread, &mut item, through)?;
        let size = item_json_bytes(&item) + id.len() as i64 + ITEM_OVERHEAD;
        if bytes + size > byte_limit {
            if items.is_empty() {
                return Err(records("Historical item exceeds page capacity"));
            }
            break;
        }
        bytes += size;
        items.push(item);
        cursors.push((id, integer(row, "created_seq")));
    }
    items.reverse();
    let items_before =
        (rows.len() > items.len()).then(|| cursors.last().map(|(_, seq)| *seq).unwrap_or(before));
    Ok(Page {
        items,
        item_seqs: cursors.into_iter().collect(),
        items_before,
    })
}

/// `history-index.ts:319`'s bounded page (`bounded-item-page.ts`): one oversized item is shown
/// without its raw payloads, then with long strings cut, and only then skipped.
pub fn bounded_page(
    conn: &Arc<Connection>,
    thread: &str,
    through: i64,
    before: i64,
    limit: i64,
    byte_limit: i64,
) -> Result<Page, EngineError> {
    match page(conn, thread, through, before, limit, byte_limit) {
        Ok(page) => Ok(page),
        Err(error) if error.to_string() == "Historical item exceeds page capacity" => {
            let Some((item, seq)) = newest_before(conn, thread, through, before)? else {
                return Err(error);
            };
            let bytes = item_json_bytes(&item);
            let marker = summary_json(&item, seq, bytes, "item").len() as i64 + 1;
            let room = byte_limit - PAGE_BASE - marker;
            let slim = without_raw(&item);
            let entry = entry_bytes(&slim, item.id());
            let shown = if entry <= room {
                Some(slim.clone())
            } else {
                clip_item(&slim, room - empty_entry_bytes(item.id()) + 2)
            };
            let rest = if limit > 1 {
                bounded_page(
                    conn,
                    thread,
                    through,
                    seq,
                    limit - 1,
                    byte_limit
                        - (shown
                            .as_ref()
                            .map(|item| entry_bytes(item, item.id()))
                            .unwrap_or(0))
                        - marker,
                )?
            } else {
                Page {
                    items: Vec::new(),
                    item_seqs: HashMap::new(),
                    items_before: has_item_before(conn, thread, through, seq)?.then_some(seq),
                }
            };
            let mut result = rest;
            if let Some(shown) = shown {
                result.item_seqs.insert(shown.id().to_owned(), seq);
                result.items.push(shown);
            }
            Ok(result)
        }
        Err(error) => Err(error),
    }
}

fn entry_bytes(value: &Item, id: &str) -> i64 {
    item_json_bytes(value) + (id.len() as i64 + 2) + ITEM_OVERHEAD
}

/// `entryBytes("", id)` (`bounded-item-page.ts:20`): the empty string's JSON and the id's.
fn empty_entry_bytes(id: &str) -> i64 {
    2 + (id.len() as i64 + 2) + ITEM_OVERHEAD
}

/// The item without its verbatim provider payloads (`bounded-item-page.ts:25`).
fn without_raw(item: &Item) -> Item {
    let mut value = json_value(item);
    let Some(object) = value.as_object_mut() else {
        return item.clone();
    };
    if object.get("type").and_then(Value::as_str) == Some("tool_call") {
        if let Some(call) = object.get_mut("call").and_then(Value::as_object_mut) {
            call.insert("raw", Value::Array(Vec::new().into()));
        }
    } else if object.contains_key("raw") {
        object.insert("raw", Value::Array(Vec::new().into()));
    }
    ace_json::from_value(&value).unwrap_or_else(|_| item.clone())
}

fn json_value(item: &Item) -> Value {
    serde_json::to_value(item)
        .ok()
        .and_then(|value| ace_json::parse(&serde_json::to_string(&value).ok()?).ok())
        .unwrap_or(Value::Null)
}

/// The omission marker a clipped item's page reserves (`bounded-item-page.ts:38`).
fn summary_json(item: &Item, seq: i64, bytes: i64, dropped: &str) -> String {
    let mut value = ace_json::Map::new();
    value.insert("itemId", Value::from(item.id()));
    value.insert("seq", Value::from(seq));
    value.insert("type", Value::from(item.item_type()));
    value.insert("bytes", Value::from(bytes));
    value.insert("dropped", Value::from(dropped));
    if let Item::ToolCall { call, .. } = item {
        value.insert("kind", Value::from(call.kind.as_str()));
        let title: String = call.title.chars().take(200).collect();
        value.insert("title", Value::from(title));
    }
    ace_json::to_string(&Value::Object(value))
}

/// `item-clip.ts:41`: every long string cut to a cap that fits `max_bytes`, or none.
fn clip_item(item: &Item, max_bytes: i64) -> Option<Item> {
    let value = json_value(item);
    let longest = longest_string(&value);
    if longest <= 256 || json_bytes(&clip_value(&value, 256)) > max_bytes {
        return None;
    }
    let (mut low, mut high) = (256i64, longest);
    while low < high {
        let middle = (low + high + 1) / 2;
        if json_bytes(&clip_value(&value, middle)) <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let clipped = clip_value(&value, low);
    if json_bytes(&clipped) > max_bytes {
        return None;
    }
    ace_json::from_value(&clipped).ok()
}

fn json_bytes(value: &Value) -> i64 {
    ace_json::to_string(value).len() as i64
}

fn longest_string(value: &Value) -> i64 {
    match value {
        Value::String(text) => text.len_utf16() as i64,
        Value::Array(items) => items.iter().map(longest_string).max().unwrap_or(0),
        Value::Object(object) => object.values().map(longest_string).max().unwrap_or(0),
        _ => 0,
    }
}

fn clip_value(value: &Value, cap: i64) -> Value {
    match value {
        Value::String(text) => {
            let length = text.len_utf16();
            if length as i64 <= cap {
                return Value::String(text.clone());
            }
            let mut end = usize::try_from(cap).unwrap_or(0);
            if end > 0 {
                let last = text.slice_units(end - 1, end).encode_utf16().next();
                if last.is_some_and(|unit| (0xd800..=0xdbff).contains(&unit)) {
                    end -= 1;
                }
            }
            let mut cut = text.slice_units(0, end);
            cut.push_str(&format!("… [{} more characters not shown]", length - end));
            Value::String(cut)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| clip_value(item, cap)).collect())
        }
        Value::Object(object) => {
            let mut clipped = ace_json::Map::new();
            for (key, entry) in object.iter() {
                clipped.insert(key.as_str(), clip_value(entry, cap));
            }
            Value::Object(clipped)
        }
        other => other.clone(),
    }
}

/// `portableContext` (`@ace/context`): the bounded source and its selected manifest.
pub fn portable_context(
    source: HandoffSource,
    items: Vec<Item>,
    max_bytes: i64,
    max_items: usize,
    history_truncated: bool,
    opening_item: Option<Item>,
) -> Result<PortableHandoff, EngineError> {
    let _ = history_truncated;
    if !(1024..=262_144).contains(&max_bytes) || !(1..=200).contains(&max_items) {
        return Err(records("Invalid handoff limits"));
    }
    let mut kept = Vec::new();
    for entry in items {
        if kept.len() == max_items {
            break;
        }
        kept.push(entry);
    }
    handoff::select_handoff(
        &HandoffSource {
            items: kept,
            opening: opening_item,
            ..source
        },
        max_bytes,
    )
    .map_err(records)
}

/// `handoff` (`transition-history.ts:91`): the portable context for `id` up to `through_seq`.
pub struct HandoffOptions<'a> {
    pub since: Option<i64>,
    /// Items to leave out, such as the input this handoff goes in front of.
    pub exclude: &'a [String],
}

pub fn handoff(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    through_seq: i64,
    budget: i64,
    provider: &str,
    options: HandoffOptions<'_>,
) -> Result<PortableHandoff, EngineError> {
    let since = options.since;
    let exclude = options.exclude;
    let conn = store.conn();
    let all = item_count(conn, id, through_seq)?;
    let total_items = match since {
        Some(since) => all - item_count(conn, id, since)?,
        None => all,
    };
    let page = page(conn, id, through_seq, through_seq + 1, 200, 1024 * 1024)?;
    let kept: Vec<Item> = page
        .items
        .iter()
        .filter(|entry| !exclude.contains(&entry.id().to_owned()))
        .cloned()
        .collect();
    let left_out = page.items.len() - kept.len();
    let items: Vec<Item> = match since {
        None => kept,
        Some(since) => kept
            .into_iter()
            .filter(|entry| page.item_seqs.get(entry.id()).copied().unwrap_or(0) > since)
            .collect(),
    };
    let opening_item = if since.is_none() && page.items.len() < all as usize {
        opening(conn, id, through_seq, 16)?
    } else {
        None
    };
    let thread = store
        .get_thread(id)?
        .and_then(|json| ace_json::parse(&json).ok());
    let thread_provider = thread
        .as_ref()
        .and_then(|thread| thread.get("provider"))
        .and_then(Value::as_str);
    let backend = if thread_provider == Some(provider) {
        state.session_backend(store, id).ok().flatten()
    } else {
        None
    };
    let source = HandoffSource {
        thread_id: id.to_owned(),
        through_seq,
        total_items: (total_items - left_out as i64).max(items.len() as i64),
        origin: Some(handoff::Origin {
            provider: provider.to_owned(),
            backend,
        }),
        since,
        ..Default::default()
    };
    portable_context(
        source,
        items.clone(),
        budget,
        200,
        items.len() < total_items as usize,
        opening_item,
    )
}

/// `boundary` (`transition-history.ts:32`): the fork point's sequence and source.
pub fn boundary(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    point: &Value,
) -> Result<Value, EngineError> {
    let conn = store.conn();
    let kind = point
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (snapshot_state, root) = {
        let snapshot = state.repo.require_state(store, id)?;
        let borrowed = snapshot.borrow();
        let root_key = borrowed.state.root_key.clone();
        let root = root_key.and_then(|key| borrowed.state.agents.get(&key).cloned());
        (borrowed.state.clone(), root)
    };
    let Some(root) = root else {
        return Err(records("Source root is unavailable"));
    };
    let run_of = |run_id: &str| -> Result<ace_core::runs::Run, EngineError> {
        let row = stmt_cache::get_row(
            conn,
            "SELECT value FROM view_entities WHERE thread_id=? AND collection='runs' AND id=?",
            vec![Cell::Text(id.to_owned()), Cell::Text(run_id.to_owned())],
        )?;
        let Some(row) = row else {
            return Err(records("Fork point must be a finished run"));
        };
        let Some(value) = text(&row, "value") else {
            return Err(records("Fork point must be a finished run"));
        };
        let value =
            ace_json::parse(&value).map_err(|error| EngineError::Records(error.to_string()))?;
        ace_json::from_value(&value).map_err(|error| EngineError::Records(error.to_string()))
    };
    let (through_seq, parent_agent_id, execution_source, source_agent, at_session_end, native) =
        if kind == "turn" {
            let run_id = point
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let run = run_of(run_id)?;
            if run.state == "active" || run.ended_at.is_none() {
                return Err(records("Fork point must be a finished run"));
            }
            let end = stmt_cache::get_row(
                conn,
                "SELECT seq FROM events WHERE thread_id=? AND type='run.ended' AND json_extract(payload,'$.runId')=? ORDER BY seq DESC LIMIT 1",
                vec![Cell::Text(id.to_owned()), Cell::Text(run_id.to_owned())],
            )?
            .map(|row| integer(&row, "seq"));
            let Some(through_seq) = end else {
                return Err(records("Fork boundary is unavailable"));
            };
            let agent_key = snapshot_state
                .indexes
                .agent_keys_by_id
                .get(&run.agent_id)
                .and_then(|key| snapshot_state.agents.get(key))
                .map(|record| record.agent.clone());
            let session = crate::sessions::metadata::session(store, id)
                .ok()
                .and_then(|session| session.native_session_id);
            let native_session = run
                .execution_source
                .as_ref()
                .and_then(|source| source.get("nativeSessionId"))
                .and_then(|value| value.as_str())
                .map(str::to_owned);
            let at_session_end = root.last_run.as_deref() == Some(run.id.as_str())
                && run.agent_id == root.agent.id
                && native_session.is_some()
                && native_session == session
                && thread_quiescent(store, state, id)?;
            let native = run
                .native_id
                .as_ref()
                .map(|native| ("turn", native.clone()));
            (
                through_seq,
                run.agent_id,
                run.execution_source.map(vetted),
                agent_key,
                at_session_end,
                native,
            )
        } else {
            let item_id = point
                .get("itemId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (through_seq, mut item) = completion(conn, id, item_id)?;
            let (agent_id, run_id) = match &item {
                Item::Message { base, .. } => (base.agent_id.clone(), base.run_id.clone()),
                _ => {
                    let value = json_value(&item);
                    let agent = value
                        .get("agentId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let run = value
                        .get("runId")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    (agent.unwrap_or_default(), run)
                }
            };
            let Some(run_id) = run_id else {
                return Err(records("Fork point must be a finished agent item in a run"));
            };
            if agent_id.is_empty() || !item.complete() {
                return Err(records("Fork point must be a finished agent item in a run"));
            }
            let run = run_of(&run_id)?;
            if run.state == "active" {
                return Err(records("Fork point belongs to an unfinished run"));
            }
            let agent_key = snapshot_state
                .indexes
                .agent_keys_by_id
                .get(&agent_id)
                .and_then(|key| snapshot_state.agents.get(key))
                .map(|record| record.agent.clone());
            let native_id = json_value(&item)
                .get("nativeId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let execution_source = item_source(&mut item).or(run.execution_source.map(vetted));
            let native = native_id.map(|native| ("item", native));
            (
                through_seq,
                agent_id,
                execution_source,
                agent_key,
                false,
                native,
            )
        };
    let mut value = ace_json::Map::new();
    value.insert("throughSeq", Value::from(through_seq));
    value.insert("parentAgentId", Value::from(parent_agent_id.as_str()));
    if let Some(source) = execution_source {
        value.insert("executionSource", source);
    }
    if let Some(agent) = source_agent {
        let agent = serde_json::to_value(&agent)
            .ok()
            .and_then(|value| ace_json::parse(&serde_json::to_string(&value).ok()?).ok())
            .unwrap_or(Value::Null);
        value.insert("sourceAgent", agent);
    }
    value.insert("atSessionEnd", Value::Bool(at_session_end));
    if let Some((kind, native)) = native {
        let mut native_value = ace_json::Map::new();
        native_value.insert("type", Value::from(kind));
        native_value.insert("nativeId", Value::from(native.as_str()));
        value.insert("native", Value::Object(native_value));
    }
    Ok(Value::Object(value))
}

/// A run's stored execution source, as the engine's value tree.
fn vetted(value: serde_json::Value) -> Value {
    ace_json::parse(&serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned()))
        .unwrap_or(Value::Null)
}

fn item_source(item: &mut Item) -> Option<Value> {
    match item {
        Item::Html { base, .. }
        | Item::Image { base, .. }
        | Item::Message { base, .. }
        | Item::Reasoning { base, .. }
        | Item::ToolCall { base, .. }
        | Item::Notice { base, .. }
        | Item::Compaction { base, .. }
        | Item::Unknown { base, .. } => base
            .fields
            .execution_source
            .as_ref()
            .map(|source| source.0.to_value()),
        Item::DelegationStarted { base, .. } | Item::DelegationSettled { base, .. } => base
            .execution_source
            .as_ref()
            .map(|source| source.0.to_value()),
        Item::Artifact { base, .. } => base
            .execution_source
            .as_ref()
            .map(|source| source.0.to_value()),
    }
}

pub(crate) fn thread_quiescent(
    store: &EngineStore,
    state: &mut State,
    id: &str,
) -> Result<bool, EngineError> {
    let snapshot = state.repo.require_state(store, id)?;
    let view = snapshot.borrow_mut().quiescence_view()?;
    let ready = readiness::agents_ready(store.conn(), id)?;
    Ok(readiness::quiescent(&view, ready))
}

/// `validateCitations` (`transition-history.ts:134`): every citation belongs to the fork and is
/// not the source's own message.
pub fn validate_citations(
    store: &EngineStore,
    id: &str,
    item_ids: &[String],
) -> Result<(), EngineError> {
    for item_id in item_ids {
        let row = stmt_cache::get_row(
            store.conn(),
            CITED,
            vec![Cell::Text(id.to_owned()), Cell::Text(item_id.clone())],
        )?;
        let Some(row) = row else {
            return Err(records("Citation does not belong to fork"));
        };
        let inherited = row
            .get("inherited")
            .and_then(crate::repository::residency::cell_int)
            .unwrap_or(0);
        if inherited != 0 {
            return Err(records("Citation is the source's own message"));
        }
    }
    Ok(())
}

/// `messageAt` (`fork-history.ts:34`): the message as the source held it at the fork point,
/// its text read whole up to the copy's budget.
fn message_at(
    store: &EngineStore,
    source: &str,
    through: i64,
    seq: i64,
) -> Result<Option<Item>, EngineError> {
    let conn = store.conn();
    let page = bounded_page(conn, source, through, seq + 1, 1, INHERITED_PAGE_BYTES)?;
    let Some(mut item) = page.items.into_iter().next() else {
        return Ok(None);
    };
    if let Item::Message { parts, .. } = &mut item {
        for part in parts {
            if let ContentPart::Text {
                text,
                source: Some(text_source),
                ..
            } = part
                && text_source.bytes > text.len_utf16() as i64 * 2
            {
                let read = read_stream(
                    conn,
                    source,
                    &text_source.stream_id,
                    through,
                    0,
                    text_source.bytes.min(MAX_INHERITED_TEXT_BYTES),
                )?;
                *text = decode_utf16le(&read.bytes);
            }
        }
    }
    Ok(Some(item))
}

/// `forkHistoryFacts` (`fork-history.ts:59`): the copies that open a fork on its source's
/// conversation through `through`.
pub fn fork_history_facts(
    store: &EngineStore,
    source: &str,
    through: i64,
    parent_agent_id: &str,
) -> Result<Vec<Value>, EngineError> {
    let rows = stmt_cache::all_rows(
        store.conn(),
        MESSAGES,
        vec![
            Cell::Text(source.to_owned()),
            Cell::Text(parent_agent_id.to_owned()),
            Cell::Integer(through),
            Cell::Integer(MAX_INHERITED_MESSAGES as i64 + 1),
        ],
    )?;
    let seqs: Vec<i64> = rows.iter().map(|row| integer(row, "created_seq")).collect();
    let trimmed = seqs.len() > MAX_INHERITED_MESSAGES;
    let mut items = Vec::new();
    for seq in seqs.iter().take(MAX_INHERITED_MESSAGES).rev() {
        if let Some(item) = message_at(store, source, through, *seq)? {
            items.push(item);
        }
    }
    let drafts = handoff::inherited_drafts(&items, parent_agent_id, trimmed);
    Ok(drafts
        .iter()
        .map(|draft| {
            let mut fact = ace_json::Map::new();
            fact.insert("type", Value::from("item.upsert"));
            fact.insert("agent", Value::from("root"));
            fact.insert("item", Value::from(draft_key(draft).as_str()));
            fact.insert("draft", draft.draft(source));
            Value::Object(fact)
        })
        .collect())
}

fn draft_key(draft: &handoff::InheritedDraft) -> String {
    match draft {
        handoff::InheritedDraft::Message { key, .. }
        | handoff::InheritedDraft::Notice { key, .. } => key.clone(),
    }
}

/// `lateForkHistoryFacts` (`fork-history.ts:83`): copies for a native fork that left before its
/// session opened. None when the source is gone.
pub fn late_fork_history_facts(
    store: &EngineStore,
    state: &mut State,
    fork: &str,
) -> Result<Vec<Value>, EngineError> {
    let thread = store
        .get_thread(fork)?
        .and_then(|json| ace_json::parse(&json).ok());
    let Some(lineage) = thread
        .as_ref()
        .and_then(|thread| thread.get("lineage"))
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let Some(parent) = lineage.get("parentThreadId").and_then(Value::as_str) else {
        return Ok(Vec::new());
    };
    if state.repo.snapshots.get(parent).is_none() && state.repo.state(store, parent)?.is_none() {
        return Ok(Vec::new());
    }
    let Some(point) = lineage.get("point").cloned() else {
        return Ok(Vec::new());
    };
    let boundary = boundary(store, state, parent, &point)?;
    let agent = boundary
        .get("parentAgentId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let through = boundary
        .get("throughSeq")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as i64;
    fork_history_facts(store, parent, through, agent)
}

#[cfg(test)]
mod tests;
