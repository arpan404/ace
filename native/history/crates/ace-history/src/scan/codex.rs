// SPDX-License-Identifier: Apache-2.0

//! Codex's state databases (`state_<n>.sqlite` in the home root) and its session index
//! (`session_index.jsonl`), which carry titles the rollouts do not.

use history_text::session_title;
use rusqlite::Connection;

use super::Scan;
use crate::error::{Error, Result, io_at};
use crate::fsread::JsonLines;
use crate::fsread::RECORD_LIMIT;
use crate::fsread::RecordKind;
use crate::fsread::stat::{fingerprint, mtime_ms};
use crate::json::{object, string};
use crate::options::Home;
use crate::paths::text;
use crate::session::{Accuracy, Session, Support, source_id};

pub fn is_state_db(name: &str) -> bool {
    name.strip_prefix("state_")
        .and_then(|rest| rest.strip_suffix(".sqlite"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The thread rows of one Codex state database, as catalog summaries.
pub fn sessions(
    home: &Home,
    path: &str,
    db: &Connection,
    each: &mut dyn FnMut(Session, bool) -> Result<()>,
) -> Result<()> {
    let columns: Vec<String> = db
        .prepare("PRAGMA table_info(threads)")?
        .query_map([], |row| row.get(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !["id", "cwd", "title", "updated_at"]
        .iter()
        .all(|c| columns.iter().any(|have| have == c))
    {
        return Err(Error::message("Unknown Codex state database schema"));
    }
    let mut statement = db.prepare(
        "SELECT id,cwd,CASE WHEN octet_length(title)<=1048576 THEN substr(title,1,1048576) ELSE '[Title exceeds display limit]' END AS title,updated_at FROM threads WHERE octet_length(id)<=1024 AND octet_length(cwd)<=8192 ORDER BY id",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let cwd: String = row.get(1)?;
        // `String(row.title)`, as the TypeScript reader read a missing title.
        let title: String = row
            .get::<_, Option<String>>(2)?
            .unwrap_or_else(|| "null".to_owned());
        let updated: f64 = row.get::<_, Option<f64>>(3)?.unwrap_or(0.0);
        let at = (updated * 1000.0) as i64;
        each(
            Session {
                id: source_id(&home.id, path, &id),
                instance_id: home.id.clone(),
                provider: "codex".to_owned(),
                title: session_title(if title == id { "" } else { &title }, "", at),
                native_id: id,
                cwd,
                model: None,
                last_activity: at,
                message_count: 0,
                count_accuracy: Accuracy::Sampled,
                parent_native_id: None,
                continuation: None,
                support: Support::unsupported(
                    "Database-only Codex session requires provider history APIs",
                ),
            },
            false,
        )?;
    }
    Ok(())
}

/// Titles from `session_index.jsonl`, which outrank a database's.
pub fn titles(scan: &mut Scan<'_>, home: &Home, epoch: i64) -> Result<()> {
    let path = home.home_dir.join("session_index.jsonl");
    let info = match std::fs::symlink_metadata(&path) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, &path)),
    };
    let name = text(&path);
    let fp = fingerprint(&info);
    if scan.catalog.touch(&home.id, &name, &fp, epoch)? {
        return Ok(());
    }
    let mut count = 0;
    let mtime = mtime_ms(&info);
    for record in JsonLines::open(&home.home_dir, &path, scan.cancel, RECORD_LIMIT)? {
        let record = record?;
        scan.cancel.check()?;
        count += 1;
        if count > 100_000 {
            return Err(Error::message("Session title inventory limit exceeded"));
        }
        let RecordKind::Value(value) = record.kind else {
            continue;
        };
        let r = object(&value);
        if let (Some(id), Some(title)) = (string(r, "id"), string(r, "thread_name"))
            && !id.is_empty()
            && !title.is_empty()
            && history_text::js::length(id) <= 1024
        {
            scan.catalog.set_native_title(
                &home.id,
                id,
                &session_title(title, "", mtime as i64),
                "index",
            )?;
        }
    }
    if fingerprint(&std::fs::symlink_metadata(&path).map_err(|e| io_at(e, &path))?) != fp {
        return Err(Error::message(
            "session_index.jsonl changed while reading titles",
        ));
    }
    scan.catalog
        .remember(home, &name, info.len(), mtime, &fp, epoch)?;
    Ok(())
}
