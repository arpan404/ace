// SPDX-License-Identifier: Apache-2.0

//! OpenCode's SQLite databases (`provider-db.ts`, `opencode-messages.ts`, the database branch of
//! `source-records.ts`): which schema a database has, and one session's rows as native records.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use super::{assign, js_number, js_string, json_of, threaded};
use crate::cancel::Cancel;
use crate::error::{Error, Result};
use crate::fsread::{RECORD_LIMIT, RecordKind, decode};
use crate::import::source::{Native, Raw, Records};
use crate::json::{field, object, string, timestamp};
use crate::options::Home;
use crate::session::Source;
use crate::snapshot::{SnapshotScratch, open_provider_db};

const TOO_LARGE_V1: &str = "OpenCode SQLite record exceeds bounded decoder limit";
const TOO_LARGE_V2: &str =
    "OpenCode history record is too large. Export the session from OpenCode to open it.";

/// The column names of a table; none when it is missing.
pub fn columns(db: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, rusqlite::types::Value>(1))?
        .map(|name| name.map(|n| js_string((&n).into())))
        .collect::<rusqlite::Result<_>>()?;
    Ok(names)
}

fn has_all(columns: &HashSet<String>, names: &[&str]) -> bool {
    names.iter().all(|n| columns.contains(*n))
}

pub fn supports_v1(db: &Connection) -> Result<bool> {
    Ok(has_all(
        &columns(db, "message")?,
        &["id", "data", "session_id", "time_created"],
    ) && has_all(&columns(db, "part")?, &["id", "data", "message_id"]))
}

pub fn supports_v2(db: &Connection) -> Result<bool> {
    Ok(has_all(
        &columns(db, "session_message")?,
        &["id", "session_id", "type", "seq", "data"],
    ))
}

pub fn supports(db: &Connection) -> Result<bool> {
    Ok(has_all(
        &columns(db, "session")?,
        &["id", "directory", "title", "time_updated", "parent_id"],
    ) && (supports_v1(db)? || supports_v2(db)?))
}

/// Whether the session's history is in the v2 table.
fn has_v2(db: &Connection, session: &str) -> Result<bool> {
    if !columns(db, "session_message")?.contains("session_id") {
        return Ok(false);
    }
    let count: rusqlite::types::Value = db.query_row(
        "SELECT COUNT(*) AS n FROM session_message WHERE session_id=?1",
        [session],
        |row| row.get(0),
    )?;
    Ok(js_number((&count).into()) > 0.0)
}

/// The decoded object of a row, or `None` when it is not JSON.
fn decoded(bytes: &[u8]) -> Option<serde_json::Map<String, Value>> {
    decode(bytes).map(|value| object(&value).clone())
}

fn v2(
    db: &Connection,
    session: &str,
    cancel: &Cancel,
    emit: &mut dyn FnMut(Result<Native>) -> bool,
) -> Result<bool> {
    let mut rows = db.prepare(
        "SELECT id,type,octet_length(data) AS bytes,CASE WHEN octet_length(data)<=1048576 THEN data ELSE NULL END AS data FROM session_message WHERE session_id=?1 ORDER BY seq,id",
    )?;
    let mut rows = rows.query([session])?;
    while let Some(row) = rows.next()? {
        cancel.check()?;
        if js_number(row.get_ref(2)?) > RECORD_LIMIT as f64 {
            return Err(Error::message(TOO_LARGE_V2));
        }
        // `Buffer.from(String(row.data))`.
        let bytes = js_string(row.get_ref(3)?).into_bytes();
        let kind = match decoded(&bytes) {
            Some(mut record) => {
                let kind = js_string(row.get_ref(1)?);
                assign(
                    &mut record,
                    "id",
                    Some(Value::String(js_string(row.get_ref(0)?))),
                );
                assign(&mut record, "type", Some(Value::String(kind.clone())));
                assign(&mut record, "role", Some(Value::String(kind)));
                RecordKind::Value(Value::Object(record))
            }
            None => RecordKind::Malformed,
        };
        let native = Native {
            bytes: bytes.len() as u64,
            kind,
            raw: Raw::Bytes(bytes),
        };
        if !emit(Ok(native)) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// A row's data as the bytes the TypeScript reader assembled from its 64 KiB chunks.
fn row_bytes(db: &Connection, table: &str, id: &str, bytes: f64) -> Result<Vec<u8>> {
    // The chunk loop ran while offset < bytes: none for 0, null or NaN.
    if bytes.is_nan() || bytes <= 0.0 {
        return Ok(Vec::new());
    }
    let data: Option<Vec<u8>> = db
        .prepare_cached(&format!(
            "SELECT CAST(data AS BLOB) FROM {table} WHERE id=?1"
        ))?
        .query_row([id], |row| row.get(0))?;
    data.ok_or_else(|| Error::message("Invalid SQLite history chunk"))
}

fn v1(
    db: &Connection,
    session: &str,
    cancel: &Cancel,
    emit: &mut dyn FnMut(Result<Native>) -> bool,
) -> Result<bool> {
    // One read transaction: a consistent snapshot of every row, including a live WAL's.
    db.execute_batch("BEGIN")?;
    let mut messages = db.prepare(
        "SELECT id,time_created,octet_length(data) AS bytes FROM message WHERE session_id=?1 ORDER BY time_created,id",
    )?;
    let mut parts = db.prepare(
        "SELECT id,octet_length(data) AS bytes FROM part WHERE message_id=?1 ORDER BY id",
    )?;
    let mut rows = messages.query([session])?;
    while let Some(row) = rows.next()? {
        cancel.check()?;
        let id = js_string(row.get_ref(0)?);
        let size = js_number(row.get_ref(2)?);
        let mut at = timestamp(&json_of(row.get_ref(1)?));
        if size > RECORD_LIMIT as f64 {
            return Err(Error::message(TOO_LARGE_V1));
        }
        let bytes = row_bytes(db, "message", &id, size)?;
        let mut role = None;
        let kind = match decoded(&bytes) {
            Some(mut message) => {
                role = string(&message, "role").map(|r| Value::String(r.to_owned()));
                at = timestamp(field(object(field(&message, "time")), "created")).or(at);
                assign(&mut message, "id", Some(Value::String(id.clone())));
                assign(&mut message, "timestamp", at.map(Value::from));
                RecordKind::Value(Value::Object(message))
            }
            None => RecordKind::Malformed,
        };
        let native = Native {
            bytes: size.max(0.0) as u64,
            kind,
            raw: Raw::Bytes(bytes),
        };
        if !emit(Ok(native)) {
            return Ok(false);
        }
        let mut each = parts.query([&id])?;
        while let Some(part) = each.next()? {
            let part_id = js_string(part.get_ref(0)?);
            let size = js_number(part.get_ref(1)?);
            if size > RECORD_LIMIT as f64 {
                return Err(Error::message(TOO_LARGE_V1));
            }
            let bytes = row_bytes(db, "part", &part_id, size)?;
            let kind = match decoded(&bytes) {
                Some(mut value) => {
                    assign(&mut value, "role", role.clone());
                    assign(&mut value, "id", Some(Value::String(part_id.clone())));
                    assign(&mut value, "messageID", Some(Value::String(id.clone())));
                    assign(&mut value, "timestamp", at.map(Value::from));
                    RecordKind::Value(Value::Object(value))
                }
                None => RecordKind::Malformed,
            };
            let native = Native {
                bytes: size.max(0.0) as u64,
                kind,
                raw: Raw::Bytes(bytes),
            };
            if !emit(Ok(native)) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// The records of one session in an OpenCode database, read from a pinned file or a private
/// snapshot, and checked to be one committed state once they are all read.
pub fn records<'a>(
    home: &'a Home,
    source: &'a Source,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
) -> Result<Records<'a>> {
    let handle = open_provider_db(home, Path::new(&source.path), scratch, cancel)?;
    let session = source.summary.native_id.clone();
    let cancel = cancel.clone();
    Ok(Box::new(threaded(move |emit| {
        let run = |emit: &mut dyn FnMut(Result<Native>) -> bool| -> Result<()> {
            let db = &handle.db;
            if !supports(db)? {
                return Err(Error::message("Unsupported provider database history"));
            }
            let finished = if has_v2(db, &session)? {
                if !supports_v2(db)? {
                    return Err(Error::message("Unsupported OpenCode history format"));
                }
                v2(db, &session, &cancel, emit)?
            } else {
                v1(db, &session, &cancel, emit)?
            };
            // An in-place read must not hand a torn transcript to the importer.
            if finished {
                handle.verify()?;
            }
            Ok(())
        };
        if let Err(error) = run(emit) {
            emit(Err(error));
        }
        handle.close();
    })))
}
