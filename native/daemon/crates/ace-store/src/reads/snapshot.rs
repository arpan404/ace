// SPDX-License-Identifier: Apache-2.0
//! Thread snapshot read to the wire (T4): ports `retainedTail` (`packages/projection/src/item-order.ts`),
//! `ItemStore.tail` / `materializeAll` / `withChunks` (`item-store.ts`), `loadThreadSnapshot`
//! (`thread-snapshot.ts`), and `ThreadReads.snapshotThread` (`thread-reads.ts`).
//!
//! Reads a detached `ThreadView` with exact `createThreadView` field ordering and ADR 0062
//! root-lane 50% tail reservation, folding unmerged `item_text_chunks` atomically and falling
//! back to a bounded preview for a single oversized newest item.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use ace_json::{Array, JsString, Map, Number, Value as Json};
use ace_projection::wire_thread_view;

use crate::reads::entity_window::{
    EntityReadError, fill_snapshot_entities, rebuild_agent_children, retain_agents_for_maps,
};
use crate::reads::item_page_sql::SqlItemPage;
use crate::reads::items::json_bytes;
use crate::reads::stored::{Trust, stored_item};
use crate::reads::thread_row::{ThreadRowError, read_thread_row};
use crate::{Connection, Value as SqlValue};

/// How much transcript a thread snapshot carries: its newest items, by count and bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotTail {
    pub items: usize,
    pub bytes: usize,
}

/// What a snapshot carries when the subscriber asks for no smaller tail (`fullTail`).
pub const FULL_TAIL: SnapshotTail = SnapshotTail {
    items: 200,
    bytes: 1024 * 1024,
};

/// Errors reading a thread snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    UnknownThread,
    MissingItemBody,
    ThreadRow(ThreadRowError),
    Entities(EntityReadError),
    Store(String),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotError::UnknownThread => write!(f, "Unknown thread"),
            SnapshotError::MissingItemBody => write!(f, "Missing item body"),
            SnapshotError::ThreadRow(e) => write!(f, "{e}"),
            SnapshotError::Entities(e) => write!(f, "{e}"),
            SnapshotError::Store(e) => write!(f, "store error: {e}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

impl From<ThreadRowError> for SnapshotError {
    fn from(e: ThreadRowError) -> Self {
        SnapshotError::ThreadRow(e)
    }
}

impl From<EntityReadError> for SnapshotError {
    fn from(e: EntityReadError) -> Self {
        SnapshotError::Entities(e)
    }
}

/// One held item candidate in creation order (`TailEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailEntry {
    pub id: String,
    pub seq: Option<u64>,
    pub root: bool,
}

/// Output of [`retained_tail`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedTail {
    pub kept: Vec<TailEntry>,
    pub evicted: Vec<TailEntry>,
    pub before: Option<u64>,
}

/// ADR 0006 / ADR 0062 live-tail retention: keeps the newest `capacity` items while reserving at
/// least half (`capacity / 2`) for the root lane (`root == true`). Both lanes remain contiguous
/// from their oldest kept item.
pub fn retained_tail(entries: &[TailEntry], capacity: usize) -> RetainedTail {
    if entries.len() <= capacity {
        return RetainedTail {
            kept: entries.to_vec(),
            evicted: Vec::new(),
            before: None,
        };
    }
    let reserve = capacity / 2;
    let recent_start = entries.len() - capacity;
    let mut roots = 0_usize;
    let mut recent_roots = 0_usize;
    for (index, entry) in entries.iter().enumerate() {
        if entry.root {
            roots += 1;
            if index >= recent_start {
                recent_roots += 1;
            }
        }
    }
    let mut keep_roots = recent_roots.max(roots.min(reserve));
    let mut keep_others = capacity.saturating_sub(keep_roots);
    let mut keep = vec![false; entries.len()];
    for index in (0..entries.len()).rev() {
        if entries[index].root {
            if keep_roots > 0 {
                keep_roots -= 1;
                keep[index] = true;
            }
        } else if keep_others > 0 {
            keep_others -= 1;
            keep[index] = true;
        }
    }
    let mut kept = Vec::new();
    let mut evicted = Vec::new();
    let mut newest_evicted: Option<usize> = None;
    for (index, entry) in entries.iter().enumerate() {
        if keep[index] {
            kept.push(entry.clone());
        } else {
            evicted.push(entry.clone());
            newest_evicted = Some(index);
        }
    }
    let before = newest_evicted.and_then(|idx| {
        entries[idx + 1..]
            .iter()
            .find_map(|entry| entry.seq)
            .or_else(|| entries[idx].seq.map(|seq| seq + 1))
    });
    RetainedTail {
        kept,
        evicted,
        before,
    }
}

/// Output of [`item_tail`].
#[derive(Debug)]
pub struct TailPage {
    pub items: Vec<Json>,
    pub item_seqs: Map,
    pub items_before: Option<u64>,
    pub previewed: Vec<String>,
}

/// `ItemStore.tail(threadId, rootAgentId, limit, byteLimit)`: reads at most 3 indexed queries
/// on `item_heads`, trims by `retained_tail` and byte budget, and materializes items (or the
/// bounded preview if the single newest item alone exceeds `byte_limit`).
pub fn item_tail(
    conn: Arc<Connection>,
    thread_id: &str,
    root_agent_id: Option<&str>,
    tail: SnapshotTail,
    trust: &Trust,
) -> Result<TailPage, SnapshotError> {
    let half = tail.items / 2;
    let mut by_seq: BTreeMap<u64, (String, usize, String)> = BTreeMap::new();

    collect_tail_heads(
        &conn,
        "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ? ORDER BY created_seq DESC LIMIT ?",
        &[
            SqlValue::Text(thread_id.to_owned()),
            SqlValue::Integer((tail.items + 1) as i64),
        ],
        &mut by_seq,
    )?;
    if let Some(root_id) = root_agent_id {
        collect_tail_heads(
            &conn,
            "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ? AND agent_id = ? ORDER BY created_seq DESC LIMIT ?",
            &[
                SqlValue::Text(thread_id.to_owned()),
                SqlValue::Text(root_id.to_owned()),
                SqlValue::Integer(half as i64),
            ],
            &mut by_seq,
        )?;
    }
    collect_tail_heads(
        &conn,
        "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ? AND agent_id = ? ORDER BY created_seq DESC LIMIT ?",
        &[
            SqlValue::Text(thread_id.to_owned()),
            SqlValue::Text(String::new()),
            SqlValue::Integer(half as i64),
        ],
        &mut by_seq,
    )?;

    let mut entries = Vec::with_capacity(by_seq.len());
    let mut sizes: HashMap<String, usize> = HashMap::with_capacity(by_seq.len());
    for (seq, (id, size, agent_id)) in by_seq {
        let in_root = agent_id.is_empty() || root_agent_id == Some(agent_id.as_str());
        sizes.insert(id.clone(), size);
        entries.push(TailEntry {
            id,
            seq: Some(seq),
            root: in_root,
        });
    }

    let bytes_of = |kept: &[TailEntry]| -> usize {
        kept.iter()
            .enumerate()
            .fold(4_usize, |total, (idx, entry)| {
                let size = sizes.get(&entry.id).copied().unwrap_or(0);
                let id_json = json_bytes(&Json::String(JsString::from(entry.id.as_str())));
                total + size + 2 * id_json + 1 + if idx > 0 { 2 } else { 0 }
            })
    };

    let mut capacity = tail.items.min(entries.len());
    let mut chosen = retained_tail(&entries, capacity);
    while capacity > 1 && bytes_of(&chosen.kept) > tail.bytes {
        capacity -= 1;
        chosen = retained_tail(&entries, capacity);
    }

    let use_preview = chosen.kept.len() == 1 && bytes_of(&chosen.kept) > tail.bytes;
    let mut items = Vec::with_capacity(chosen.kept.len());
    let mut item_seqs = Map::with_capacity(chosen.kept.len());
    let mut previewed = Vec::new();

    if use_preview {
        let entry = &chosen.kept[0];
        if let Some(item) = step_item(conn, thread_id, &entry.id, trust)? {
            let id = item_id(&item).unwrap_or(entry.id.as_str()).to_owned();
            item_seqs.insert(
                JsString::from(id.as_str()),
                Json::Number(Number::from(entry.seq.unwrap_or(0))),
            );
            previewed.push(id);
            items.push(item);
        }
    } else {
        let ids: Vec<&str> = chosen.kept.iter().map(|e| e.id.as_str()).collect();
        let mut materialized = materialize_all(&conn, &ids, trust)?;
        for entry in &chosen.kept {
            if let Some(item) = materialized.remove(&entry.id) {
                let id = item_id(&item).unwrap_or(entry.id.as_str()).to_owned();
                item_seqs.insert(
                    JsString::from(id.as_str()),
                    Json::Number(Number::from(entry.seq.unwrap_or(0))),
                );
                items.push(item);
            }
        }
    }

    Ok(TailPage {
        items,
        item_seqs,
        items_before: chosen.before,
        previewed,
    })
}

/// Read a complete `ThreadView` snapshot (`ThreadReads.snapshotThread`).
pub fn snapshot_thread(
    conn: Arc<Connection>,
    thread_id: &str,
    tail: SnapshotTail,
    item_trust: &Trust,
    entity_trusted: bool,
) -> Result<Json, SnapshotError> {
    let thread = read_thread_row(&conn, thread_id)?.ok_or(SnapshotError::UnknownThread)?;
    let head_seq = read_head_seq(&conn)?;
    let root_agent_id = match thread.get("rootAgentId") {
        Some(Json::String(s)) => Some(s.as_str().to_owned()),
        _ => None,
    };

    let mut entities = fill_snapshot_entities(&conn, thread_id, entity_trusted)?;
    let page = item_tail(
        conn.clone(),
        thread_id,
        root_agent_id.as_deref(),
        tail,
        item_trust,
    )?;

    let mut items_map = Map::with_capacity(page.items.len());
    let mut item_order = Vec::with_capacity(page.items.len());
    for item in page.items {
        if let Some(id) = item_id(&item).map(str::to_owned) {
            item_order.push(Json::String(JsString::from(id.as_str())));
            items_map.insert(JsString::from(id.as_str()), item);
        }
    }

    retain_agents_for_maps(
        &conn,
        thread_id,
        &mut entities.agents,
        &[
            &items_map,
            &entities.runs,
            &entities.interactions,
            &entities.background_tasks,
        ],
        entity_trusted,
    )?;
    entities.agent_children = rebuild_agent_children(&entities.agents);

    let full = tail.items >= FULL_TAIL.items && tail.bytes >= FULL_TAIL.bytes;

    // Exact `createThreadView` + `StatusStore.snapshot` + `loadThreadSnapshot` + `sharedSnapshot`
    // field order.
    let mut view = Map::with_capacity(18);
    view.insert("kind", Json::String(JsString::from("thread")));
    view.insert("seq", Json::Number(Number::from(head_seq)));
    view.insert("thread", thread);
    view.insert("agents", Json::Object(entities.agents));
    view.insert("agentChildren", Json::Object(entities.agent_children));
    view.insert("runs", Json::Object(entities.runs));
    view.insert("items", Json::Object(items_map));
    view.insert("itemOrder", Json::Array(Array::from(item_order)));
    view.insert(
        "itemsBefore",
        match page.items_before {
            Some(seq) => Json::Number(Number::from(seq)),
            None => Json::Null,
        },
    );
    view.insert("interactions", Json::Object(entities.interactions));
    view.insert("backgroundTasks", Json::Object(entities.background_tasks));
    view.insert("usage", Json::Object(entities.usage));
    view.insert("contextMeters", Json::Object(entities.context_meters));
    view.insert("usageSnapshots", Json::Object(entities.usage_snapshots));
    view.insert("entitiesBefore", Json::Object(entities.entities_before));
    if let Some(queue) = entities.queue {
        view.insert("queue", queue);
    }
    view.insert("itemSeqs", Json::Object(page.item_seqs));
    if !full && (page.items_before.is_some() || !page.previewed.is_empty()) {
        let mut partial = Map::with_capacity(1);
        let previews: Vec<Json> = page
            .previewed
            .into_iter()
            .map(|id| Json::String(JsString::from(id.as_str())))
            .collect();
        partial.insert("previews", Json::Array(Array::from(previews)));
        view.insert("partial", Json::Object(partial));
    }

    Ok(Json::Object(view))
}

/// Build the full wire `snapshot` server message (`{ type, subscriptionId, seq, view }`)
/// with bounded interaction summaries (`wire_thread_view`), ready to serialize to wire bytes.
pub fn snapshot_wire_message(
    conn: Arc<Connection>,
    subscription_id: &str,
    thread_id: &str,
    tail: SnapshotTail,
    item_trust: &Trust,
    entity_trusted: bool,
) -> Result<Json, SnapshotError> {
    let view = snapshot_thread(conn, thread_id, tail, item_trust, entity_trusted)?;
    let seq = match view.get("seq") {
        Some(Json::Number(n)) => *n,
        _ => Number::from(0_u64),
    };
    let wire_view = wire_thread_view(&view).unwrap_or(view);
    let mut msg = Map::with_capacity(4);
    msg.insert("type", Json::String(JsString::from("snapshot")));
    msg.insert(
        "subscriptionId",
        Json::String(JsString::from(subscription_id)),
    );
    msg.insert("seq", Json::Number(seq));
    msg.insert("view", wire_view);
    Ok(Json::Object(msg))
}

fn read_head_seq(conn: &Arc<Connection>) -> Result<u64, SnapshotError> {
    let stmt = conn
        .prepare("SELECT COALESCE(MAX(seq), 0) FROM events")
        .map_err(|e| SnapshotError::Store(e.to_string()))?;
    let Some(row) = stmt
        .step()
        .map_err(|e| SnapshotError::Store(e.to_string()))?
    else {
        return Ok(0);
    };
    match row.first() {
        Some(SqlValue::Integer(n)) => Ok((*n).max(0) as u64),
        Some(SqlValue::Real(n)) => Ok((*n).max(0.0) as u64),
        _ => Ok(0),
    }
}

fn collect_tail_heads(
    conn: &Arc<Connection>,
    sql: &str,
    params: &[SqlValue],
    out: &mut BTreeMap<u64, (String, usize, String)>,
) -> Result<(), SnapshotError> {
    let stmt = conn
        .prepare(sql)
        .map_err(|e| SnapshotError::Store(e.to_string()))?;
    let bound: Vec<Option<SqlValue>> = params.iter().cloned().map(Some).collect();
    stmt.bind(&bound)
        .map_err(|e| SnapshotError::Store(e.to_string()))?;
    while let Some(row) = stmt
        .step()
        .map_err(|e| SnapshotError::Store(e.to_string()))?
    {
        let id = match row.first() {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => continue,
        };
        let seq = match row.get(1) {
            Some(SqlValue::Integer(n)) => *n as u64,
            Some(SqlValue::Real(n)) => *n as u64,
            _ => continue,
        };
        let size = match row.get(2) {
            Some(SqlValue::Integer(n)) => (*n).max(0) as usize,
            Some(SqlValue::Real(n)) => (*n).max(0.0) as usize,
            _ => 0,
        };
        let agent_id = match row.get(3) {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => String::new(),
        };
        out.insert(seq, (id, size, agent_id));
    }
    Ok(())
}

/// `ItemStore.stepItem(threadId, itemId)`: bounded preview for text items, materialized body otherwise.
fn step_item(
    conn: Arc<Connection>,
    thread_id: &str,
    item_id: &str,
    trust: &Trust,
) -> Result<Option<Json>, SnapshotError> {
    let stmt = conn
        .prepare("SELECT item_type FROM item_heads WHERE thread_id = ? AND id = ?")
        .map_err(|e| SnapshotError::Store(e.to_string()))?;
    stmt.bind(&[
        Some(SqlValue::Text(thread_id.to_owned())),
        Some(SqlValue::Text(item_id.to_owned())),
    ])
    .map_err(|e| SnapshotError::Store(e.to_string()))?;
    let Some(row) = stmt
        .step()
        .map_err(|e| SnapshotError::Store(e.to_string()))?
    else {
        return Ok(None);
    };
    let item_type = match row.first() {
        Some(SqlValue::Text(s)) => s.clone(),
        _ => return Ok(None),
    };
    if matches!(item_type.as_str(), "message" | "notice" | "reasoning") {
        let page = SqlItemPage::new(conn, thread_id, trust.clone());
        return page
            .preview(item_id)
            .map(Some)
            .map_err(|e| SnapshotError::Store(format!("{e:?}")));
    }
    let mut map = materialize_all(&conn, &[item_id], trust)?;
    Ok(map.remove(item_id))
}

/// `ItemStore.materializeAll(ids)`: reads bodies and unmerged `item_text_chunks` in one statement
/// and folds any unmerged chunks onto each item in `seq` order.
fn materialize_all(
    conn: &Arc<Connection>,
    ids: &[&str],
    trust: &Trust,
) -> Result<HashMap<String, Json>, SnapshotError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_json = ace_json::to_string(&Json::Array(Array::from(
        ids.iter()
            .map(|id| Json::String(JsString::from(*id)))
            .collect::<Vec<_>>(),
    )));
    let stmt = conn
        .prepare(
            "SELECT j.value AS id, 0 AS kind, i.item, i.created_seq, NULL AS seq, NULL AS field, NULL AS append \
             FROM json_each(?1) j JOIN items i ON i.id = j.value \
             UNION ALL \
             SELECT j.value, 1, NULL, NULL, c.seq, c.field, c.append \
             FROM json_each(?1) j JOIN item_text_chunks c ON c.item_id = j.value \
             ORDER BY 1, 2, 5",
        )
        .map_err(|e| SnapshotError::Store(e.to_string()))?;
    stmt.bind(&[Some(SqlValue::Text(ids_json))])
        .map_err(|e| SnapshotError::Store(e.to_string()))?;

    let mut bodies: HashMap<String, (String, u64)> = HashMap::with_capacity(ids.len());
    let mut chunks: HashMap<String, Vec<(String, String)>> = HashMap::new();
    while let Some(row) = stmt
        .step()
        .map_err(|e| SnapshotError::Store(e.to_string()))?
    {
        let id = match row.first() {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => continue,
        };
        let kind = match row.get(1) {
            Some(SqlValue::Integer(n)) => *n,
            _ => continue,
        };
        if kind == 0 {
            let body = match row.get(2) {
                Some(SqlValue::Text(s)) => s.clone(),
                _ => return Err(SnapshotError::MissingItemBody),
            };
            let created = match row.get(3) {
                Some(SqlValue::Integer(n)) => *n as u64,
                Some(SqlValue::Real(n)) => *n as u64,
                _ => 0,
            };
            bodies.insert(id, (body, created));
        } else {
            let field = match row.get(5) {
                Some(SqlValue::Text(s)) => s.clone(),
                _ => continue,
            };
            let append_raw = match row.get(6) {
                Some(SqlValue::Text(s)) => s.clone(),
                _ => continue,
            };
            let append = decode_chunk_append(&append_raw);
            chunks.entry(id).or_default().push((field, append));
        }
    }

    let mut items = HashMap::with_capacity(ids.len());
    for &id in ids {
        let (body, created) = bodies.remove(id).ok_or(SnapshotError::MissingItemBody)?;
        let mut item = stored_item(created, &body, trust)
            .map_err(|_| SnapshotError::Store("malformed stored item".to_owned()))?;
        if let Some(item_chunks) = chunks.remove(id)
            && let Some((first_field, _)) = item_chunks.first()
        {
            let field = first_field.clone();
            let combined: String = item_chunks.into_iter().map(|(_, a)| a).collect();
            apply_item_delta(&mut item, &field, &combined);
        }
        items.insert(id.to_owned(), item);
    }
    Ok(items)
}

fn decode_chunk_append(raw: &str) -> String {
    match ace_json::parse(raw) {
        Ok(Json::String(s)) => s.as_str().to_owned(),
        _ => raw.to_owned(),
    }
}

/// Apply an `item.delta` (`field`, `append`) to a materialized item (`applyDelta`).
fn apply_item_delta(item: &mut Json, field: &str, append: &str) {
    let Json::Object(map) = item else {
        return;
    };
    let kind = match map.get("type") {
        Some(Json::String(s)) => s.as_str().to_owned(),
        _ => return,
    };
    match (kind.as_str(), field) {
        ("reasoning" | "notice", "text" | "reasoning") => {
            append_text_object(map, append);
        }
        ("message", "text") => {
            let Some(Json::Array(parts)) = map.get_mut("parts") else {
                return;
            };
            let append_to_last = matches!(
                parts.last(),
                Some(Json::Object(last))
                    if matches!(last.get("type"), Some(Json::String(t)) if t.as_str() == "text")
            );
            if append_to_last {
                if let Some(Json::Object(last)) = parts.last_mut() {
                    append_text_object(last, append);
                }
            } else {
                let mut part = Map::with_capacity(2);
                part.insert("type", Json::String(JsString::from("text")));
                part.insert("text", Json::String(JsString::from(append)));
                parts.push(Json::Object(part));
            }
        }
        ("tool_call", "output") => {
            let id = match map.get("id") {
                Some(Json::String(s)) => s.as_str().to_owned(),
                _ => return,
            };
            let Some(Json::Object(call)) = map.get_mut("call") else {
                return;
            };
            let Some(Json::Object(detail)) = call.get_mut("detail") else {
                return;
            };
            if !matches!(detail.get("kind"), Some(Json::String(k)) if k.as_str() == "shell") {
                return;
            }
            let prev = detail.get("output");
            let prev_bytes = prev
                .and_then(|o| o.get("bytes"))
                .and_then(|n| match n {
                    Json::Number(v) => Some(v.value() as u64),
                    _ => None,
                })
                .unwrap_or(0);
            let prev_stream = prev
                .and_then(|o| o.get("streamId"))
                .and_then(|s| match s {
                    Json::String(v) => Some(v.as_str().to_owned()),
                    _ => None,
                })
                .unwrap_or_else(|| format!("output:{id}"));
            let prev_tail = prev
                .and_then(|o| o.get("tail"))
                .and_then(|s| match s {
                    Json::String(v) => Some(v.as_str().to_owned()),
                    _ => None,
                })
                .unwrap_or_default();
            let total_bytes = prev_bytes + append.len() as u64;
            let combined = if append.len() >= 4096 {
                append.to_owned()
            } else {
                format!("{prev_tail}{append}")
            };
            let tail = bounded_json_tail(&combined, 4096);
            let truncated = total_bytes > tail.len() as u64;
            let mut out = Map::with_capacity(4);
            out.insert(
                "streamId",
                Json::String(JsString::from(prev_stream.as_str())),
            );
            out.insert("bytes", Json::Number(Number::from(total_bytes)));
            out.insert("tail", Json::String(JsString::from(tail.as_str())));
            out.insert("truncated", Json::Bool(truncated));
            detail.insert("output", Json::Object(out));
        }
        _ => {}
    }
}

fn append_text_object(target: &mut Map, append: &str) {
    let text_utf16 = match target.get("text") {
        Some(Json::String(s)) => s.as_str().encode_utf16().count(),
        _ => 0,
    };
    let holds_tail = match target.get("source") {
        Some(Json::Object(source)) => {
            let offset = match source.get("offset") {
                Some(Json::Number(n)) => n.value() as usize,
                _ => 0,
            };
            let bytes = match source.get("bytes") {
                Some(Json::Number(n)) => n.value() as usize,
                _ => 0,
            };
            offset + text_utf16 * 2 == bytes
        }
        _ => true,
    };
    if holds_tail {
        let existing = match target.get("text") {
            Some(Json::String(s)) => s.as_str().to_owned(),
            _ => String::new(),
        };
        let next = format!("{existing}{append}");
        target.insert("text", Json::String(JsString::from(next.as_str())));
    }
    if let Some(Json::Object(source)) = target.get_mut("source") {
        let prev_bytes = match source.get("bytes") {
            Some(Json::Number(n)) => n.value() as u64,
            _ => 0,
        };
        let added = (append.encode_utf16().count() * 2) as u64;
        source.insert("bytes", Json::Number(Number::from(prev_bytes + added)));
    }
}

fn bounded_json_tail(text: &str, limit: usize) -> String {
    let mut start = text.len();
    let mut size = 0_usize;
    for (idx, ch) in text.char_indices().rev() {
        let cost = match ch {
            '"' | '\\' | '\x08' | '\x09' | '\x0a' | '\x0c' | '\x0d' => 2,
            c if (c as u32) < 32 => 6,
            c => c.len_utf8(),
        };
        if size + cost > limit {
            break;
        }
        size += cost;
        start = idx;
    }
    text[start..].to_owned()
}

fn item_id(item: &Json) -> Option<&str> {
    match item.get("id") {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    }
}
