// SPDX-License-Identifier: Apache-2.0
use super::decode::budget_size;
use super::fetch::{
    WireData, assemble_candidate, entry_overhead, fetch_wire_data, is_preview_kind, wire_heads,
};
use super::json::J;
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
    /// Clipped items the shell must validate: the loader's page shows them only if the
    /// item schema still accepts them cut down.
    pub(crate) validate: Vec<String>,
    /// Creation sequences whose reduced item the shell already rejected: shown as summarized.
    pub(crate) drop_reduced: Vec<i64>,
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
    // The allocation guard from heads alone: a leading run of trusted non-preview heads that
    // cannot fit stops the page before any body is read, as the loader's own pre-check does.
    // Stored sizes are exact there, and previews stop the walk: the loop below decides those.
    let mut fetch_take = take;
    {
        let mut floor = 512i64;
        for (index, head) in heads.iter().enumerate().take(take) {
            if is_preview_kind(&head.kind) || !trusted(read.trust, head.seq) {
                break;
            }
            let overhead = entry_overhead(&head.id);
            if floor.saturating_add(head.size).saturating_add(overhead) as f64 > byte_limit {
                fetch_take = index;
                break;
            }
            floor = floor.saturating_add(head.size).saturating_add(overhead);
        }
    }
    let mut preview_missing = Vec::new();
    let mut body_missing = Vec::new();
    for head in heads[..fetch_take].iter() {
        if read.cache.bodies.contains_key(&head.id) || read.cache.previews.contains_key(&head.id) {
            continue;
        }
        if is_preview_kind(&head.kind) {
            preview_missing.push(head.id.clone());
        } else {
            body_missing.push(head.id.clone());
        }
    }
    if !preview_missing.is_empty() || !body_missing.is_empty() {
        let more = fetch_wire_data(read.conn, &preview_missing, &body_missing)?;
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
        let item = assemble_candidate(
            &*read.cache,
            &head.id,
            &head.kind,
            read.trust,
            read.untrusted,
        )?;
        // Trusted rows are measured as stored; untrusted rows are measured as decoded, the
        // JSON the client gets after the shell's lenient decode.
        let size = if !preview && trusted(read.trust, head.seq) {
            head.size
        } else {
            budget_size(&item, trusted(read.trust, head.seq)) as i64
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
