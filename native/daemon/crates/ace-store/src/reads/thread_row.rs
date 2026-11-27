// SPDX-License-Identifier: Apache-2.0
//! Thread row decoding (`thread-row.ts` and `stored-decode.ts::trustedThreadParts`).
//!
//! Reads the narrow `threads` row joined with `thread_cold` (`details`, `capabilities`) and
//! `row_trusted`, assembling fields in exact `Thread.shape` schema order (from
//! `ace_protocol::shapes::EVENT`). Trusted rows (`row_trusted == 1`) are read as stored;
//! untrusted rows are stripped to schema order/defaults, legacy `details` / `capabilities`
//! embedded in `client` / `provider_metadata` are rescued, and `switch.recommendation`
//! `"delegate_task"` is normalised to `"delegate"`.

use ace_json::{JsString, Map, Number, Value as Json};
use ace_projection::strip_object;
use ace_protocol::shape::{Field, Shape};
use ace_protocol::shapes::{EVENT, THREAD_CLIENT_COLUMN, THREAD_PROVIDER_METADATA};

use crate::{Connection, Value as SqlValue};

/// Full `threads` + `thread_cold` + `row_trusted` projection matching `thread-row.ts`.
pub const THREAD_ROW_COLUMNS: &str = "threads.id, threads.workspace_id, threads.title, threads.provider, threads.status, threads.created_at, threads.updated_at, threads.archived_at, threads.root_agent_id, threads.imported, threads.acp, threads.transitions, threads.provider_metadata, threads.client, cold.details AS details, cold.capabilities AS capabilities, (SELECT trust.canonical FROM thread_row_trust AS trust JOIN sidebar_thread_revisions AS current ON current.thread_id = trust.thread_id AND current.revision = trust.revision WHERE trust.thread_id = threads.id) AS row_trusted";

/// `threads` joined to `thread_cold`.
pub const THREAD_ROW_SOURCE: &str =
    "threads LEFT JOIN thread_cold AS cold ON cold.thread_id = threads.id";

/// Error decoding a stored thread row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadRowError {
    MalformedColumn(&'static str),
    Store(String),
}

impl std::fmt::Display for ThreadRowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThreadRowError::MalformedColumn(name) => write!(f, "malformed thread column: {name}"),
            ThreadRowError::Store(msg) => write!(f, "store error: {msg}"),
        }
    }
}

impl std::error::Error for ThreadRowError {}

/// Column indices matching [`THREAD_ROW_COLUMNS`].
pub const THREAD_ROW_COLUMN_COUNT: usize = 17;

const TRANSITION_KEYS: &[&str] = &[
    "lineage",
    "delegatedBy",
    "delegatedFrom",
    "startedBy",
    "startedByClient",
    "treeRootId",
    "queuedLaunch",
    "execution",
    "switch",
];

const METADATA_KEYS: &[&str] = &[
    "backend",
    "handoff",
    "permission",
    "titleSource",
    "queue",
    "goal",
];

/// Extract the generated `Thread` fields array from `EVENT` -> `"thread.created"` -> `"thread"`.
pub fn thread_fields() -> &'static [Field] {
    let Shape::Object(event_fields) = &EVENT else {
        unreachable!("EVENT root is an object");
    };
    let payload_shape = event_fields
        .iter()
        .find(|f| f.key == "payload")
        .map(|f| &f.shape)
        .unwrap_or_else(|| unreachable!("EVENT has payload"));
    let Shape::Tagged { options, .. } = payload_shape else {
        unreachable!("EVENT.payload is tagged");
    };
    let created = options
        .iter()
        .find(|(lit, _)| *lit == "\"thread.created\"")
        .map(|(_, s)| s)
        .unwrap_or_else(|| unreachable!("thread.created option exists"));
    let Shape::Object(created_fields) = created else {
        unreachable!("thread.created is an object");
    };
    let thread = created_fields
        .iter()
        .find(|f| f.key == "thread")
        .map(|f| &f.shape)
        .unwrap_or_else(|| unreachable!("thread.created has thread"));
    let Shape::Object(fields) = thread else {
        unreachable!("Thread is an object");
    };
    fields
}

fn shape_keys(shape: &'static Shape) -> &'static [Field] {
    match shape {
        Shape::Object(fields) | Shape::Open(fields) => fields,
        _ => &[],
    }
}

/// Read and decode one thread by id from `conn`. Returns `Ok(None)` if no row exists.
pub fn read_thread_row(
    conn: &std::sync::Arc<Connection>,
    thread_id: &str,
) -> Result<Option<Json>, ThreadRowError> {
    let sql = format!("SELECT {THREAD_ROW_COLUMNS} FROM {THREAD_ROW_SOURCE} WHERE threads.id = ?");
    let stmt = conn
        .prepare(&sql)
        .map_err(|e| ThreadRowError::Store(e.to_string()))?;
    stmt.bind(&[Some(SqlValue::Text(thread_id.to_owned()))])
        .map_err(|e| ThreadRowError::Store(e.to_string()))?;
    let Some(row) = stmt
        .step()
        .map_err(|e| ThreadRowError::Store(e.to_string()))?
    else {
        return Ok(None);
    };
    decode_thread_sql_row(&row).map(Some)
}

/// Decode a SQL row produced by selecting [`THREAD_ROW_COLUMNS`] (first 17 columns).
pub fn decode_thread_sql_row(row: &[SqlValue]) -> Result<Json, ThreadRowError> {
    if row.len() < THREAD_ROW_COLUMN_COUNT {
        return Err(ThreadRowError::MalformedColumn("row_length"));
    }
    let trusted = matches!(row.get(16), Some(SqlValue::Integer(1)));
    let mut fields = Map::with_capacity(24);

    // Base columns
    fields.insert("id", sql_string(&row[0], "id")?);
    fields.insert("workspaceId", sql_string(&row[1], "workspace_id")?);
    fields.insert("title", sql_string(&row[2], "title")?);
    fields.insert("provider", sql_string(&row[3], "provider")?);
    fields.insert("status", sql_json(&row[4], "status")?);
    fields.insert("createdAt", sql_number(&row[5], "created_at")?);
    fields.insert("updatedAt", sql_number(&row[6], "updated_at")?);
    if !matches!(row[7], SqlValue::Null) {
        fields.insert("archivedAt", sql_number(&row[7], "archived_at")?);
    }
    if !matches!(row[8], SqlValue::Null) {
        fields.insert("rootAgentId", sql_string(&row[8], "root_agent_id")?);
    }
    if !matches!(row[9], SqlValue::Null) {
        fields.insert("imported", sql_json(&row[9], "imported")?);
    }

    // Client + legacy embedded details
    let client_json = sql_opt_json(&row[13], "client")?;
    let client_fields = shape_keys(&THREAD_CLIENT_COLUMN);
    if let Some(Json::Object(ref map)) = client_json {
        for field in client_fields {
            if let Some(val) = map.get(field.key) {
                fields.insert(field.key, val.clone());
            }
        }
    }

    // Details (legacy rows stored details inside client; trusted rows never do)
    let details = if !trusted {
        embedded_field(client_json.as_ref(), "details")
            .cloned()
            .or(sql_opt_json(&row[14], "details")?)
    } else {
        sql_opt_json(&row[14], "details")?
    };
    if let Some(val) = details {
        fields.insert("details", val);
    }

    // Transitions
    if let Some(Json::Object(map)) = sql_opt_json(&row[11], "transitions")? {
        for &key in TRANSITION_KEYS {
            if let Some(val) = map.get(key) {
                fields.insert(key, val.clone());
            }
        }
    }

    // Provider metadata + legacy embedded capabilities + goal
    let metadata_json = sql_opt_json(&row[12], "provider_metadata")?;
    if let Some(Json::Object(ref map)) = metadata_json {
        for &key in METADATA_KEYS {
            if let Some(val) = map.get(key) {
                if key == "goal" && !trusted && !is_valid_goal(val) {
                    continue;
                }
                fields.insert(key, val.clone());
            }
        }
    }

    // Capabilities (legacy rows stored capabilities inside provider_metadata)
    let capabilities = if !trusted {
        embedded_field(metadata_json.as_ref(), "capabilities")
            .cloned()
            .or(sql_opt_json(&row[15], "capabilities")?)
    } else {
        sql_opt_json(&row[15], "capabilities")?
    };
    if let Some(val) = capabilities {
        fields.insert("capabilities", val);
    }

    // ACP metadata
    if let Some(Json::Object(map)) = sql_opt_json(&row[10], "acp")? {
        for field in shape_keys(&THREAD_PROVIDER_METADATA) {
            if let Some(val) = map.get(field.key) {
                fields.insert(field.key, val.clone());
            }
        }
    }

    // Derived continuation (Cursor CLI retired)
    let is_cursor =
        matches!(fields.get("provider"), Some(Json::String(s)) if s.as_str() == "cursor");
    let is_cursor_sdk =
        matches!(fields.get("backend"), Some(Json::String(s)) if s.as_str() == "cursor-sdk");
    if is_cursor && !is_cursor_sdk {
        let mut cont = Map::with_capacity(3);
        cont.insert("state", Json::String(JsString::from("read_only")));
        cont.insert("reason", Json::String(JsString::from("cursor_cli_retired")));
        cont.insert(
            "actionId",
            Json::String(JsString::from("thread.continue_new")),
        );
        fields.insert("continuation", Json::Object(cont));
    }

    let schema_fields = thread_fields();
    if trusted {
        let mut ordered = Map::with_capacity(fields.len());
        for field in schema_fields {
            if let Some(val) = fields.remove(field.key) {
                ordered.insert(field.key, val);
            }
        }
        return Ok(Json::Object(ordered));
    }

    // Untrusted: strip through generated Thread shape (exact order + defaults) + legacy transforms.
    let mut stripped = strip_object(schema_fields, &fields);
    if let Some(Json::Object(sw)) = stripped.get_mut("switch")
        && matches!(sw.get("recommendation"), Some(Json::String(s)) if s.as_str() == "delegate_task")
    {
        sw.insert("recommendation", Json::String(JsString::from("delegate")));
    }
    Ok(Json::Object(stripped))
}

fn embedded_field<'a>(value: Option<&'a Json>, key: &str) -> Option<&'a Json> {
    match value {
        Some(Json::Object(map)) => map.get(key),
        _ => None,
    }
}

/// Minimal structural check matching `ProviderGoal.safeParse` for untrusted `storedGoal`:
/// a valid goal must be an object with non-empty string `id` and `state`.
fn is_valid_goal(val: &Json) -> bool {
    let Json::Object(map) = val else {
        return false;
    };
    matches!(map.get("id"), Some(Json::String(s)) if !s.as_str().is_empty())
        && matches!(map.get("state"), Some(Json::String(s)) if !s.as_str().is_empty())
}

fn sql_string(value: &SqlValue, col: &'static str) -> Result<Json, ThreadRowError> {
    match value {
        SqlValue::Text(text) => Ok(Json::String(JsString::from(text.as_str()))),
        _ => Err(ThreadRowError::MalformedColumn(col)),
    }
}

fn sql_number(value: &SqlValue, col: &'static str) -> Result<Json, ThreadRowError> {
    match value {
        SqlValue::Integer(n) => Ok(Json::Number(Number::from(*n))),
        SqlValue::Real(n) => Number::from_f64(*n)
            .map(Json::Number)
            .ok_or(ThreadRowError::MalformedColumn(col)),
        _ => Err(ThreadRowError::MalformedColumn(col)),
    }
}

fn sql_json(value: &SqlValue, col: &'static str) -> Result<Json, ThreadRowError> {
    let SqlValue::Text(text) = value else {
        return Err(ThreadRowError::MalformedColumn(col));
    };
    ace_json::parse(text).map_err(|_| ThreadRowError::MalformedColumn(col))
}

fn sql_opt_json(value: &SqlValue, col: &'static str) -> Result<Option<Json>, ThreadRowError> {
    match value {
        SqlValue::Null => Ok(None),
        _ => sql_json(value, col).map(Some),
    }
}
