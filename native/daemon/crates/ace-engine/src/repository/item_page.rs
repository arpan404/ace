// SPDX-License-Identifier: Apache-2.0
//! The item page a synchronous read takes (`thread-reads.ts:240` -> `item-store.ts:281`,
//! `wirePage`): the newest items before a creation sequence, each as a page shows it, within a
//! byte budget. Messages, notices and reasoning show their bounded text preview, filled from
//! their streams; every other item shows its stored body.
//!
//! A body is measured after it is read and filled. The TypeScript trusts a row this build wrote
//! and uses its stored size instead; measuring gives the same number and never trusts a row, so
//! E5.3's trust pass can add the shortcut later.

use ace_json::{JsString, Value};
use ace_store::{Value as Cell, stmt_cache};
use std::sync::Arc;

use super::Repo;
use crate::repository::residency::{cell_int, cell_text};
use crate::{EngineError, EngineStore};

const HEADS: &str = "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?";
const PREVIEW: &str = "SELECT item FROM item_previews WHERE id=?";
const BODY: &str = "SELECT item FROM items WHERE id=?";
const STREAM_SIZE: &str = "SELECT size FROM item_text_streams WHERE id=?";
const CHUNKS: &str = "SELECT offset,bytes FROM item_source_chunks WHERE stream_id=? AND offset > ? AND offset < ? ORDER BY offset";

/// A page's fixed overhead, before the items (`item-store.ts:293`).
const PAGE_BASE: i64 = 512;
/// Each item's own overhead in a page (`item-store.ts:296`).
const ITEM_OVERHEAD: i64 = 64;
/// The units of text a preview carries, across its parts (`item-text-store.ts:224`).
const PREVIEW_UNITS: usize = 4096;

/// The item types a page shows from their text preview (`item-store.ts:298`).
fn previewed(kind: &str) -> bool {
    matches!(kind, "message" | "notice" | "reasoning")
}

fn cell_bytes(cell: &Cell) -> Option<&[u8]> {
    match cell {
        Cell::Blob(bytes) => Some(bytes),
        _ => None,
    }
}

/// The text in bytes `[start, end)` of a text stream, read from the chunks that hold it.
fn slice(
    conn: &Arc<ace_store::Connection>,
    stream_id: &str,
    start: i64,
    end: i64,
) -> Result<JsString, EngineError> {
    if end <= start {
        return Ok(JsString::default());
    }
    let rows = stmt_cache::all_rows(
        conn,
        CHUNKS,
        vec![
            Cell::Text(stream_id.to_owned()),
            Cell::Integer(start - 65_536),
            Cell::Integer(end),
        ],
    )?;
    let mut bytes: Vec<u8> = Vec::new();
    for row in rows {
        let Some(chunk) = row.get("bytes").and_then(cell_bytes) else {
            return Err(EngineError::Records("Invalid text chunk".to_owned()));
        };
        let offset = row.get("offset").and_then(cell_int).unwrap_or(0);
        let from = usize::try_from(start.saturating_sub(offset)).unwrap_or(0);
        let to = usize::try_from(end - offset).unwrap_or(0).min(chunk.len());
        if to > from {
            bytes.extend_from_slice(&chunk[from..to]);
        }
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Ok(JsString::from_units(&units))
}

/// The stream's whole length now, which the stored descriptor may trail
/// (`item-text-store.ts:175`).
fn stream_size(conn: &Arc<ace_store::Connection>, stream_id: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(conn, STREAM_SIZE, vec![Cell::Text(stream_id.to_owned())])?;
    row.and_then(|row| row.get("size").and_then(cell_int))
        .ok_or_else(|| EngineError::Records("Invalid text source".to_owned()))
}

/// The stream's first `units`: the preview of finished text, read from the top.
fn head(
    conn: &Arc<ace_store::Connection>,
    source: &Value,
    units: usize,
) -> Result<JsString, EngineError> {
    let Some(stream_id) = source.get("streamId").and_then(Value::as_str) else {
        return Ok(JsString::default());
    };
    let bytes = stream_size(conn, stream_id)?;
    let end = (units as i64 * 2).min(bytes);
    slice(conn, stream_id, 0, end)
}

/// The stream's last `units`: the preview of text still streaming. Never starts inside a
/// surrogate pair.
fn tail(
    conn: &Arc<ace_store::Connection>,
    source: &Value,
    units: usize,
) -> Result<JsString, EngineError> {
    let Some(stream_id) = source.get("streamId").and_then(Value::as_str) else {
        return Ok(JsString::default());
    };
    let bytes = stream_size(conn, stream_id)?;
    let start = (bytes - units as i64 * 2).max(0);
    let text = slice(conn, stream_id, start, bytes)?;
    let mut units: Vec<u16> = text.units().collect();
    if units
        .first()
        .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
    {
        units.remove(0);
    }
    Ok(JsString::from_units(&units))
}

/// Replace each text part's preview with the stream's own text, within the preview budget
/// (`item-text-store.ts:220`).
fn fill_streams(conn: &Arc<ace_store::Connection>, mut item: Value) -> Result<Value, EngineError> {
    let streaming = item
        .get("complete")
        .and_then(Value::as_bool)
        .map(|complete| !complete)
        .unwrap_or(true);
    let mut remaining = PREVIEW_UNITS;
    let Some(parts) = item.get_mut("parts").and_then(Value::as_array_mut) else {
        return Ok(item);
    };
    let count = parts.len();
    for index in 0..count {
        let at = if streaming { count - 1 - index } else { index };
        let Some(part) = parts.get_mut(at).and_then(Value::as_object_mut) else {
            continue;
        };
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(source) = part.get("source").cloned() else {
            continue;
        };
        let text = if streaming {
            tail(conn, &source, remaining)?
        } else {
            head(conn, &source, remaining)?
        };
        remaining = remaining.saturating_sub(text.len_utf16());
        part.insert("text", Value::from(text));
    }
    Ok(item)
}

/// One item's stored body, as a page shows it.
fn body(conn: &Arc<ace_store::Connection>, id: &str, kind: &str) -> Result<Value, EngineError> {
    let (sql, preview) = if previewed(kind) {
        (PREVIEW, true)
    } else {
        (BODY, false)
    };
    let row = stmt_cache::get_row(conn, sql, vec![Cell::Text(id.to_owned())])?;
    let stored = row
        .and_then(|row| row.get("item").and_then(cell_text).map(str::to_owned))
        .ok_or_else(|| {
            EngineError::Records(if preview {
                "Missing item preview".to_owned()
            } else {
                "Missing item".to_owned()
            })
        })?;
    let parsed =
        ace_json::parse(&stored).map_err(|error| EngineError::Records(error.to_string()))?;
    if preview {
        fill_streams(conn, parsed)
    } else {
        Ok(parsed)
    }
}

impl Repo {
    /// The newest items before `before`, at most `limit`, within `byte_limit` bytes: the page
    /// `readItemPage` answers (`thread-reads.ts:240`). Items come back in creation order.
    pub fn read_item_page(
        &mut self,
        store: &EngineStore,
        thread: &str,
        before: i64,
        limit: usize,
        byte_limit: i64,
    ) -> Result<Vec<Value>, EngineError> {
        let rows = stmt_cache::all_rows(
            store.conn(),
            HEADS,
            vec![
                Cell::Text(thread.to_owned()),
                Cell::Integer(before),
                Cell::Integer(limit as i64 + 1),
            ],
        )?;
        let mut items = Vec::new();
        let mut bytes = PAGE_BASE;
        for row in rows.iter().take(limit) {
            let (Some(id), Some(kind)) = (
                row.get("id").and_then(cell_text),
                row.get("item_type").and_then(cell_text),
            ) else {
                continue;
            };
            let overhead = id.len() as i64 + 2 + ITEM_OVERHEAD;
            // A non-text body has no smaller preview: its stored size decides before it is
            // loaded (`item-store.ts:300`).
            if !previewed(kind) {
                let stored = row.get("size").and_then(cell_int).unwrap_or(0);
                if bytes + stored + overhead > byte_limit {
                    if items.is_empty() {
                        return Err(EngineError::Records(
                            "Item detail exceeds page capacity".to_owned(),
                        ));
                    }
                    break;
                }
            }
            let item = body(store.conn(), id, kind)?;
            let size = ace_json::to_string(&item).len() as i64 + overhead;
            if bytes + size > byte_limit {
                if items.is_empty() {
                    return Err(EngineError::Records(
                        "Item detail exceeds page capacity".to_owned(),
                    ));
                }
                break;
            }
            items.push(item);
            bytes += size;
        }
        // The page reads newest first; its items come out oldest first.
        items.reverse();
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::State;
    use crate::repository::testsupport::{Shell, home};

    /// A message with its preview and its stored size: a home whose preview is the cut text a
    /// page reads while the stored row is much larger.
    fn insert_message(
        conn: &Arc<ace_store::Connection>,
        id: &str,
        seq: i64,
        preview: &str,
        size: i64,
    ) {
        let body = format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"user","parts":[{{"type":"text","text":"{preview}"}}],"createdAt":1,"complete":true}}"#
        );
        conn.exec(&format!(
            "INSERT INTO items VALUES ('{id}', 't', {seq}, '{}')",
            body.replace('\'', "''")
        ))
        .expect("item");
        conn.exec(&format!(
            "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, text_prefix) VALUES ('{id}', 't', {seq}, {size}, 'message', 0)"
        ))
        .expect("head");
        conn.exec(&format!(
            "INSERT INTO item_previews VALUES ('{id}', '{}', 0)",
            body.replace('\'', "''")
        ))
        .expect("preview");
    }

    #[test]
    fn a_message_larger_than_the_byte_budget_is_measured_by_its_preview() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        // A 300 KB message: its stored row passes the budget, but its preview is what a page
        // reads, so the parts come back.
        insert_message(&conn, "input:big", 1, &"x".repeat(4096), 300 * 1024);
        let page = state
            .repo
            .read_item_page(&store, "t", 2, 1, 256 * 1024)
            .expect("the page");
        assert_eq!(page.len(), 1);
        let parts = page[0]
            .get("parts")
            .and_then(Value::as_array)
            .expect("parts");
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn a_non_text_body_is_refused_by_its_stored_size_before_it_is_loaded() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        // A 300 KB stored body whose JSON is small: the TypeScript rejects it by the stored
        // size before loading it (item-store.ts:300), and so must this page.
        conn.exec(
            "INSERT INTO items VALUES ('call-1', 't', 1, '{\"type\":\"tool_call\",\"id\":\"call-1\"}')",
        )
        .expect("item");
        conn.exec(
            "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, text_prefix) \
             VALUES ('call-1', 't', 1, 307200, 'tool_call', 0)",
        )
        .expect("head");
        let error = state
            .repo
            .read_item_page(&store, "t", 2, 1, 256 * 1024)
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Item detail exceeds page capacity");
    }

    #[test]
    fn a_page_larger_than_its_budget_refuses_only_when_it_holds_nothing() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        insert_message(&conn, "input:one", 1, "one", 100);
        let error = state
            .repo
            .read_item_page(&store, "t", 2, 1, 512)
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Item detail exceeds page capacity");
        let page = state
            .repo
            .read_item_page(&store, "t", 2, 2, 4096)
            .expect("the page");
        assert_eq!(page.len(), 1);
    }
}
