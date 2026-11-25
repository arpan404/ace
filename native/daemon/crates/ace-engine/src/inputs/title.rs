// SPDX-License-Identifier: Apache-2.0
//! `title-input.ts` (E5.4c): the oldest real prose input of a thread, walked through the
//! creation index one item at a time in bounded reads. The index's DDL stays TypeScript
//! (`title-input.ts:12`); this module holds only the read.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::sync::Arc;

use crate::EngineError;
use crate::inputs::provisional_title::{UNTITLED_THREAD, provisional_title};
use crate::repository::residency::{cell_int, cell_text};

/// The items that carry a person's words (`title-input.ts:5`), character for character.
const SEQS: &str = "SELECT created_seq FROM items WHERE thread_id=? AND json_extract(item,'$.type')='message' AND json_extract(item,'$.role')='user'
  AND COALESCE(json_extract(item,'$.synthetic'),0)=0
  AND COALESCE(json_extract(item,'$.origin.kind'),'person') IN ('person','queue') ORDER BY created_seq";
const HEAD: &str = "SELECT id,size FROM item_heads WHERE thread_id=? AND created_seq=?";
const PREVIEW: &str = "SELECT item FROM item_previews WHERE id=?";
const STREAM_SIZE: &str = "SELECT size FROM item_text_streams WHERE id=?";
const CHUNKS: &str = "SELECT offset,bytes FROM item_source_chunks WHERE stream_id=? AND offset > ? AND offset < ? ORDER BY offset";

/// The page budget `oldestTitleInput` reads one item with (`title-input.ts:22`).
const PAGE_BYTES: i64 = 256 * 1024;
/// A page's fixed overhead, before the item's own size (`item-store.ts:294`).
const PAGE_BASE: i64 = 512;
/// Each item's own overhead in a page (`item-store.ts:296`).
const ITEM_OVERHEAD: i64 = 64;
/// The units of text a preview carries, across its parts (`item-text-store.ts:224`).
const PREVIEW_UNITS: usize = 4096;

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
) -> Result<String, EngineError> {
    if end <= start {
        return Ok(String::new());
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
    Ok(String::from_utf16_lossy(&units))
}

/// The stream's whole length now, which the stored descriptor may trail (`item-text-store.ts:175`).
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
) -> Result<String, EngineError> {
    let Some(stream_id) = source.get("streamId").and_then(Value::as_str) else {
        return Ok(String::new());
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
) -> Result<String, EngineError> {
    let Some(stream_id) = source.get("streamId").and_then(Value::as_str) else {
        return Ok(String::new());
    };
    let bytes = stream_size(conn, stream_id)?;
    let start = (bytes - units as i64 * 2).max(0);
    let mut text = slice(conn, stream_id, start, bytes)?;
    if text
        .encode_utf16()
        .next()
        .is_some_and(|unit| (0xdc00..=0xdfff).contains(&unit))
    {
        let first = text.chars().next().map(char::len_utf8).unwrap_or(0);
        text = text[first..].to_owned();
    }
    Ok(text)
}

/// An item as a page shows it: text cut to its bounded preview, filled from its streams
/// (`item-text-store.ts:220`).
fn read_item(conn: &Arc<ace_store::Connection>, id: &str) -> Result<Option<Value>, EngineError> {
    let preview = stmt_cache::get_row(conn, PREVIEW, vec![Cell::Text(id.to_owned())])?;
    let Some(preview) = preview else {
        return Ok(None);
    };
    let Some(body) = preview.get("item").and_then(cell_text) else {
        return Ok(None);
    };
    let parsed = ace_json::parse(body).map_err(|error| EngineError::Records(error.to_string()))?;
    Ok(Some(fill_streams(conn, parsed)?))
}

/// Replace each text part's preview with the stream's own text, within the preview budget.
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
        remaining = remaining.saturating_sub(text.encode_utf16().count());
        part.insert("text", Value::from(text));
    }
    Ok(item)
}

/// `oldestTitleInput` (`title-input.ts:17`): seek the first real prose input, skipping empty
/// attachment or handoff envelopes in bounded pages.
pub fn oldest_title_input(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<Value>, EngineError> {
    let rows = stmt_cache::all_rows(conn, SEQS, vec![Cell::Text(thread.to_owned())])?;
    for row in rows {
        let Some(seq) = row.get("created_seq").and_then(cell_int) else {
            continue;
        };
        let head_row = stmt_cache::get_row(
            conn,
            HEAD,
            vec![Cell::Text(thread.to_owned()), Cell::Integer(seq)],
        )?;
        let Some(head_row) = head_row else {
            continue;
        };
        let (Some(id), Some(size)) = (
            head_row.get("id").and_then(cell_text),
            head_row.get("size").and_then(cell_int),
        ) else {
            continue;
        };
        let overhead = id.len() as i64 + 2 + ITEM_OVERHEAD;
        if PAGE_BASE + size + overhead > PAGE_BYTES {
            return Err(EngineError::Records(
                "Item detail exceeds page capacity".to_owned(),
            ));
        }
        let Some(item) = read_item(conn, id)? else {
            continue;
        };
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(list) = item
            .get("parts")
            .and_then(Value::as_array)
            .map(|parts| parts.as_slice().to_vec())
        else {
            continue;
        };
        if provisional_title(&list, UNTITLED_THREAD) != UNTITLED_THREAD {
            return Ok(Some(Value::Array(list.into())));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::home;
    use ace_json::Value;

    fn insert_message(conn: &Arc<ace_store::Connection>, id: &str, seq: i64, item: &Value) {
        let body = ace_json::to_string(item);
        conn.exec(&format!(
            "INSERT INTO items VALUES ('{id}', 't', {seq}, '{}')",
            body.replace('\'', "''")
        ))
        .expect("item");
        conn.exec(&format!(
            "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, text_prefix) \
             VALUES ('{id}', 't', {seq}, {}, 'message', 0)",
            body.len()
        ))
        .expect("head");
        conn.exec(&format!(
            "INSERT INTO item_previews VALUES ('{id}', '{}', 0)",
            body.replace('\'', "''")
        ))
        .expect("preview");
    }

    fn message(id: &str, parts: &str, origin: &str) -> Value {
        ace_json::parse(&format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"user","parts":{parts},"origin":{origin},"createdAt":1,"complete":true}}"#
        ))
        .expect("json")
    }

    #[test]
    fn the_oldest_message_with_words_wins_and_empty_envelopes_are_skipped() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        insert_message(
            &conn,
            "input:empty",
            1,
            &message(
                "input:empty",
                r#"[{"type":"text","text":"[file: a.png]"}]"#,
                r#"{"kind":"person"}"#,
            ),
        );
        insert_message(
            &conn,
            "input:queued",
            2,
            &message(
                "input:queued",
                r#"[{"type":"text","text":"the real one"}]"#,
                r#"{"kind":"queue"}"#,
            ),
        );
        let mut synthetic = message(
            "input:synthetic",
            r#"[{"type":"text","text":"ace wrote this"}]"#,
            r#"{"kind":"person"}"#,
        );
        if let Some(object) = synthetic.as_object_mut() {
            object.insert("synthetic", Value::Bool(true));
        }
        insert_message(&conn, "input:synthetic", 3, &synthetic);
        let parts = oldest_title_input(&conn, "t")
            .expect("read")
            .expect("parts");
        let text = parts
            .as_array()
            .and_then(|parts| parts.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str);
        assert_eq!(text, Some("the real one"));
        assert!(
            oldest_title_input(&conn, "no-such-thread")
                .expect("read")
                .is_none()
        );
    }
}
