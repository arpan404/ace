// SPDX-License-Identifier: Apache-2.0
//! In-thread search, as `@ace/search` `thread-query.ts` reads it.

use super::super::common::{
    LongError, all_rows_raw, base64url_decode, base64url_encode, get_row_raw, invalid, js_len,
};
use super::super::row::{int_at, strs_json, text_at};
use super::super::turns::digest_indexed_seq;
use super::emit::{HighlightOut, Hit, SearchPage, SnippetOut};
use super::hits::{HitRow, snippet};
use super::terms::{CursorJson, cursor_json, extract_terms, fingerprint_text, quote, raw_int};
use crate::{Connection, Value};
use std::sync::Arc;

#[allow(clippy::too_many_arguments)]
pub fn thread_search(
    conn: &Arc<Connection>,
    thread_id: &str,
    request_id: &str,
    text: &str,
    scope: &str,
    filter: Option<&str>,
    limit: i64,
    cursor: Option<&str>,
    thread_ids: &[String],
    head_seq: i64,
) -> Result<String, LongError> {
    if !(1..=100).contains(&limit) {
        return Err(invalid("search_invalid_query"));
    }
    if thread_ids.len() > 1024 || !thread_ids.contains(&thread_id.to_owned()) {
        return Err(invalid("search_invalid_query"));
    }
    for id in thread_ids {
        if id.is_empty() {
            return Err(invalid("search_invalid_query"));
        }
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(invalid("search_invalid_query"));
    }
    let raw_terms = extract_terms(trimmed)?;
    let terms: Vec<String> = raw_terms.iter().map(|term| format!("\"{term}\"")).collect();
    let mut sorted_ids = thread_ids.to_vec();
    if scope == "tree" {
        sorted_ids.sort();
    }
    let fingerprint_input = fingerprint_text(trimmed, filter, scope, &sorted_ids)?;
    let fingerprint = super::super::common::sha256_hex(&fingerprint_input);
    let mut cursor_id = 0i64;
    let mut ceiling: Option<i64> = None;
    let mut anchor: Option<String> = None;
    if let Some(cursor_text) = cursor {
        let decoded = base64url_decode(cursor_text)?;
        let value: CursorJson<'_> =
            serde_json::from_str(&decoded).map_err(|_| invalid("search_invalid_query"))?;
        let cursor_fingerprint = value
            .fingerprint
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let id = value
            .id
            .as_ref()
            .map(|raw| raw_int(raw))
            .transpose()?
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let ceiling_value = value
            .ceiling
            .as_ref()
            .map(|raw| raw_int(raw))
            .transpose()?
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let anchor_value = value
            .anchor
            .ok_or_else(|| invalid("search_invalid_query"))?;
        if cursor_fingerprint.len() != 64
            || id < 1
            || ceiling_value < 0
            || anchor_value.is_empty()
            || js_len(anchor_value) > 514
        {
            return Err(invalid("search_invalid_query"));
        }
        if cursor_fingerprint != fingerprint {
            return Err(invalid("search_invalid_query"));
        }
        if !terms.contains(&anchor_value.to_owned()) {
            return Err(invalid("search_invalid_query"));
        }
        cursor_id = id;
        ceiling = Some(ceiling_value);
        anchor = Some(anchor_value.to_owned());
    }
    let mut anchor_term = anchor.clone().unwrap_or_default();
    if anchor_term.is_empty() {
        anchor_term = terms.first().cloned().unwrap_or_default();
    }
    if cursor.is_none() && terms.len() > 1 {
        let mut smallest = 65i64;
        let mut best = anchor_term.clone();
        for term in &terms {
            let expression = format!("body : ({term})");
            let rows = all_rows_raw(
                conn,
                "SELECT rowid FROM search_full_fts WHERE search_full_fts MATCH ? ORDER BY rowid LIMIT 64",
                vec![Value::Text(expression)],
            )?;
            let frequency = rows.len() as i64;
            if frequency <= smallest {
                best = term.clone();
                smallest = frequency;
            }
        }
        anchor_term = best;
    }
    if anchor_term.is_empty() {
        return Err(invalid("search_invalid_query"));
    }
    let scope_expression = if scope == "tree" || thread_ids.len() == 1 && scope == "thread" {
        let mut expression = format!(
            " AND thread : ({})",
            sorted_ids
                .iter()
                .map(|id| quote(id))
                .collect::<Vec<_>>()
                .join(" OR ")
        );
        if let Some(filter) = filter {
            expression.push_str(&format!(" AND category : {}", quote(filter)));
        }
        expression
    } else {
        String::new()
    };
    let expression = format!("body : ({anchor_term}){scope_expression}");
    let required: Vec<String> = terms
        .iter()
        .filter(|term| *term != &anchor_term)
        .map(|term| format!("body : ({term})"))
        .collect();
    let ceiling_value = if let Some(ceiling) = ceiling {
        ceiling
    } else {
        let row = get_row_raw(
            conn,
            "SELECT COALESCE(MAX(id),0) AS ceiling FROM search_full_chunks",
            Vec::new(),
        )?;
        match row.as_ref().and_then(|row| row.first()) {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => 0,
        }
    };
    let thread_ids_json = strs_json(thread_ids)?;
    let mut required_json = String::with_capacity(required.len() * 32 + 2);
    required_json.push('[');
    for (index, term) in required.iter().enumerate() {
        if index > 0 {
            required_json.push(',');
        }
        required_json.push_str(&super::super::row::json_string(term)?);
    }
    required_json.push(']');
    const POSTINGS_SQL: &str = "SELECT c.id FROM search_full_fts JOIN search_full_chunks c ON c.id=search_full_fts.rowid WHERE search_full_fts MATCH ? AND search_full_fts.rowid>? AND search_full_fts.rowid<=? AND NOT EXISTS(SELECT 1 FROM search_tombstones t WHERE t.thread=c.thread) AND c.thread IN (SELECT value FROM json_each(?)) ORDER BY search_full_fts.rowid LIMIT ?";
    const POSTINGS_FILTER_SQL: &str = "SELECT c.id FROM search_full_fts JOIN search_full_chunks c ON c.id=search_full_fts.rowid WHERE search_full_fts MATCH ? AND search_full_fts.rowid>? AND search_full_fts.rowid<=? AND NOT EXISTS(SELECT 1 FROM search_tombstones t WHERE t.thread=c.thread) AND c.thread IN (SELECT value FROM json_each(?)) AND c.category=? ORDER BY search_full_fts.rowid LIMIT ?";
    let postings = if let Some(filter) = filter {
        all_rows_raw(
            conn,
            POSTINGS_FILTER_SQL,
            vec![
                Value::Text(expression.clone()),
                Value::Integer(cursor_id),
                Value::Integer(ceiling_value),
                Value::Text(thread_ids_json.clone()),
                Value::Text(filter.to_owned()),
                Value::Integer(129),
            ],
        )?
    } else {
        all_rows_raw(
            conn,
            POSTINGS_SQL,
            vec![
                Value::Text(expression.clone()),
                Value::Integer(cursor_id),
                Value::Integer(ceiling_value),
                Value::Text(thread_ids_json.clone()),
                Value::Integer(129),
            ],
        )?
    };
    let mut posting_ids = Vec::new();
    for row in postings.iter().take(129) {
        let id = int_at(row, 0)?;
        if id < 1 {
            return Err(invalid("invalid index row"));
        }
        posting_ids.push(id);
    }
    let candidates = posting_ids.iter().take(128).cloned().collect::<Vec<_>>();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    if !candidates.is_empty() {
        let mut candidates_json = String::with_capacity(candidates.len() * 8 + 2);
        candidates_json.push('[');
        for (index, id) in candidates.iter().enumerate() {
            if index > 0 {
                candidates_json.push(',');
            }
            candidates_json.push_str(&id.to_string());
        }
        candidates_json.push(']');
        let highlight = format!("body : ({})", terms.join(" OR "));
        let anchor_expr = format!("body : ({anchor_term})");
        const CANDIDATES_SQL: &str = "WITH selected AS MATERIALIZED (SELECT c.id FROM json_each(?) candidate CROSS JOIN search_full_chunks c WHERE c.id=candidate.value AND NOT EXISTS(SELECT 1 FROM search_full_chunks earlier CROSS JOIN search_full_fts WHERE earlier.thread=c.thread AND earlier.item=c.item AND search_full_fts.rowid=earlier.id AND earlier.id<c.id AND search_full_fts MATCH ?) AND NOT EXISTS(SELECT 1 FROM json_each(?) req WHERE NOT EXISTS(SELECT 1 FROM search_full_chunks term_chunk CROSS JOIN search_full_fts WHERE term_chunk.thread=c.thread AND term_chunk.item=c.item AND search_full_fts.rowid=term_chunk.id AND term_chunk.id<=? AND search_full_fts MATCH req.value)) ORDER BY c.id LIMIT ?) SELECT c.id,c.thread,c.item,c.seq,snippet(search_full_fts,0,char(1),char(2),'…',40) AS marked FROM selected s CROSS JOIN search_full_chunks c CROSS JOIN search_full_fts WHERE c.id=s.id AND search_full_fts.rowid=s.id AND search_full_fts MATCH ? ORDER BY c.id";
        const CANDIDATES_FILTER_SQL: &str = "WITH selected AS MATERIALIZED (SELECT c.id FROM json_each(?) candidate CROSS JOIN search_full_chunks c WHERE c.id=candidate.value AND NOT EXISTS(SELECT 1 FROM search_full_chunks earlier CROSS JOIN search_full_fts WHERE earlier.thread=c.thread AND earlier.item=c.item AND search_full_fts.rowid=earlier.id AND earlier.id<c.id AND earlier.category=c.category AND search_full_fts MATCH ?) AND NOT EXISTS(SELECT 1 FROM json_each(?) req WHERE NOT EXISTS(SELECT 1 FROM search_full_chunks term_chunk CROSS JOIN search_full_fts WHERE term_chunk.thread=c.thread AND term_chunk.item=c.item AND search_full_fts.rowid=term_chunk.id AND term_chunk.id<=? AND term_chunk.category=? AND search_full_fts MATCH req.value)) ORDER BY c.id LIMIT ?) SELECT c.id,c.thread,c.item,c.seq,snippet(search_full_fts,0,char(1),char(2),'…',40) AS marked FROM selected s CROSS JOIN search_full_chunks c CROSS JOIN search_full_fts WHERE c.id=s.id AND search_full_fts.rowid=s.id AND search_full_fts MATCH ? ORDER BY c.id";
        if let Some(filter) = filter {
            rows = all_rows_raw(
                conn,
                CANDIDATES_FILTER_SQL,
                vec![
                    Value::Text(candidates_json),
                    Value::Text(anchor_expr),
                    Value::Text(required_json.clone()),
                    Value::Integer(ceiling_value),
                    Value::Text(filter.to_owned()),
                    Value::Integer(limit + 1),
                    Value::Text(highlight),
                ],
            )?;
        } else {
            rows = all_rows_raw(
                conn,
                CANDIDATES_SQL,
                vec![
                    Value::Text(candidates_json),
                    Value::Text(anchor_expr),
                    Value::Text(required_json.clone()),
                    Value::Integer(ceiling_value),
                    Value::Integer(limit + 1),
                    Value::Text(highlight),
                ],
            )?;
        }
    }
    let mut parsed: Vec<HitRow> = Vec::new();
    for row in rows.iter().take(limit as usize) {
        let thread = text_at(row, 1)?.to_owned();
        let item = text_at(row, 2)?.to_owned();
        if thread.is_empty() || item.is_empty() {
            return Err(invalid("invalid index row"));
        }
        let seq = super::super::common::check_count(int_at(row, 3)?)?;
        let marked = text_at(row, 4)?.to_owned();
        parsed.push(HitRow {
            thread,
            item,
            seq,
            marked,
        });
    }
    let ordinal_map = if parsed.is_empty() {
        Vec::new()
    } else {
        let threads_json = strs_json(
            &parsed
                .iter()
                .map(|hit| hit.thread.clone())
                .collect::<Vec<_>>(),
        )?;
        let items_json = strs_json(
            &parsed
                .iter()
                .map(|hit| hit.item.clone())
                .collect::<Vec<_>>(),
        )?;
        let ordinal_rows = all_rows_raw(
            conn,
            "SELECT thread_id,item_id,ordinal FROM long_items WHERE thread_id IN (SELECT value FROM json_each(?)) AND item_id IN (SELECT value FROM json_each(?))",
            vec![Value::Text(threads_json), Value::Text(items_json)],
        )?;
        let mut map = Vec::new();
        for row in ordinal_rows {
            let thread = text_at(&row, 0)?.to_owned();
            let item = text_at(&row, 1)?.to_owned();
            let ordinal = int_at(&row, 2)?;
            map.push(((thread, item), ordinal));
        }
        map
    };
    let mut hits = Vec::new();
    for hit in &parsed {
        let ordinal = ordinal_map
            .iter()
            .find(|((thread, item), _)| thread == &hit.thread && item == &hit.item)
            .map(|(_, ordinal)| *ordinal);
        if let Some(ordinal) = ordinal
            && ordinal < 1
        {
            return Err(invalid("invalid index row"));
        }
        let made = snippet(&hit.marked);
        hits.push(Hit {
            thread_id: hit.thread.as_str(),
            item_id: hit.item.as_str(),
            seq: hit.seq,
            turn_ordinal: ordinal,
            snippet: SnippetOut {
                text: made.text,
                highlights: made
                    .highlights
                    .into_iter()
                    .map(|highlight| HighlightOut {
                        start: highlight.start,
                        end: highlight.end,
                    })
                    .collect(),
            },
        });
    }
    let next_id = if (rows.len() as i64) > limit {
        rows.get(hits.len().saturating_sub(1))
            .and_then(|row| row.first())
            .and_then(|value| match value {
                Value::Integer(n) => Some(*n),
                Value::Real(n) => Some(*n as i64),
                _ => None,
            })
    } else if posting_ids.len() > 128 {
        candidates.last().copied()
    } else {
        None
    };
    let meta = get_row_raw(
        conn,
        "SELECT seq,pending FROM search_full_meta WHERE id=1",
        Vec::new(),
    )?
    .ok_or_else(|| invalid("invalid index row"))?;
    let meta_seq = super::super::common::check_count(int_at(&meta, 0)?)?;
    let meta_pending = super::super::common::check_count(int_at(&meta, 1)?)?;
    let cursor_out = if let Some(next) = next_id {
        Some(base64url_encode(&cursor_json(
            &fingerprint,
            next,
            ceiling_value,
            &anchor_term,
        )?))
    } else {
        None
    };
    let long_indexed = digest_indexed_seq(conn)?;
    let indexed = meta_seq.min(long_indexed);
    super::super::common::check_count(indexed)?;
    super::super::common::check_count(head_seq)?;
    let ready = meta_seq == head_seq && meta_pending == 0 && indexed >= head_seq;
    let response = SearchPage {
        type_: "thread.search",
        request_id,
        thread_id,
        hits,
        cursor: cursor_out,
        indexed_seq: indexed,
        head_seq,
        pending: meta_pending,
        ready,
    };
    let mut out = Vec::with_capacity(4096);
    serde_json::to_writer(&mut out, &response).map_err(|error| invalid(&error.to_string()))?;
    String::from_utf8(out).map_err(|_| invalid("invalid index row"))
}
