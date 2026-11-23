// SPDX-License-Identifier: Apache-2.0
//! Text-stream size and byte fetches: the per-source statements `ItemTextStore` issued one by
//! one, run once per call. Bytes go out base64ed; TypeScript decodes them to `Uint8Array` and
//! runs its own slicing, so offsets, surrogate handling and encodings stay identical.

use super::{FetchError, Result, all, rows_json};
use crate::{Connection, Value};
use std::sync::Arc;

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 without line breaks, so JSON can carry SQLite BLOBs. Pure computation over
/// the input bytes; no allocation failure mode the caller must handle beyond the string.
pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = ((u32::from(bytes[index]) << 16)
            | (u32::from(bytes[index + 1]) << 8)
            | u32::from(bytes[index + 2])) as usize;
        out.push(BASE64[(chunk >> 18) & 63] as char);
        out.push(BASE64[(chunk >> 12) & 63] as char);
        out.push(BASE64[(chunk >> 6) & 63] as char);
        out.push(BASE64[chunk & 63] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let chunk = (u32::from(bytes[index]) << 16) as usize;
        out.push(BASE64[(chunk >> 18) & 63] as char);
        out.push(BASE64[(chunk >> 12) & 63] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let chunk = ((u32::from(bytes[index]) << 16) | (u32::from(bytes[index + 1]) << 8)) as usize;
        out.push(BASE64[(chunk >> 18) & 63] as char);
        out.push(BASE64[(chunk >> 12) & 63] as char);
        out.push(BASE64[(chunk >> 6) & 63] as char);
        out.push('=');
    }
    out
}

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
