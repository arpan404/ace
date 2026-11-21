// SPDX-License-Identifier: Apache-2.0

//! OpenCode's legacy storage (`storage-order.ts`, the storage branch of `source-records.ts`): a
//! session's message files in creation order, each followed by its part files. Directory order
//! is not transcript order, so messages are sorted on disk, never in a history-sized array.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Threaded, assign, threaded};
use crate::cancel::Cancel;
use crate::error::{Error, Result, io_at};
use crate::fsread::stat::fingerprint as file_fingerprint;
use crate::fsread::{Budget, JsonLines, RecordKind, read_head_tail, walk_files};
use crate::import::source::{Native, Raw, Records};
use crate::json::{field, object, string, timestamp};
use crate::options::Home;
use crate::paths::{basename, text};
use crate::snapshot::SnapshotScratch;

const INVENTORY: usize = 100_000;
const UNREADABLE: &str = "A saved OpenCode message is too large or unreadable. Open this conversation in OpenCode to recover its history.";

fn files(root: &Path, cancel: &Cancel) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    walk_files(root, cancel, &mut Budget::default(), &mut |path| {
        found.push(path.to_owned());
        if found.len() > INVENTORY {
            return Err(Error::message("Legacy storage inventory limit exceeded"));
        }
        Ok(())
    })?;
    Ok(found)
}

fn stat(path: &Path) -> Result<String> {
    Ok(file_fingerprint(
        &std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?,
    ))
}

/// `storageFingerprint`: the session file, then every message file and its parts, in walk order.
pub fn fingerprint(home: &Home, path: &Path, cancel: &Cancel) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(stat(path)?);
    let id = basename(path, ".json");
    walk_files(
        &home.home_dir.join("storage/message").join(&id),
        cancel,
        &mut Budget::default(),
        &mut |file| {
            hash.update(text(file));
            hash.update(stat(file)?);
            let parts = home
                .home_dir
                .join("storage/part")
                .join(basename(file, ".json"));
            walk_files(&parts, cancel, &mut Budget::default(), &mut |part| {
                hash.update(text(part));
                hash.update(stat(part)?);
                Ok(())
            })
        },
    )?;
    Ok(format!("{:x}", hash.finalize()))
}

/// UTF-16 code-unit order, as JavaScript's default sort compares strings.
fn utf16_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `orderedParts`: up to sixteen part files sort by path; more sort by file name on disk, ties
/// in walk order.
fn ordered_parts(root: &Path, cancel: &Cancel) -> Result<VecDeque<PathBuf>> {
    let mut parts = files(root, cancel)?;
    if parts.len() <= 16 {
        parts.sort_by(|a, b| utf16_order(&text(a), &text(b)));
    } else {
        parts.sort_by(|a, b| basename(a, "").as_bytes().cmp(basename(b, "").as_bytes()));
    }
    Ok(parts.into())
}

/// One message file: its single record, sampled exactly.
struct Header {
    path: PathBuf,
    value: Value,
    bytes: u64,
}

/// `orderedMessages`: every message file's record into a private SQLite file, then out in
/// `(time.created, file name)` order.
fn sort_messages(home: &Home, root: &Path, db: &Connection, cancel: &Cancel) -> Result<()> {
    db.execute_batch(
        "PRAGMA cache_size=-2048;CREATE TABLE entries(at INTEGER NOT NULL,id TEXT NOT NULL,path TEXT PRIMARY KEY,value TEXT NOT NULL,bytes INTEGER NOT NULL);BEGIN",
    )?;
    {
        let mut insert = db.prepare("INSERT INTO entries VALUES(?1,?2,?3,?4,?5)")?;
        let mut count = 0;
        walk_files(root, cancel, &mut Budget::default(), &mut |path| {
            cancel.check()?;
            let sample = read_head_tail(&home.home_dir, path, cancel)?;
            if !sample.exact || sample.records.len() != 1 {
                return Err(Error::message(UNREADABLE));
            }
            count += 1;
            if count > INVENTORY {
                return Err(Error::message("Legacy storage inventory limit exceeded"));
            }
            let record = &sample.records[0];
            let at =
                timestamp(field(object(field(object(record), "time")), "created")).unwrap_or(0);
            insert.execute(params![
                at,
                basename(path, ""),
                text(path),
                record.to_string(),
                sample.bytes as i64
            ])?;
            Ok(())
        })?;
    }
    db.execute_batch("COMMIT;CREATE INDEX entry_order ON entries(at,id)")?;
    Ok(())
}

fn each_message(
    db: &Connection,
    cancel: &Cancel,
    each: &mut dyn FnMut(Header) -> bool,
) -> Result<()> {
    let mut rows = db.prepare("SELECT path,value,bytes FROM entries ORDER BY at,id")?;
    let mut rows = rows.query([])?;
    while let Some(row) = rows.next()? {
        cancel.check()?;
        let value: String = row.get(1)?;
        let header = Header {
            path: PathBuf::from(row.get::<_, String>(0)?),
            value: serde_json::from_str(&value).map_err(|e| Error::message(e.to_string()))?,
            bytes: row.get::<_, i64>(2)? as u64,
        };
        if !each(header) {
            break;
        }
    }
    Ok(())
}

/// A part record, with its message's role and the first time it has.
fn part(value: &Value, role: Option<&Value>, created: Option<i64>) -> Value {
    let mut out = object(value).clone();
    let at = timestamp(field(object(field(object(value), "time")), "created")).or(created);
    assign(&mut out, "role", role.cloned());
    assign(&mut out, "timestamp", at.map(Value::from));
    Value::Object(out)
}

fn parts_of(
    home: &Home,
    header: &Header,
    cancel: &Cancel,
    limit: usize,
    emit: &mut dyn FnMut(Result<Native>) -> bool,
) -> Result<bool> {
    let message = object(&header.value);
    let role = string(message, "role").map(|r| Value::String(r.to_owned()));
    let created = timestamp(field(object(field(message, "time")), "created"));
    let dir = home
        .home_dir
        .join("storage/part")
        .join(basename(&header.path, ".json"));
    for path in ordered_parts(&dir, cancel)? {
        for record in JsonLines::open(&home.home_dir, &path, cancel, limit)? {
            let record = record?;
            let kind = match record.kind {
                RecordKind::Value(value) => RecordKind::Value(part(&value, role.as_ref(), created)),
                other => other,
            };
            let native = Native {
                bytes: record.bytes,
                kind,
                raw: Raw::File {
                    path: path.clone(),
                    offset: record.offset,
                },
            };
            if !emit(Ok(native)) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// The records of the session `native_id`; part lines over `limit` are opaque.
pub fn records<'a>(
    home: &'a Home,
    native_id: &str,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
    limit: usize,
) -> Result<Records<'a>> {
    let stage = scratch.work_dir("storage-order")?;
    let (home, cancel) = (home.clone(), cancel.clone());
    let root = home.home_dir.join("storage/message").join(native_id);
    let produced: Threaded = threaded(move |emit| {
        let mut run = || -> Result<()> {
            let db = Connection::open(stage.path().join("order.sqlite"))?;
            sort_messages(&home, &root, &db, &cancel)?;
            let mut failed = None;
            each_message(&db, &cancel, &mut |header| {
                let native = Native {
                    bytes: header.bytes,
                    kind: RecordKind::Value(header.value.clone()),
                    raw: Raw::File {
                        path: header.path.clone(),
                        offset: 0,
                    },
                };
                if !emit(Ok(native)) {
                    return false;
                }
                match parts_of(&home, &header, &cancel, limit, emit) {
                    Ok(more) => more,
                    Err(error) => {
                        failed = Some(error);
                        false
                    }
                }
            })?;
            failed.map_or(Ok(()), Err)
        };
        if let Err(error) = run() {
            emit(Err(error));
        }
        drop(stage);
    });
    Ok(Box::new(produced))
}
