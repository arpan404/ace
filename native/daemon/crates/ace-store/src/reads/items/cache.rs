// SPDX-License-Identifier: Apache-2.0
use super::fetch::{
    WireData, assemble_candidate, entry_overhead, fetch_wire_data, is_preview_kind, wire_heads,
};
use super::json::{J, json_bytes};
use super::{ReadError, Result, Trust, trusted};
use crate::Connection;
use std::sync::Arc;

/// A cached wire read: heads are read per call, item rows join the shared cache.
pub(crate) struct WindowRead<'a> {
    pub(crate) conn: &'a Arc<Connection>,
    pub(crate) thread_id: &'a str,
    pub(crate) trust: Trust<'a>,
    pub(crate) untrusted: &'a mut Vec<String>,
    pub(crate) cache: &'a mut WireData,
}

pub(crate) struct PageOut {
    pub(crate) items: Vec<J>,
    pub(crate) seqs: Vec<(String, i64)>,
    pub(crate) before: Option<i64>,
}

pub(crate) fn wire_page_cached(
    read: &mut WindowRead,
    before: f64,
    limit: f64,
    byte_limit: f64,
) -> Result<PageOut> {
    let heads = wire_heads(read.conn, read.thread_id, before, limit)?;
    let take = (limit.max(0.0) as usize).min(heads.len());
    let missing: Vec<String> = heads[..take]
        .iter()
        .map(|head| head.id.clone())
        .filter(|id| !read.cache.bodies.contains_key(id) && !read.cache.previews.contains_key(id))
        .collect();
    if !missing.is_empty() {
        let more = fetch_wire_data(read.conn, &missing)?;
        for (id, candidate) in more.bodies {
            read.cache.bodies.insert(id, candidate);
        }
        for (id, preview) in more.previews {
            read.cache.previews.insert(id, preview);
        }
        for (id, size) in more.sizes {
            read.cache.sizes.insert(id, size);
        }
        for (id, rows) in more.bytes {
            read.cache.bytes.entry(id).or_default().extend(rows);
        }
    }
    let mut items: Vec<J> = Vec::new();
    let mut cursors: Vec<(String, i64)> = Vec::new();
    let mut used = 512i64;
    for head in heads.iter().take(take) {
        let overhead = entry_overhead(&head.id);
        let preview = is_preview_kind(&head.kind);
        if !preview && used.saturating_add(head.size).saturating_add(overhead) as f64 > byte_limit {
            if items.is_empty() {
                return Err(ReadError::Capacity);
            }
            break;
        }
        let item =
            assemble_candidate(read.cache, &head.id, &head.kind, read.trust, read.untrusted)?;
        let size = if !preview && trusted(read.trust, head.seq) {
            head.size
        } else {
            json_bytes(&item) as i64
        }
        .saturating_add(overhead);
        if used.saturating_add(size) as f64 > byte_limit {
            if items.is_empty() {
                return Err(ReadError::Capacity);
            }
            break;
        }
        items.push(item);
        cursors.push((head.id.clone(), head.seq));
        used = used.saturating_add(size);
    }
    items.reverse();
    let items_before = if heads.len() > items.len() {
        Some(cursors.last().map_or(before as i64, |(_, seq)| *seq))
    } else {
        None
    };
    Ok(PageOut {
        items,
        seqs: cursors,
        before: items_before,
    })
}
