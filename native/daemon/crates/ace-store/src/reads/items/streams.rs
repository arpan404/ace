// SPDX-License-Identifier: Apache-2.0
//! Text-stream size and byte fetches: the per-source statements `ItemTextStore` issued one by
//! one, run once per call. Bytes travel tagged with their base64 (see `cell_json`), so the
//! shell decodes them and runs its own slicing, keeping offsets, surrogate handling and
//! encodings identical.

use super::{FetchError, Result, all, rows_json};
use crate::{Connection, Value};
use std::sync::Arc;

/// Whole lengths for `stream_ids_json` (a JSON array of stream ids), as `size` reads them.
pub fn stream_sizes(conn: &Arc<Connection>, stream_ids_json: &str) -> Result<String> {
    let rows = all(
        conn,
        "SELECT id, size FROM item_text_streams WHERE id IN (SELECT value FROM json_each(?))",
        &[Value::Text(stream_ids_json.to_owned())],
    )?;
    rows_json(&["id", "size"], &rows)
}

/// Chunk rows holding `[start, end)` for every `{id, start, end}` in `ranges_json` (a JSON
/// array). One statement for the page's every source, instead of one per source.
pub fn stream_bytes(conn: &Arc<Connection>, ranges_json: &str) -> Result<String> {
    if ranges_json.len() > 8 * 1024 * 1024 {
        return Err(FetchError::Input("Invalid text range"));
    }
    let rows = all(
        conn,
        "SELECT c.stream_id, c.offset, c.bytes FROM json_each(?) j
           JOIN item_source_chunks c ON c.stream_id = (j.value ->> 'id')
            AND c.offset > CAST(j.value ->> 'start' AS INTEGER) - 65536
            AND c.offset < CAST(j.value ->> 'end' AS INTEGER)
         ORDER BY 1, 2",
        &[Value::Text(ranges_json.to_owned())],
    )?;
    rows_json(&["stream_id", "offset", "bytes"], &rows)
}
