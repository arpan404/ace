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
use crate::snapshot::{SnapshotScratch, WorkDir};

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
    /// The file's fingerprint when it was sampled: its raw bytes are read only from that file.
    fingerprint: String,
}

/// Messages held in memory before they spill to a private SQLite file: most sessions have a few,
/// and a file per session costs more than reading it. Both sort by `(time.created, file name)`,
/// ties in walk order, as `orderedMessages` did.
const SPILL_COUNT: usize = 256;
const SPILL_BYTES: u64 = 1024 * 1024;

/// A session's messages, sorted in memory or on disk.
enum Sorted {
    Memory(Vec<(i64, String, Header)>),
    Disk(Connection, WorkDir),
}

fn spill(
    scratch: &SnapshotScratch,
    held: Vec<(i64, String, Header)>,
) -> Result<(Connection, WorkDir)> {
    let stage = scratch.work_dir("storage-order")?;
    let db = Connection::open(stage.path().join("order.sqlite"))?;
    db.execute_batch(
        "PRAGMA cache_size=-2048;CREATE TABLE entries(at INTEGER NOT NULL,id TEXT NOT NULL,path TEXT PRIMARY KEY,value TEXT NOT NULL,bytes INTEGER NOT NULL,fingerprint TEXT NOT NULL);BEGIN",
    )?;
    for (at, name, header) in held {
        insert(&db, at, &name, &header)?;
    }
    Ok((db, stage))
}

fn insert(db: &Connection, at: i64, name: &str, header: &Header) -> Result<()> {
    db.prepare_cached("INSERT INTO entries VALUES(?1,?2,?3,?4,?5,?6)")?
        .execute(params![
            at,
            name,
            text(&header.path),
            header.value.to_string(),
            header.bytes as i64,
            header.fingerprint
        ])?;
    Ok(())
}

/// `orderedMessages`: every message file's single record, in `(time.created, file name)` order.
fn sort_messages(
    home: &Home,
    root: &Path,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
) -> Result<Sorted> {
    let mut held: Vec<(i64, String, Header)> = Vec::new();
    let mut held_bytes = 0u64;
    let mut disk: Option<(Connection, WorkDir)> = None;
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
        let mut records = sample.records;
        let value = records.pop().unwrap_or_default();
        let at = timestamp(field(object(field(object(&value), "time")), "created")).unwrap_or(0);
        let header = Header {
            path: path.to_owned(),
            value,
            bytes: sample.bytes,
            fingerprint: sample.fingerprint,
        };
        let name = basename(path, "");
        match &disk {
            Some((db, _)) => insert(db, at, &name, &header)?,
            None => {
                held_bytes += header.bytes;
                held.push((at, name, header));
                if held.len() > SPILL_COUNT || held_bytes > SPILL_BYTES {
                    disk = Some(spill(scratch, std::mem::take(&mut held))?);
                }
            }
        }
        Ok(())
    })?;
    Ok(match disk {
        Some((db, stage)) => {
            db.execute_batch("COMMIT;CREATE INDEX entry_order ON entries(at,id)")?;
            Sorted::Disk(db, stage)
        }
        None => {
            // Stable: equal keys keep walk order, as SQLite's index kept insertion order.
            held.sort_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
            });
            Sorted::Memory(held)
        }
    })
}

fn each_message(
    sorted: Sorted,
    cancel: &Cancel,
    each: &mut dyn FnMut(Header) -> bool,
) -> Result<()> {
    let (db, _stage) = match sorted {
        Sorted::Memory(held) => {
            for (_, _, header) in held {
                cancel.check()?;
                if !each(header) {
                    break;
                }
            }
            return Ok(());
        }
        Sorted::Disk(db, stage) => (db, stage),
    };
    let mut rows = db.prepare("SELECT path,value,bytes,fingerprint FROM entries ORDER BY at,id")?;
    let mut rows = rows.query([])?;
    while let Some(row) = rows.next()? {
        cancel.check()?;
        let value: String = row.get(1)?;
        let header = Header {
            path: PathBuf::from(row.get::<_, String>(0)?),
            value: crate::json::stored(&value)?,
            bytes: row.get::<_, i64>(2)? as u64,
            fingerprint: row.get(3)?,
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
        let lines = JsonLines::open(&home.home_dir, &path, cancel, limit)?;
        let file = lines.handle();
        for record in lines {
            let record = record?;
            let kind = match record.kind {
                RecordKind::Value(value) => RecordKind::Value(part(&value, role.as_ref(), created)),
                other => other,
            };
            let native = Native {
                bytes: record.bytes,
                kind,
                raw: Raw::Handle {
                    file: file.clone(),
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
    let (home, cancel, scratch) = (home.clone(), cancel.clone(), scratch.clone());
    let root = home.home_dir.join("storage/message").join(native_id);
    let produced: Threaded = threaded(move |emit| {
        let mut run = || -> Result<()> {
            let sorted = sort_messages(&home, &root, &scratch, &cancel)?;
            let mut failed = None;
            each_message(sorted, &cancel, &mut |header| {
                let native = Native {
                    bytes: header.bytes,
                    kind: RecordKind::Value(header.value.clone()),
                    raw: Raw::File {
                        path: header.path.clone(),
                        fingerprint: header.fingerprint.clone(),
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
    });
    Ok(Box::new(produced))
}
