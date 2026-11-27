// SPDX-License-Identifier: Apache-2.0
//! The SQL item page behind [`ItemPageSource`] (T4): `item_heads`, `items`, `item_previews` and
//! the text streams a preview reads. Ports `ItemStore.wirePage`, `newestBefore`,
//! `hasItemBefore`, `pageItem` and `ItemTextStore.read`.
//!
//! A text item (message, reasoning, notice) is paged from its stored preview and the text it
//! previews: finished text from its start, text still streaming from its newest end, marked
//! with where it starts so a client extends it with each delta (4096 units a page). Every other
//! item is its stored body, decoded by T4a. Unmerged non-text chunks (`item_text_chunks`) are
//! not applied here: the full materializer that does belongs to the snapshot read, and the
//! page's text items carry their deltas in the streams this module reads.

use std::sync::Arc;

use ace_json::{JsString, Map, Number, Value as Json};

use crate::reads::items::{ItemPageSource, PageError, PageRows, json_bytes};
use crate::reads::stored::{Trust, stored_item};
use crate::{Connection, Value as SqlValue};

/// How many UTF-16 units of text one page's preview shows (`ItemTextStore.read`).
pub const PREVIEW_UNITS: usize = 4096;

/// One thread's item page over a store connection.
pub struct SqlItemPage {
    conn: Arc<Connection>,
    thread_id: String,
    trust: Trust,
}

impl SqlItemPage {
    pub fn new(conn: Arc<Connection>, thread_id: &str, trust: Trust) -> SqlItemPage {
        SqlItemPage {
            conn,
            thread_id: thread_id.to_owned(),
            trust,
        }
    }

    fn query(&self, sql: &str, params: &[SqlValue]) -> Result<Vec<Vec<SqlValue>>, PageError> {
        let statement = self
            .conn
            .prepare(sql)
            .map_err(|error| PageError::Store(error.to_string()))?;
        let params: Vec<Option<SqlValue>> = params.iter().cloned().map(Some).collect();
        statement
            .bind(&params)
            .map_err(|error| PageError::Store(error.to_string()))?;
        let mut rows = Vec::new();
        loop {
            let row = statement
                .step()
                .map_err(|error| PageError::Store(error.to_string()))?;
            let Some(row) = row else {
                break;
            };
            rows.push(row);
        }
        Ok(rows)
    }

    /// One statement whose first parameter is this thread's id.
    pub(crate) fn query_thread(
        &self,
        sql: &str,
        params: &[SqlValue],
    ) -> Result<Vec<Vec<SqlValue>>, PageError> {
        let mut all = Vec::with_capacity(params.len() + 1);
        all.push(SqlValue::Text(self.thread_id.clone()));
        all.extend_from_slice(params);
        self.query(sql, &all)
    }

    /// `pageItem(id, type)`: the preview for text items, the stored body otherwise.
    fn page_item(&self, id: &str, item_type: &str) -> Result<Json, PageError> {
        if matches!(item_type, "message" | "notice" | "reasoning") {
            return self.preview(id);
        }
        let rows = self.query(
            "SELECT item, created_seq FROM items WHERE id = ?",
            &[SqlValue::Text(id.to_owned())],
        )?;
        let row = rows.first().ok_or(PageError::MissingItem)?;
        let body = text_at(row, 0)?;
        let created = int_at(row, 1)?;
        stored_item(created as u64, body, &self.trust)
            .map_err(|_| PageError::Store("stored item".to_owned()))
    }

    /// `ItemTextStore.read(id)`: the stored preview, its text read from the stream.
    fn preview(&self, id: &str) -> Result<Json, PageError> {
        let rows = self.query(
            "SELECT p.item, p.target, i.created_seq FROM item_previews p LEFT JOIN items i ON i.id = p.id WHERE p.id = ?",
            &[SqlValue::Text(id.to_owned())],
        )?;
        let row = rows.first().ok_or(PageError::MissingItem)?;
        let body = text_at(row, 0)?;
        let created = match &row[2] {
            SqlValue::Integer(seq) => *seq as u64,
            SqlValue::Real(seq) => *seq as u64,
            // A preview with no item row is decoded (`Number.NEGATIVE_INFINITY`).
            _ => u64::MAX,
        };
        let mut item = stored_item(created, body, &self.trust)
            .map_err(|_| PageError::Store("stored preview".to_owned()))?;
        self.read_preview_text(&mut item)?;
        Ok(item)
    }

    /// Read each source's text into the preview: the first units for finished text, the last
    /// units (offset-marked) for text still streaming.
    fn read_preview_text(&self, item: &mut Json) -> Result<(), PageError> {
        let streaming = !matches!(item.get("complete"), Some(Json::Bool(true)));
        let mut remaining = PREVIEW_UNITS;
        if let Some(Json::Array(parts)) = item.get("parts") {
            let count = parts.len();
            let order: Vec<usize> = if streaming {
                (0..count).rev().collect()
            } else {
                (0..count).collect()
            };
            for index in order {
                let Some(Json::Object(part)) =
                    item.get_mut("parts").and_then(|parts| match parts {
                        Json::Array(items) => items.get_mut(index),
                        _ => None,
                    })
                else {
                    continue;
                };
                if !matches!(part.get("type"), Some(Json::String(kind)) if kind == "text") {
                    continue;
                }
                if !part.contains_key("source") {
                    continue;
                }
                let text = self.read_source(part, streaming, remaining)?;
                remaining -= text.len_utf16();
                part.insert("text", Json::String(text));
            }
            return Ok(());
        }
        if let Json::Object(map) = item
            && map.contains_key("source")
        {
            let text = self.read_source(map, streaming, remaining)?;
            map.insert("text", Json::String(text));
        }
        Ok(())
    }

    /// The source's text: `head` for finished text, `tail` (offset-marked) for streaming text.
    fn read_source(
        &self,
        holder: &mut Map,
        streaming: bool,
        units: usize,
    ) -> Result<JsString, PageError> {
        let Some(Json::Object(source)) = holder.get_mut("source") else {
            return Ok(JsString::new());
        };
        let Some(Json::String(stream_id)) = source.get("streamId") else {
            return Ok(JsString::new());
        };
        let stream = stream_id.as_str().to_owned();
        let bytes = self.stream_size(&stream)? as usize;
        source.insert("bytes", Json::Number(Number::from(bytes as u64)));
        source.remove("offset");
        if streaming {
            let mut start = bytes.saturating_sub(units * 2);
            let mut text = self.units(&stream, start, bytes)?;
            // Never start inside a surrogate pair.
            if text
                .first()
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
            {
                text.remove(0);
                start += 2;
            }
            if start > 0 {
                source.insert("offset", Json::Number(Number::from(start as u64)));
            }
            Ok(JsString::from(String::from_utf16_lossy(&text)))
        } else {
            let text = self.units(&stream, 0, bytes.min(units * 2))?;
            Ok(JsString::from(String::from_utf16_lossy(&text)))
        }
    }

    fn stream_size(&self, stream: &str) -> Result<i64, PageError> {
        let rows = self.query(
            "SELECT size FROM item_text_streams WHERE id = ?",
            &[SqlValue::Text(stream.to_owned())],
        )?;
        rows.first()
            .map(|row| int_at(row, 0))
            .transpose()?
            .ok_or(PageError::MissingItem)
    }

    /// The stream's UTF-16 units `[start, end)`, from the chunks that hold them.
    fn units(&self, stream: &str, start: usize, end: usize) -> Result<Vec<u16>, PageError> {
        if end <= start {
            return Ok(Vec::new());
        }
        let rows = self.query(
            "SELECT offset, bytes FROM item_source_chunks WHERE stream_id = ? AND offset > ? AND offset < ? ORDER BY offset",
            &[
                SqlValue::Text(stream.to_owned()),
                SqlValue::Integer(start as i64 - 65536),
                SqlValue::Integer(end as i64),
            ],
        )?;
        let mut bytes: Vec<u8> = Vec::new();
        for row in rows {
            let offset = int_at(&row, 0)? as usize;
            let Some(SqlValue::Blob(chunk)) = row.get(1) else {
                return Err(PageError::Store("invalid text chunk".to_owned()));
            };
            let from = start.saturating_sub(offset);
            let to = chunk.len().min(end.saturating_sub(offset));
            if to > from {
                bytes.extend_from_slice(&chunk[from..to]);
            }
        }
        Ok(bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect())
    }
}

fn text_at(row: &[SqlValue], index: usize) -> Result<&str, PageError> {
    match row.get(index) {
        Some(SqlValue::Text(text)) => Ok(text.as_str()),
        _ => Err(PageError::Store("invalid index row".to_owned())),
    }
}

fn int_at(row: &[SqlValue], index: usize) -> Result<i64, PageError> {
    match row.get(index) {
        Some(SqlValue::Integer(value)) => Ok(*value),
        Some(SqlValue::Real(value)) => Ok(*value as i64),
        _ => Err(PageError::Store("invalid index row".to_owned())),
    }
}

impl ItemPageSource for SqlItemPage {
    fn page(&self, before: u64, limit: usize, byte_limit: usize) -> Result<PageRows, PageError> {
        let rows = self.query(
            "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
            &[
                SqlValue::Text(self.thread_id.clone()),
                SqlValue::Integer(before as i64),
                SqlValue::Integer(limit as i64 + 1),
            ],
        )?;
        let mut items: Vec<Json> = Vec::new();
        let mut cursors: Vec<(String, u64)> = Vec::new();
        let mut bytes = super::items::ENVELOPE;
        for row in rows.iter().take(limit) {
            let id = text_at(row, 0)?.to_owned();
            let created = int_at(row, 1)? as u64;
            let size = int_at(row, 2)? as usize;
            let item_type = text_at(row, 3)?;
            let overhead = json_bytes(&Json::String(JsString::from(id.as_str()))) + 64;
            let preview = matches!(item_type, "message" | "notice" | "reasoning");
            // Tool and artifact details have no smaller wire preview: refuse them before
            // loading their body when the stored size already does not fit.
            if !preview && bytes + size + overhead > byte_limit {
                if items.is_empty() {
                    return Err(PageError::Capacity);
                }
                break;
            }
            let item = self.page_item(&id, item_type)?;
            let size = if !preview && self.trust.is_trusted(created) {
                size
            } else {
                json_bytes(&item)
            } + overhead;
            if bytes + size > byte_limit {
                if items.is_empty() {
                    return Err(PageError::Capacity);
                }
                break;
            }
            items.push(item);
            cursors.push((id, created));
            bytes += size;
        }
        items.reverse();
        let mut item_seqs = Map::with_capacity(cursors.len());
        for (id, seq) in &cursors {
            item_seqs.insert(id.as_str(), Json::Number(Number::from(*seq)));
        }
        let items_before = if rows.len() > items.len() {
            Some(cursors.last().map(|(_, seq)| *seq).unwrap_or(before))
        } else {
            None
        };
        Ok(PageRows {
            items,
            item_seqs,
            items_before,
        })
    }

    fn newest_before(&self, before: u64) -> Option<(Json, u64)> {
        let rows = self
            .query(
                "SELECT id, created_seq, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT 1",
                &[
                    SqlValue::Text(self.thread_id.clone()),
                    SqlValue::Integer(before as i64),
                ],
            )
            .ok()?;
        let row = rows.first()?;
        let id = text_at(row, 0).ok()?;
        let seq = int_at(row, 1).ok()? as u64;
        let item_type = text_at(row, 2).ok()?;
        Some((self.page_item(id, item_type).ok()?, seq))
    }

    fn has_item_before(&self, before: u64) -> bool {
        self.query(
            "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq < ? LIMIT 1",
            &[
                SqlValue::Text(self.thread_id.clone()),
                SqlValue::Integer(before as i64),
            ],
        )
        .map(|rows| !rows.is_empty())
        .unwrap_or(true)
    }
}
