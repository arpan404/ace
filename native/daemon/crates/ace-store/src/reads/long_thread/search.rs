// SPDX-License-Identifier: Apache-2.0
//! In-thread search, as `@ace/search` `thread-query.ts` reads it.

use super::common::{
    LongError, all_rows, as_count, base64url_decode, base64url_encode, get_row, invalid, row_value,
    sha256_hex,
};
use crate::{Connection, Value};
use std::sync::Arc;

fn extract_terms(text: &str) -> Result<Vec<String>, LongError> {
    let mut terms = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '_' || ch.is_alphanumeric() {
            current.push(ch);
        } else if ch.is_ascii() {
            if !current.is_empty() {
                terms.push(current.clone());
                current.clear();
            }
        } else {
            // Combining marks (`\p{M}`) join a term; anything else ends it.
            let mark = ('\u{300}'..='\u{36f}').contains(&ch)
                || ('\u{1ab0}'..='\u{1aff}').contains(&ch)
                || ('\u{1dc0}'..='\u{1dff}').contains(&ch)
                || ('\u{20d0}'..='\u{20ff}').contains(&ch)
                || ('\u{fe20}'..='\u{fe2f}').contains(&ch);
            if mark {
                current.push(ch);
            } else if !current.is_empty() {
                terms.push(current.clone());
                current.clear();
            }
        }
    }
    if !current.is_empty() {
        terms.push(current);
    }
    if terms.is_empty() || terms.len() > 64 {
        return Err(invalid("search_invalid_query"));
    }
    Ok(terms)
}

fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

fn snippet(marked: &str) -> serde_json::Value {
    let chars: Vec<char> = marked.chars().collect();
    let mut first = usize::MAX;
    for (index, ch) in chars.iter().enumerate() {
        if *ch == '\u{1}' {
            first = index;
            break;
        }
    }
    let mut offset = 0usize;
    if chars.len() > 4096 && first != usize::MAX && first > 256 {
        offset = first - 256;
    }
    let source: Vec<char> = if offset > 0 {
        let mut prefixed = vec!['…'];
        prefixed.extend_from_slice(&chars[offset..]);
        prefixed
    } else {
        chars
    };
    let mut text = String::new();
    let mut highlights = Vec::new();
    let mut start: Option<usize> = None;
    for ch in source {
        if ch == '\u{1}' {
            start = Some(text.len());
        } else if ch == '\u{2}' {
            if let Some(begin) = start {
                if highlights.len() < 256 {
                    highlights.push(serde_json::json!({"start": begin, "end": text.len()}));
                }
                start = None;
            }
        } else {
            if text.len() + ch.len_utf8() > 4096 {
                break;
            }
            text.push(ch);
        }
    }
    if let Some(begin) = start
        && highlights.len() < 256
    {
        highlights.push(serde_json::json!({"start": begin, "end": text.len()}));
    }
    serde_json::json!({"text": text, "highlights": highlights})
}

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
    let fingerprint_input = if let Some(filter) = filter {
        let mut map = serde_json::Map::new();
        map.insert(
            "text".to_owned(),
            serde_json::Value::String(trimmed.to_owned()),
        );
        map.insert(
            "filter".to_owned(),
            serde_json::Value::String(filter.to_owned()),
        );
        map.insert(
            "scope".to_owned(),
            serde_json::Value::String(scope.to_owned()),
        );
        map.insert(
            "threadIds".to_owned(),
            serde_json::Value::Array(
                sorted_ids
                    .iter()
                    .map(|id| serde_json::Value::String(id.clone()))
                    .collect(),
            ),
        );
        serde_json::Value::Object(map)
    } else {
        let mut map = serde_json::Map::new();
        map.insert(
            "text".to_owned(),
            serde_json::Value::String(trimmed.to_owned()),
        );
        map.insert(
            "scope".to_owned(),
            serde_json::Value::String(scope.to_owned()),
        );
        map.insert(
            "threadIds".to_owned(),
            serde_json::Value::Array(
                sorted_ids
                    .iter()
                    .map(|id| serde_json::Value::String(id.clone()))
                    .collect(),
            ),
        );
        serde_json::Value::Object(map)
    };
    let fingerprint_text =
        serde_json::to_string(&fingerprint_input).map_err(|error| invalid(&error.to_string()))?;
    let fingerprint = sha256_hex(&fingerprint_text);
    let mut cursor_id = 0i64;
    let mut ceiling: Option<i64> = None;
    let mut anchor: Option<String> = None;
    if let Some(cursor_text) = cursor {
        let decoded = base64url_decode(cursor_text)?;
        let value: serde_json::Value =
            serde_json::from_str(&decoded).map_err(|_| invalid("search_invalid_query"))?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let cursor_fingerprint = object
            .get("fingerprint")
            .and_then(|value| value.as_str())
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let id = object
            .get("id")
            .and_then(|value| value.as_i64())
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let ceiling_value = object
            .get("ceiling")
            .and_then(|value| value.as_i64())
            .ok_or_else(|| invalid("search_invalid_query"))?;
        let anchor_value = object
            .get("anchor")
            .and_then(|value| value.as_str())
            .ok_or_else(|| invalid("search_invalid_query"))?;
        if cursor_fingerprint.len() != 64
            || id < 1
            || ceiling_value < 0
            || anchor_value.is_empty()
            || anchor_value.len() > 514
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
            let rows = all_rows(
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
    let _required_json =
        serde_json::to_string(&required).map_err(|error| invalid(&error.to_string()))?;
    let ceiling_value = if let Some(ceiling) = ceiling {
        ceiling
    } else {
        let row = get_row(
            conn,
            "SELECT COALESCE(MAX(id),0) AS ceiling FROM search_full_chunks",
            Vec::new(),
        )?;
        match row.as_ref().and_then(|row| row.get("ceiling")) {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => 0,
        }
    };
    let thread_ids_json =
        serde_json::to_string(&thread_ids).map_err(|error| invalid(&error.to_string()))?;
    let required_json =
        serde_json::to_string(&required).map_err(|error| invalid(&error.to_string()))?;
    const POSTINGS_SQL: &str = "SELECT c.id FROM search_full_fts JOIN search_full_chunks c ON c.id=search_full_fts.rowid WHERE search_full_fts MATCH ? AND search_full_fts.rowid>? AND search_full_fts.rowid<=? AND NOT EXISTS(SELECT 1 FROM search_tombstones t WHERE t.thread=c.thread) AND c.thread IN (SELECT value FROM json_each(?)) ORDER BY search_full_fts.rowid LIMIT ?";
    const POSTINGS_FILTER_SQL: &str = "SELECT c.id FROM search_full_fts JOIN search_full_chunks c ON c.id=search_full_fts.rowid WHERE search_full_fts MATCH ? AND search_full_fts.rowid>? AND search_full_fts.rowid<=? AND NOT EXISTS(SELECT 1 FROM search_tombstones t WHERE t.thread=c.thread) AND c.thread IN (SELECT value FROM json_each(?)) AND c.category=? ORDER BY search_full_fts.rowid LIMIT ?";
    let postings = if let Some(filter) = filter {
        all_rows(
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
        all_rows(
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
        let id = match row.get("id") {
            Some(Value::Integer(n)) => *n,
            Some(Value::Real(n)) => *n as i64,
            _ => return Err(invalid("invalid index row")),
        };
        if id < 1 {
            return Err(invalid("invalid index row"));
        }
        posting_ids.push(id);
    }
    let candidates = posting_ids.iter().take(128).cloned().collect::<Vec<_>>();
    let mut rows: Vec<std::collections::BTreeMap<String, Value>> = Vec::new();
    if !candidates.is_empty() {
        let candidates_json =
            serde_json::to_string(&candidates).map_err(|error| invalid(&error.to_string()))?;
        let highlight = format!("body : ({})", terms.join(" OR "));
        let anchor_expr = format!("body : ({anchor_term})");
        const CANDIDATES_SQL: &str = "WITH selected AS MATERIALIZED (SELECT c.id FROM json_each(?) candidate CROSS JOIN search_full_chunks c WHERE c.id=candidate.value AND NOT EXISTS(SELECT 1 FROM search_full_chunks earlier CROSS JOIN search_full_fts WHERE earlier.thread=c.thread AND earlier.item=c.item AND search_full_fts.rowid=earlier.id AND earlier.id<c.id AND search_full_fts MATCH ?) AND NOT EXISTS(SELECT 1 FROM json_each(?) req WHERE NOT EXISTS(SELECT 1 FROM search_full_chunks term_chunk CROSS JOIN search_full_fts WHERE term_chunk.thread=c.thread AND term_chunk.item=c.item AND search_full_fts.rowid=term_chunk.id AND term_chunk.id<=? AND search_full_fts MATCH req.value)) ORDER BY c.id LIMIT ?) SELECT c.id,c.thread,c.item,c.seq,snippet(search_full_fts,0,char(1),char(2),'…',40) AS marked FROM selected s CROSS JOIN search_full_chunks c CROSS JOIN search_full_fts WHERE c.id=s.id AND search_full_fts.rowid=s.id AND search_full_fts MATCH ? ORDER BY c.id";
        const CANDIDATES_FILTER_SQL: &str = "WITH selected AS MATERIALIZED (SELECT c.id FROM json_each(?) candidate CROSS JOIN search_full_chunks c WHERE c.id=candidate.value AND NOT EXISTS(SELECT 1 FROM search_full_chunks earlier CROSS JOIN search_full_fts WHERE earlier.thread=c.thread AND earlier.item=c.item AND search_full_fts.rowid=earlier.id AND earlier.id<c.id AND earlier.category=c.category AND search_full_fts MATCH ?) AND NOT EXISTS(SELECT 1 FROM json_each(?) req WHERE NOT EXISTS(SELECT 1 FROM search_full_chunks term_chunk CROSS JOIN search_full_fts WHERE term_chunk.thread=c.thread AND term_chunk.item=c.item AND search_full_fts.rowid=term_chunk.id AND term_chunk.id<=? AND term_chunk.category=? AND search_full_fts MATCH req.value)) ORDER BY c.id LIMIT ?) SELECT c.id,c.thread,c.item,c.seq,snippet(search_full_fts,0,char(1),char(2),'…',40) AS marked FROM selected s CROSS JOIN search_full_chunks c CROSS JOIN search_full_fts WHERE c.id=s.id AND search_full_fts.rowid=s.id AND search_full_fts MATCH ? ORDER BY c.id";
        if let Some(filter) = filter {
            rows = all_rows(
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
            rows = all_rows(
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
    let mut hits = Vec::new();
    let mut parsed: Vec<(String, String, i64, String)> = Vec::new();
    for row in rows.iter().take(limit as usize) {
        let thread = match row_value(row, "thread")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        let item = match row_value(row, "item")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        if thread.is_empty() || item.is_empty() {
            return Err(invalid("invalid index row"));
        }
        let seq = match row_value(row, "seq")? {
            Value::Integer(n) => *n,
            Value::Real(n) => *n as i64,
            _ => return Err(invalid("invalid index row")),
        };
        as_count(&Value::Integer(seq))?;
        let marked = match row_value(row, "marked")? {
            Value::Text(text) => text.clone(),
            _ => return Err(invalid("invalid index row")),
        };
        parsed.push((thread, item, seq, marked));
    }
    let ordinal_map = if parsed.is_empty() {
        std::collections::BTreeMap::new()
    } else {
        let threads_json = serde_json::to_string(
            &parsed
                .iter()
                .map(|(thread, _, _, _)| thread.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(|error| invalid(&error.to_string()))?;
        let items_json = serde_json::to_string(
            &parsed
                .iter()
                .map(|(_, item, _, _)| item.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(|error| invalid(&error.to_string()))?;
        let ordinal_rows = all_rows(
            conn,
            "SELECT thread_id,item_id,ordinal FROM long_items WHERE thread_id IN (SELECT value FROM json_each(?)) AND item_id IN (SELECT value FROM json_each(?))",
            vec![Value::Text(threads_json), Value::Text(items_json)],
        )?;
        let mut map = std::collections::BTreeMap::new();
        for row in ordinal_rows {
            let thread = match row.get("thread_id") {
                Some(Value::Text(text)) => text.clone(),
                _ => continue,
            };
            let item = match row.get("item_id") {
                Some(Value::Text(text)) => text.clone(),
                _ => continue,
            };
            let ordinal = match row.get("ordinal") {
                Some(Value::Integer(n)) => *n,
                Some(Value::Real(n)) => *n as i64,
                _ => continue,
            };
            map.insert((thread, item), ordinal);
        }
        map
    };
    for (thread, item, seq, marked) in parsed {
        let ordinal = ordinal_map.get(&(thread.clone(), item.clone())).copied();
        if let Some(ordinal) = ordinal
            && ordinal < 1
        {
            return Err(invalid("invalid index row"));
        }
        let mut hit = serde_json::Map::new();
        hit.insert("threadId".to_owned(), serde_json::Value::String(thread));
        hit.insert("itemId".to_owned(), serde_json::Value::String(item));
        hit.insert("seq".to_owned(), serde_json::Value::Number(seq.into()));
        hit.insert(
            "turnOrdinal".to_owned(),
            ordinal.map_or(serde_json::Value::Null, |ordinal| {
                serde_json::Value::Number(ordinal.into())
            }),
        );
        hit.insert("snippet".to_owned(), snippet(&marked));
        hits.push(serde_json::Value::Object(hit));
    }
    let next_id = if (rows.len() as i64) > limit {
        hits.last().and_then(|_hit| {
            rows.get(hits.len().saturating_sub(1))
                .and_then(|row| match row.get("id") {
                    Some(Value::Integer(n)) => Some(*n),
                    Some(Value::Real(n)) => Some(*n as i64),
                    _ => None,
                })
        })
    } else if posting_ids.len() > 128 {
        candidates.last().copied()
    } else {
        None
    };
    let meta = get_row(
        conn,
        "SELECT seq,pending FROM search_full_meta WHERE id=1",
        Vec::new(),
    )?
    .ok_or_else(|| invalid("invalid index row"))?;
    let meta_seq = match row_value(&meta, "seq")? {
        Value::Integer(n) => *n,
        Value::Real(n) => *n as i64,
        _ => return Err(invalid("invalid index row")),
    };
    let meta_pending = match row_value(&meta, "pending")? {
        Value::Integer(n) => *n,
        Value::Real(n) => *n as i64,
        _ => return Err(invalid("invalid index row")),
    };
    as_count(&Value::Integer(meta_seq))?;
    as_count(&Value::Integer(meta_pending))?;
    let cursor_out = if let Some(next) = next_id {
        let mut map = serde_json::Map::new();
        map.insert(
            "fingerprint".to_owned(),
            serde_json::Value::String(fingerprint.clone()),
        );
        map.insert("id".to_owned(), serde_json::Value::Number(next.into()));
        map.insert(
            "ceiling".to_owned(),
            serde_json::Value::Number(ceiling_value.into()),
        );
        map.insert(
            "anchor".to_owned(),
            serde_json::Value::String(anchor_term.clone()),
        );
        let text = serde_json::to_string(&serde_json::Value::Object(map))
            .map_err(|error| invalid(&error.to_string()))?;
        serde_json::Value::String(base64url_encode(&text))
    } else {
        serde_json::Value::Null
    };
    let long_indexed = super::turns::digest_indexed_seq(conn)?;
    let indexed = meta_seq.min(long_indexed);
    as_count(&Value::Integer(indexed))?;
    as_count(&Value::Integer(head_seq))?;
    let ready = meta_seq == head_seq && meta_pending == 0 && indexed >= head_seq;
    let mut response = serde_json::Map::new();
    response.insert(
        "type".to_owned(),
        serde_json::Value::String("thread.search".to_owned()),
    );
    response.insert(
        "requestId".to_owned(),
        serde_json::Value::String(request_id.to_owned()),
    );
    response.insert(
        "threadId".to_owned(),
        serde_json::Value::String(thread_id.to_owned()),
    );
    response.insert("hits".to_owned(), serde_json::Value::Array(hits));
    response.insert("cursor".to_owned(), cursor_out);
    response.insert(
        "indexedSeq".to_owned(),
        serde_json::Value::Number(indexed.into()),
    );
    response.insert(
        "headSeq".to_owned(),
        serde_json::Value::Number(head_seq.into()),
    );
    response.insert(
        "pending".to_owned(),
        serde_json::Value::Number(meta_pending.into()),
    );
    response.insert("ready".to_owned(), serde_json::Value::Bool(ready));
    let text = serde_json::to_string(&serde_json::Value::Object(response))
        .map_err(|error| invalid(&error.to_string()))?;
    Ok(text)
}
