// SPDX-License-Identifier: Apache-2.0

//! The archive of imported threads (`archive.ts`), in the same index file. A thread is staged in
//! one transaction and becomes visible only when it is published.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::error::{Error, Result};

const SCHEMA: &str = "PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS imported_threads(id TEXT PRIMARY KEY,source TEXT UNIQUE NOT NULL,thread TEXT NOT NULL,published INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_agents(id TEXT PRIMARY KEY,thread TEXT NOT NULL REFERENCES imported_threads(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_items(thread TEXT NOT NULL REFERENCES imported_threads(id) ON DELETE CASCADE,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread,seq));
      CREATE TABLE IF NOT EXISTS imported_blobs(id TEXT PRIMARY KEY,thread TEXT NOT NULL REFERENCES imported_threads(id) ON DELETE CASCADE,size INTEGER NOT NULL,complete INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_blob_chunks(blob TEXT NOT NULL REFERENCES imported_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob,offset));
      DELETE FROM imported_threads WHERE published=0;";

const PAGE_BYTES: usize = 1024 * 1024;
const CHUNK: i64 = 64 * 1024;

/// One staged write, as `ArchiveCommand` describes it.
pub enum Command<'a> {
    Begin(&'a Value),
    Agent(&'a Value),
    Item(&'a Value),
    BlobStart { id: &'a str, bytes: i64 },
    BlobChunk { id: &'a str, bytes: &'a [u8] },
    BlobEnd { id: &'a str },
    Commit,
    Rollback,
}

struct Blob {
    id: String,
    expected: i64,
    offset: i64,
}

#[derive(Default)]
pub struct Archive {
    thread: Option<String>,
    seq: i64,
    blob: Option<Blob>,
}

fn id_of(value: &Value) -> Result<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::message("Archived record has no id"))
}

impl Archive {
    pub fn open(db: &Connection) -> Result<Archive> {
        db.execute_batch(SCHEMA)?;
        Ok(Archive::default())
    }

    pub fn active(&self) -> bool {
        self.thread.is_some()
    }

    pub fn write(&mut self, db: &Connection, command: Command<'_>) -> Result<()> {
        match command {
            Command::Begin(thread) => {
                if self.thread.is_some() {
                    return Err(Error::message("Archive import already active"));
                }
                let source = thread
                    .get("imported")
                    .and_then(|p| p.get("sourceId"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::message("Missing import provenance"))?;
                let id = id_of(thread)?.to_owned();
                db.execute_batch("BEGIN IMMEDIATE")?;
                if let Err(error) = db.execute(
                    "INSERT INTO imported_threads VALUES(?1,?2,?3,0)",
                    params![id, source, thread.to_string()],
                ) {
                    let _ = db.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                self.thread = Some(id);
                self.seq = 0;
                return Ok(());
            }
            Command::Rollback => {
                if self.thread.is_some() {
                    db.execute_batch("ROLLBACK")?;
                }
                self.thread = None;
                self.blob = None;
                return Ok(());
            }
            _ => {}
        }
        let Some(thread) = self.thread.clone() else {
            return Err(Error::message("No archive import active"));
        };
        match command {
            Command::Agent(agent) => {
                db.prepare_cached("INSERT INTO imported_agents VALUES(?1,?2,?3)")?
                    .execute(params![id_of(agent)?, thread, agent.to_string()])?;
            }
            Command::Item(item) => {
                let data = item.to_string();
                if data.len() > 256 * 1024 {
                    return Err(Error::message(
                        "Canonical history item exceeds publication limit",
                    ));
                }
                self.seq += 1;
                db.prepare_cached("INSERT INTO imported_items VALUES(?1,?2,?3)")?
                    .execute(params![thread, self.seq, data])?;
            }
            Command::BlobStart { id, bytes } => {
                if self.blob.is_some() {
                    return Err(Error::message("Blob stream already open"));
                }
                db.prepare_cached("INSERT INTO imported_blobs VALUES(?1,?2,?3,0)")?
                    .execute(params![id, thread, bytes])?;
                self.blob = Some(Blob {
                    id: id.to_owned(),
                    expected: bytes,
                    offset: 0,
                });
            }
            Command::BlobChunk { id, bytes } => {
                let Some(blob) = self
                    .blob
                    .as_mut()
                    .filter(|b| b.id == id && b.offset + bytes.len() as i64 <= b.expected)
                else {
                    return Err(Error::message("Invalid blob chunk"));
                };
                if bytes.len() as i64 > CHUNK {
                    return Err(Error::message("Invalid blob chunk"));
                }
                db.prepare_cached("INSERT INTO imported_blob_chunks VALUES(?1,?2,?3)")?
                    .execute(params![blob.id, blob.offset, bytes])?;
                blob.offset += bytes.len() as i64;
            }
            Command::BlobEnd { id } => {
                if !self
                    .blob
                    .as_ref()
                    .is_some_and(|b| b.id == id && b.offset == b.expected)
                {
                    return Err(Error::message("Incomplete blob"));
                }
                db.prepare_cached("UPDATE imported_blobs SET complete=1 WHERE id=?1")?
                    .execute([id])?;
                self.blob = None;
            }
            Command::Commit => {
                if self.blob.is_some() {
                    return Err(Error::message("Cannot publish an incomplete blob"));
                }
                db.execute(
                    "UPDATE imported_threads SET published=1 WHERE id=?1",
                    [&thread],
                )?;
                db.execute_batch("COMMIT")?;
                self.thread = None;
            }
            Command::Begin(_) | Command::Rollback => {}
        }
        Ok(())
    }

    pub fn delete(&self, db: &Connection, id: &str) -> Result<()> {
        if self.thread.is_some() {
            return Err(Error::message("Archive import active"));
        }
        db.execute("DELETE FROM imported_threads WHERE id=?1", [id])?;
        Ok(())
    }
}

fn thread_where(db: &Connection, column: &str, value: &str) -> Result<Value> {
    let row: Option<String> = db
        .prepare_cached(&format!(
            "SELECT thread FROM imported_threads WHERE {column}=?1 AND published=1"
        ))?
        .query_row([value], |row| row.get(0))
        .optional()?;
    Ok(match row {
        Some(text) => serde_json::from_str(&text).map_err(|e| Error::message(e.to_string()))?,
        None => Value::Null,
    })
}

/// The published thread imported from `source`, or null.
pub fn find(db: &Connection, source: &str) -> Result<Value> {
    thread_where(db, "source", source)
}

/// The published thread with this id, or null.
pub fn get(db: &Connection, id: &str) -> Result<Value> {
    thread_where(db, "id", id)
}

pub fn agents(db: &Connection, id: &str) -> Result<Value> {
    if get(db, id)?.is_null() {
        return Ok(Value::Array(Vec::new()));
    }
    let rows: Vec<String> = db
        .prepare_cached("SELECT data FROM imported_agents WHERE thread=?1 ORDER BY id LIMIT 512")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    rows.iter()
        .map(|r| serde_json::from_str(r).map_err(|e| Error::message(e.to_string())))
        .collect::<Result<Vec<Value>>>()
        .map(Value::Array)
}

/// One page of items after `after`, at most `limit` and 1 MiB.
pub fn page(db: &Connection, thread: &str, after: i64, limit: i64) -> Result<Value> {
    if get(db, thread)?.is_null() {
        return Err(Error::message("Unknown imported thread"));
    }
    let limit = limit.clamp(1, 200);
    let mut items = Vec::new();
    let mut bytes = 0;
    let mut cursor = after;
    let mut more = false;
    let mut statement = db.prepare_cached(
        "SELECT seq,data FROM imported_items WHERE thread=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
    )?;
    let mut rows = statement.query(params![thread, after, limit + 1])?;
    while let Some(row) = rows.next()? {
        let data: String = row.get(1)?;
        if data.len() > PAGE_BYTES {
            return Err(Error::message("Stored item exceeds page limit"));
        }
        if items.len() as i64 >= limit || bytes + data.len() > PAGE_BYTES {
            more = true;
            break;
        }
        items
            .push(serde_json::from_str::<Value>(&data).map_err(|e| Error::message(e.to_string()))?);
        bytes += data.len();
        cursor = row.get(0)?;
    }
    Ok(
        serde_json::json!({ "items": items, "next": if more { Value::from(cursor) } else { Value::Null } }),
    )
}

/// Bytes `[offset, offset+limit)` of a published blob, and its size.
pub fn read_blob(db: &Connection, id: &str, offset: i64, limit: i64) -> Result<(Vec<u8>, i64)> {
    let size: Option<i64> = db
        .prepare_cached("SELECT b.size FROM imported_blobs b JOIN imported_threads t ON t.id=b.thread WHERE b.id=?1 AND b.complete=1 AND t.published=1")?
        .query_row([id], |row| row.get(0))
        .optional()?;
    let Some(size) = size else {
        return Err(Error::message("Unknown imported blob"));
    };
    let length = limit.min((size - offset).max(0)).max(0);
    let mut bytes = vec![0u8; length as usize];
    let mut statement = db.prepare_cached("SELECT offset,bytes FROM imported_blob_chunks WHERE blob=?1 AND offset>=?2 AND offset<?3 ORDER BY offset")?;
    let mut rows = statement.query(params![id, (offset - CHUNK).max(0), offset + length])?;
    while let Some(row) = rows.next()? {
        let start: i64 = row.get(0)?;
        let chunk: Vec<u8> = row.get(1)?;
        let from = (offset - start).max(0) as usize;
        let target = (start - offset).max(0) as usize;
        let end = (chunk.len() as i64).min(offset + length - start).max(0) as usize;
        if from < end {
            let piece = &chunk[from..end];
            bytes[target..target + piece.len()].copy_from_slice(piece);
        }
    }
    Ok((bytes, size))
}
