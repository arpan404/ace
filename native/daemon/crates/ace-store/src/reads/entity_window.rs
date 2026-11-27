// SPDX-License-Identifier: Apache-2.0
//! Entity windows, retention and entity paging (`entity-window.ts`, `metadata-retention.ts`,
//! `packages/projection/src/entity-pages.ts`, `rebuildAgentChildren`).

use std::collections::BTreeSet;
use std::sync::Arc;

use ace_json::{Array, JsString, Map, Number, Value as Json};
use ace_projection::{WHOLE_REQUEST_CHARS, sent_summarized, summarize_interaction};

use crate::reads::stored::{EntityKind, stored_entity};
use crate::{Connection, Value as SqlValue};

/// Default byte budget for `entities.page` (`entityPageBytes`).
pub const ENTITY_PAGE_BYTES: usize = 128 * 1024;
/// Recent inactive entity window cap per collection in snapshots (200 entries, 128 KiB).
pub const SNAPSHOT_ENTITY_LIMIT: usize = 200;
pub const SNAPSHOT_ENTITY_BYTES: usize = 131_072;
/// `Number.MAX_SAFE_INTEGER` (2^53 - 1).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Cursor base for paging active entities (`2 ** 52`).
pub const PENDING_BASE: u64 = 1_u64 << 52;
/// Cursor base for paging inactive entities (`2 ** 51`).
pub const RESOLVED_BASE: u64 = 1_u64 << 51;
/// Largest single entity JSON length (UTF-16 units) allowed on an `entities.page` reply.
pub const LARGEST_PAGE_ENTITY: usize = 32 * 1024 * 1024 - 64 * 1024;

/// The four windowed entity collections in `view_entities` / `view_entity_windows`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityCollection {
    Agents,
    Runs,
    Interactions,
    BackgroundTasks,
}

impl EntityCollection {
    pub const ALL: [EntityCollection; 4] = [
        EntityCollection::Agents,
        EntityCollection::Runs,
        EntityCollection::Interactions,
        EntityCollection::BackgroundTasks,
    ];

    pub fn name(self) -> &'static str {
        match self {
            EntityCollection::Agents => "agents",
            EntityCollection::Runs => "runs",
            EntityCollection::Interactions => "interactions",
            EntityCollection::BackgroundTasks => "backgroundTasks",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "agents" => Some(EntityCollection::Agents),
            "runs" => Some(EntityCollection::Runs),
            "interactions" => Some(EntityCollection::Interactions),
            "backgroundTasks" => Some(EntityCollection::BackgroundTasks),
            _ => None,
        }
    }

    fn kind(self) -> EntityKind {
        match self {
            EntityCollection::Agents => EntityKind::Agent,
            EntityCollection::Runs => EntityKind::Run,
            EntityCollection::Interactions => EntityKind::Interaction,
            EntityCollection::BackgroundTasks => EntityKind::BackgroundTask,
        }
    }
}

/// Error reading entities from SQLite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityReadError {
    Decode(&'static str),
    Store(String),
}

impl std::fmt::Display for EntityReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EntityReadError::Decode(what) => write!(f, "failed to decode entity: {what}"),
            EntityReadError::Store(msg) => write!(f, "store error: {msg}"),
        }
    }
}

impl std::error::Error for EntityReadError {}

/// Decoded entity collections for a thread snapshot.
#[derive(Debug)]
pub struct SnapshotEntities {
    pub agents: Map,
    pub agent_children: Map,
    pub runs: Map,
    pub interactions: Map,
    pub background_tasks: Map,
    pub usage: Map,
    pub context_meters: Map,
    pub usage_snapshots: Map,
    pub queue: Option<Json>,
    pub entities_before: Map,
}

/// Fill all entity collections for `thread_id`, matching `StatusStore.snapshot` + `EntityWindow.fill`.
pub fn fill_snapshot_entities(
    conn: &Arc<Connection>,
    thread_id: &str,
    trusted: bool,
) -> Result<SnapshotEntities, EntityReadError> {
    let mut agents = Map::new();
    let mut runs = Map::new();
    let mut interactions = Map::new();
    let mut background_tasks = Map::new();
    let mut entities_before = Map::with_capacity(4);

    for collection in EntityCollection::ALL {
        let active_rows = query_window_rows(
            conn,
            thread_id,
            collection.name(),
            "w.active = 1",
            "ASC",
            &[],
        )?;
        let inactive_rows = query_window_rows(
            conn,
            thread_id,
            collection.name(),
            "w.active = 0",
            "DESC LIMIT 201",
            &[],
        )?;

        let mut bytes = 0_usize;
        let mut before: Option<u64> = None;
        let mut older = false;
        let mut recent: Vec<(String, Json)> = Vec::new();
        for (count, (seq, id, raw)) in inactive_rows.into_iter().enumerate() {
            let size = raw.len();
            if count >= SNAPSHOT_ENTITY_LIMIT || bytes + size > SNAPSHOT_ENTITY_BYTES {
                older = true;
                break;
            }
            before = Some(seq);
            let value = stored_entity(collection.kind(), &raw, trusted)
                .map_err(|_| EntityReadError::Decode(collection.name()))?;
            recent.push((id, value));
            bytes += size;
        }
        recent.reverse();

        let target = match collection {
            EntityCollection::Agents => &mut agents,
            EntityCollection::Runs => &mut runs,
            EntityCollection::Interactions => &mut interactions,
            EntityCollection::BackgroundTasks => &mut background_tasks,
        };
        for (id, val) in recent {
            target.insert(JsString::from(id.as_str()), val);
        }
        for (_, id, raw) in active_rows {
            let value = stored_entity(collection.kind(), &raw, trusted)
                .map_err(|_| EntityReadError::Decode(collection.name()))?;
            target.insert(JsString::from(id.as_str()), value);
        }

        entities_before.insert(
            collection.name(),
            if older {
                Json::Number(Number::from(before.unwrap_or(MAX_SAFE_INTEGER)))
            } else {
                Json::Null
            },
        );
    }

    retain_agents_for_maps(
        conn,
        thread_id,
        &mut agents,
        &[&runs, &interactions, &background_tasks],
        trusted,
    )?;

    let usage = load_agent_metadata(
        conn,
        thread_id,
        "usage",
        EntityKind::Usage,
        &agents,
        trusted,
    )?;
    let context_meters = load_agent_metadata(
        conn,
        thread_id,
        "contextMeters",
        EntityKind::ContextMeter,
        &agents,
        trusted,
    )?;

    let mut usage_snapshots = Map::new();
    for (id, raw) in query_pair_rows(
        conn,
        "SELECT id, value FROM view_entities WHERE thread_id = ? AND collection = 'usageSnapshots' ORDER BY rowid DESC LIMIT 200",
        &[SqlValue::Text(thread_id.to_owned())],
    )? {
        let value = stored_entity(EntityKind::UsageSnapshots, &raw, trusted)
            .map_err(|_| EntityReadError::Decode("usageSnapshots"))?;
        usage_snapshots.insert(JsString::from(id.as_str()), value);
    }

    let queue = query_single_text(
        conn,
        "SELECT value FROM view_entities WHERE thread_id = ? AND collection = 'queue'",
        &[SqlValue::Text(thread_id.to_owned())],
    )?
    .map(|raw| {
        stored_entity(EntityKind::Queue, &raw, trusted)
            .map_err(|_| EntityReadError::Decode("queue"))
    })
    .transpose()?;

    let agent_children = rebuild_agent_children(&agents);

    Ok(SnapshotEntities {
        agents,
        agent_children,
        runs,
        interactions,
        background_tasks,
        usage,
        context_meters,
        usage_snapshots,
        queue,
        entities_before,
    })
}

/// Retain every agent referenced by `collections` (items, runs, interactions, backgroundTasks)
/// plus recursively their `parentId` ancestors, loading missing rows from `view_entities`.
pub fn retain_agents_for_maps(
    conn: &Arc<Connection>,
    thread_id: &str,
    agents: &mut Map,
    collections: &[&Map],
    trusted: bool,
) -> Result<(), EntityReadError> {
    let mut queue: Vec<String> = agents.iter().map(|(k, _)| k.as_str().to_owned()).collect();
    let mut seen: BTreeSet<String> = queue.iter().cloned().collect();
    for map in collections {
        for (_, entity) in map.iter() {
            if let Some(Json::String(agent_id)) = entity.get("agentId") {
                let id = agent_id.as_str();
                if !id.is_empty() && seen.insert(id.to_owned()) {
                    queue.push(id.to_owned());
                }
            }
        }
    }

    let mut index = 0;
    while index < queue.len() {
        let id = queue[index].clone();
        index += 1;
        let parent_id = if let Some(existing) = agents.get(id.as_str()) {
            parent_id_of(existing)
        } else if let Some(raw) = query_single_text(
            conn,
            "SELECT value FROM view_entities WHERE thread_id = ? AND collection = 'agents' AND id = ?",
            &[
                SqlValue::Text(thread_id.to_owned()),
                SqlValue::Text(id.clone()),
            ],
        )? {
            let agent = stored_entity(EntityKind::Agent, &raw, trusted)
                .map_err(|_| EntityReadError::Decode("agents"))?;
            let parent = parent_id_of(&agent);
            agents.insert(JsString::from(id.as_str()), agent);
            parent
        } else {
            None
        };
        if let Some(parent) = parent_id
            && !parent.is_empty()
            && seen.insert(parent.clone())
        {
            queue.push(parent);
        }
    }
    Ok(())
}

/// Rebuild the derived `agentChildren` parent -> `[childIds]` index (`rebuildAgentChildren`).
pub fn rebuild_agent_children(agents: &Map) -> Map {
    let mut parents: Vec<(String, Vec<String>)> = Vec::new();
    for (_, agent) in agents.iter() {
        let Some(parent) = parent_id_of(agent) else {
            continue;
        };
        let Some(Json::String(id)) = agent.get("id") else {
            continue;
        };
        if let Some((_, children)) = parents.iter_mut().find(|(p, _)| *p == parent) {
            if !children.iter().any(|c| c == id.as_str()) {
                children.push(id.as_str().to_owned());
            }
        } else {
            parents.push((parent, vec![id.as_str().to_owned()]));
        }
    }
    let mut out = Map::with_capacity(parents.len());
    for (parent, children) in parents {
        let arr: Vec<Json> = children
            .into_iter()
            .map(|c| Json::String(JsString::from(c.as_str())))
            .collect();
        out.insert(
            JsString::from(parent.as_str()),
            Json::Array(Array::from(arr)),
        );
    }
    out
}

/// Read one `entities.page` (`EntityWindow.page` + `@ace/projection/entity-pages::entityPage`),
/// returning the `EntitiesPage` wire JSON object (including `seq`).
#[allow(clippy::too_many_arguments)]
pub fn read_entity_page(
    conn: &Arc<Connection>,
    thread_id: &str,
    collection: EntityCollection,
    before: u64,
    limit: usize,
    max_bytes: usize,
    seq: u64,
    trusted: bool,
) -> Result<Json, EntityReadError> {
    read_entity_page_with_largest(
        conn,
        thread_id,
        collection,
        before,
        limit,
        max_bytes,
        LARGEST_PAGE_ENTITY,
        seq,
        trusted,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn read_entity_page_with_largest(
    conn: &Arc<Connection>,
    thread_id: &str,
    collection: EntityCollection,
    before: u64,
    limit: usize,
    max_bytes: usize,
    largest: usize,
    seq: u64,
    trusted: bool,
) -> Result<Json, EntityReadError> {
    let most = limit.min(SNAPSHOT_ENTITY_LIMIT);
    let (start_active, mut below) = cursor_of(before);
    let mut taken: Vec<(u64, Json)> = Vec::new();
    let mut too_large: Vec<Json> = Vec::new();
    let mut count = 0_usize;
    let mut bytes = 0_usize;
    let mut next_before: Option<u64> = None;

    let mut try_take = |row_seq: u64,
                        id: String,
                        raw: String,
                        is_active: bool|
     -> Result<bool, EntityReadError> {
        let (row_bytes, row_utf16_len, shaped) = weigh_page_row(collection, &raw, trusted)?;
        if count >= most || (count > 0 && bytes + row_bytes > max_bytes) {
            return Ok(false);
        }
        count += 1;
        if row_utf16_len > largest {
            let kind = query_single_text(
                conn,
                "SELECT json_extract(value, '$.request.kind') FROM view_entities WHERE thread_id = ? AND collection = ? AND id = ?",
                &[
                    SqlValue::Text(thread_id.to_owned()),
                    SqlValue::Text(collection.name().to_owned()),
                    SqlValue::Text(id.clone()),
                ],
            )?;
            let mut item = Map::with_capacity(4);
            item.insert("id", Json::String(JsString::from(id.as_str())));
            if let Some(kind) = kind {
                item.insert("kind", Json::String(JsString::from(kind.as_str())));
            }
            item.insert("active", Json::Bool(is_active));
            item.insert("bytes", Json::Number(Number::from(row_bytes as u64)));
            too_large.push(Json::Object(item));
            return Ok(true);
        }
        let entity = match shaped {
            Some(v) => v,
            None => stored_entity(collection.kind(), &raw, trusted)
                .map_err(|_| EntityReadError::Decode(collection.name()))?,
        };
        taken.push((row_seq, entity));
        bytes += row_bytes;
        Ok(true)
    };

    if start_active {
        let active_rows = query_window_rows(
            conn,
            thread_id,
            collection.name(),
            "w.active = 1 AND w.created_seq < ?",
            "DESC LIMIT ?",
            &[
                SqlValue::Integer(below as i64),
                SqlValue::Integer((most + 1) as i64),
            ],
        )?;
        for (row_seq, id, raw) in active_rows {
            if !try_take(row_seq, id, raw, true)? {
                next_before = Some(PENDING_BASE + below);
                break;
            }
            below = row_seq;
        }
        if next_before.is_none() {
            below = MAX_SAFE_INTEGER;
        }
    }

    if next_before.is_none() {
        let inactive_rows = query_window_rows(
            conn,
            thread_id,
            collection.name(),
            "w.active = 0 AND w.created_seq < ?",
            "DESC LIMIT ?",
            &[
                SqlValue::Integer(below as i64),
                SqlValue::Integer((most + 1) as i64),
            ],
        )?;
        for (row_seq, id, raw) in inactive_rows {
            if !try_take(row_seq, id, raw, false)? {
                next_before = Some(if below == MAX_SAFE_INTEGER {
                    PENDING_BASE
                } else {
                    RESOLVED_BASE + below
                });
                break;
            }
            below = row_seq;
        }
    }

    taken.sort_by_key(|(s, _)| *s);
    let entries: Vec<Json> = taken.into_iter().map(|(_, entity)| entity).collect();
    let mut out = Map::with_capacity(6);
    out.insert("threadId", Json::String(JsString::from(thread_id)));
    out.insert(
        "collection",
        Json::String(JsString::from(collection.name())),
    );
    out.insert("entries", Json::Array(Array::from(entries)));
    out.insert(
        "entitiesBefore",
        match next_before {
            Some(c) => Json::Number(Number::from(c)),
            None => Json::Null,
        },
    );
    if !too_large.is_empty() {
        out.insert("tooLarge", Json::Array(Array::from(too_large)));
    }
    out.insert("seq", Json::Number(Number::from(seq)));
    Ok(Json::Object(out))
}

/// Decode an entity page cursor into `(active, below)` (`cursorOf`).
pub fn cursor_of(before: u64) -> (bool, u64) {
    if before > PENDING_BASE && before < MAX_SAFE_INTEGER {
        return (true, before - PENDING_BASE);
    }
    if before == PENDING_BASE {
        return (false, MAX_SAFE_INTEGER);
    }
    if before > RESOLVED_BASE && before < PENDING_BASE {
        return (false, before - RESOLVED_BASE);
    }
    (true, MAX_SAFE_INTEGER)
}

fn weigh_page_row(
    collection: EntityCollection,
    raw: &str,
    trusted: bool,
) -> Result<(usize, usize, Option<Json>), EntityReadError> {
    let raw_bytes = raw.len();
    if collection == EntityCollection::Interactions && raw_bytes > WHOLE_REQUEST_CHARS {
        let decoded = stored_entity(EntityKind::Interaction, raw, trusted)
            .map_err(|_| EntityReadError::Decode("interactions"))?;
        if sent_summarized(&decoded) {
            let summarized = summarize_interaction(&decoded);
            let json = ace_json::to_string(&summarized);
            let utf16 = json.encode_utf16().count();
            return Ok((json.len(), utf16, Some(summarized)));
        }
        return Ok((raw_bytes, raw.encode_utf16().count(), Some(decoded)));
    }
    Ok((raw_bytes, raw.encode_utf16().count(), None))
}

fn load_agent_metadata(
    conn: &Arc<Connection>,
    thread_id: &str,
    collection: &'static str,
    kind: EntityKind,
    agents: &Map,
    trusted: bool,
) -> Result<Map, EntityReadError> {
    let mut recent =
        query_window_rows(conn, thread_id, collection, "1 = 1", "DESC LIMIT 200", &[])?;
    recent.reverse();
    let mut values = Map::new();
    for (_, id, raw) in recent {
        let value =
            stored_entity(kind, &raw, trusted).map_err(|_| EntityReadError::Decode(collection))?;
        values.insert(JsString::from(id.as_str()), value);
    }
    for (id, _) in agents.iter() {
        if let Some(raw) = query_single_text(
            conn,
            "SELECT value FROM view_entities WHERE thread_id = ? AND collection = ? AND id = ?",
            &[
                SqlValue::Text(thread_id.to_owned()),
                SqlValue::Text(collection.to_owned()),
                SqlValue::Text(id.as_str().to_owned()),
            ],
        )? {
            let value = stored_entity(kind, &raw, trusted)
                .map_err(|_| EntityReadError::Decode(collection))?;
            values.insert(id.clone(), value);
        }
    }
    trim_agent_metadata(&mut values, agents);
    Ok(values)
}

/// Keep metadata for retained agents plus a bounded recent window awaiting agent linkage
/// (`trimAgentMetadata`).
fn trim_agent_metadata(values: &mut Map, agents: &Map) {
    let mut drop_keys: Vec<JsString> = Vec::new();
    let mut count = 0_usize;
    let mut bytes = 0_usize;
    let entries: Vec<(JsString, usize)> = values
        .iter()
        .map(|(k, v)| (k.clone(), ace_json::to_string(v).len()))
        .collect();
    for (key, size) in entries.into_iter().rev() {
        if agents.contains_key(key.as_str()) {
            continue;
        }
        if count >= SNAPSHOT_ENTITY_LIMIT || bytes + size > SNAPSHOT_ENTITY_BYTES {
            drop_keys.push(key);
        } else {
            count += 1;
            bytes += size;
        }
    }
    for key in drop_keys {
        values.remove(key.as_str());
    }
}

fn parent_id_of(agent: &Json) -> Option<String> {
    match agent.get("parentId") {
        Some(Json::String(s)) if !s.as_str().is_empty() => Some(s.as_str().to_owned()),
        _ => None,
    }
}

fn query_window_rows(
    conn: &Arc<Connection>,
    thread_id: &str,
    collection: &str,
    predicate: &str,
    order: &str,
    extra: &[SqlValue],
) -> Result<Vec<(u64, String, String)>, EntityReadError> {
    let sql = format!(
        "SELECT w.created_seq, e.id, e.value FROM view_entity_windows w JOIN view_entities e USING(thread_id, collection, id) WHERE w.thread_id = ? AND w.collection = ? AND {predicate} ORDER BY w.created_seq {order}"
    );
    let stmt = conn
        .prepare(&sql)
        .map_err(|e| EntityReadError::Store(e.to_string()))?;
    let mut params = Vec::with_capacity(2 + extra.len());
    params.push(Some(SqlValue::Text(thread_id.to_owned())));
    params.push(Some(SqlValue::Text(collection.to_owned())));
    for p in extra {
        params.push(Some(p.clone()));
    }
    stmt.bind(&params)
        .map_err(|e| EntityReadError::Store(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(row) = stmt
        .step()
        .map_err(|e| EntityReadError::Store(e.to_string()))?
    {
        let seq = match row.first() {
            Some(SqlValue::Integer(n)) => *n as u64,
            Some(SqlValue::Real(n)) => *n as u64,
            _ => return Err(EntityReadError::Decode("created_seq")),
        };
        let id = match row.get(1) {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => return Err(EntityReadError::Decode("id")),
        };
        let val = match row.get(2) {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => return Err(EntityReadError::Decode("value")),
        };
        out.push((seq, id, val));
    }
    Ok(out)
}

fn query_pair_rows(
    conn: &Arc<Connection>,
    sql: &str,
    params: &[SqlValue],
) -> Result<Vec<(String, String)>, EntityReadError> {
    let stmt = conn
        .prepare(sql)
        .map_err(|e| EntityReadError::Store(e.to_string()))?;
    let bound: Vec<Option<SqlValue>> = params.iter().cloned().map(Some).collect();
    stmt.bind(&bound)
        .map_err(|e| EntityReadError::Store(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(row) = stmt
        .step()
        .map_err(|e| EntityReadError::Store(e.to_string()))?
    {
        let id = match row.first() {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => return Err(EntityReadError::Decode("id")),
        };
        let val = match row.get(1) {
            Some(SqlValue::Text(s)) => s.clone(),
            _ => return Err(EntityReadError::Decode("value")),
        };
        out.push((id, val));
    }
    Ok(out)
}

fn query_single_text(
    conn: &Arc<Connection>,
    sql: &str,
    params: &[SqlValue],
) -> Result<Option<String>, EntityReadError> {
    let stmt = conn
        .prepare(sql)
        .map_err(|e| EntityReadError::Store(e.to_string()))?;
    let bound: Vec<Option<SqlValue>> = params.iter().cloned().map(Some).collect();
    stmt.bind(&bound)
        .map_err(|e| EntityReadError::Store(e.to_string()))?;
    let Some(row) = stmt
        .step()
        .map_err(|e| EntityReadError::Store(e.to_string()))?
    else {
        return Ok(None);
    };
    match row.first() {
        Some(SqlValue::Text(s)) => Ok(Some(s.clone())),
        Some(SqlValue::Null) | None => Ok(None),
        _ => Err(EntityReadError::Decode("text")),
    }
}
