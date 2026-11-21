// SPDX-License-Identifier: Apache-2.0

//! Codex's state databases (`state_<n>.sqlite` in the home root) and its session index
//! (`session_index.jsonl`), which carry titles the rollouts do not.

use history_text::session_title;
use rusqlite::Connection;

use super::Scan;
use crate::catalog::{Mark, Verdict};
use crate::error::{Error, Result, io_at};
use crate::fsread::JsonLines;
use crate::fsread::RECORD_LIMIT;
use crate::fsread::RecordKind;
use crate::fsread::stat::{fingerprint, mtime_ms};
use crate::json::{object, string};
use crate::options::Home;
use crate::paths::text;
use crate::session::{Accuracy, Kind, Session, Source, Support, source_id};
use crate::snapshot::{BUSY, CHANGED, database_fingerprint, open_provider_db};

fn is_state_db(name: &str) -> bool {
    name.strip_prefix("state_")
        .and_then(|rest| rest.strip_suffix(".sqlite"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The thread rows of one Codex state database, as catalog summaries.
fn sessions(
    home: &Home,
    path: &str,
    db: &Connection,
    each: &mut dyn FnMut(Session) -> Result<()>,
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
        each(Session {
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
        })?;
    }
    Ok(())
}

/// Read each state database in the home root, one at a time.
pub fn databases(scan: &mut Scan<'_>, home: &Home, epoch: i64) -> Result<()> {
    let entries = match std::fs::read_dir(&home.home_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, &home.home_dir)),
    };
    let mut paths = Vec::new();
    for entry in entries {
        scan.cancel.check()?;
        let entry = entry.map_err(|e| io_at(e, &home.home_dir))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|t| t.is_file()) && is_state_db(&name) {
            paths.push(entry.path());
        }
    }
    for path in paths {
        database(scan, home, epoch, &path)?;
    }
    Ok(())
}

fn database(scan: &mut Scan<'_>, home: &Home, epoch: i64, path: &std::path::Path) -> Result<()> {
    let name = text(path);
    scan.tally.files += 1;
    let fp = match database_fingerprint(path) {
        Ok(fp) => fp,
        Err(Error::Missing(_)) => return Ok(()),
        Err(error) => return Err(error),
    };
    if scan.catalog.touch(&home.id, &name, &fp, epoch)? {
        scan.tally.skipped += 1;
        return Ok(());
    }
    let now = (scan.now)();
    if let Some(reason) = scan
        .catalog
        .backoff
        .waiting(&scan.catalog.db, &home.id, &name, now)?
    {
        // A recent failure keeps the last good rows and its notice.
        scan.catalog.preserve_path(&home.id, &name, epoch)?;
        scan.tally.skipped += 1;
        if !reason.is_empty() {
            scan.tally.unsupported(&home.id, &reason);
        }
        return Ok(());
    }
    let verdict = scan.catalog.crashes.verdict(&home.id, &name, now);
    if let Verdict::Blocked(reason) = &verdict {
        scan.catalog.preserve_path(&home.id, &name, epoch)?;
        scan.tally.skipped += 1;
        scan.tally.unsupported(&home.id, reason);
        return Ok(());
    }
    // Marked outside the savepoint: a crash must leave the mark durable.
    let mark = if verdict == Verdict::Isolate {
        Mark::Verifying
    } else {
        Mark::Reading
    };
    scan.catalog
        .crashes
        .mark(&scan.catalog.db, &home.id, &name, mark)?;
    scan.catalog.db.execute_batch("SAVEPOINT provider_scan")?;
    let mut opened = None;
    let outcome = (|| -> Result<()> {
        let db = open_provider_db(home, path, scan.scratch, scan.cancel)?;
        scan.tally.reads += 1;
        let mut rows = 0;
        let mut put = |session: Session| -> Result<()> {
            rows += 1;
            if rows > 100_000 {
                return Err(Error::message(
                    "Provider database session inventory limit exceeded",
                ));
            }
            if rows % 64 == 0 {
                (scan.progress)(&scan.tally);
            }
            scan.cancel.check()?;
            let titled = !session.title.starts_with("Session from ");
            let (native, title) = (session.native_id.clone(), session.title.clone());
            scan.catalog.put(
                &Source {
                    summary: session,
                    hidden: false,
                    path: name.clone(),
                    fingerprint: fp.clone(),
                    kind: Kind::Database,
                    instance_id: home.id.clone(),
                },
                epoch,
            )?;
            if titled {
                scan.catalog
                    .set_native_title(&home.id, &native, &title, "database")?;
            }
            Ok(())
        };
        let read = sessions(home, &name, &db.db, &mut put);
        opened = Some(db);
        read?;
        if let Some(db) = &opened {
            db.verify()?;
        }
        // The rows read are one committed state even if the provider committed again since.
        let info = std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?;
        scan.catalog
            .remember(home, &name, info.len(), mtime_ms(&info), &fp, epoch)?;
        scan.catalog
            .backoff
            .succeeded(&scan.catalog.db, &home.id, &name)?;
        Ok(())
    })();
    match &outcome {
        Ok(()) => scan.catalog.db.execute_batch("RELEASE provider_scan")?,
        Err(_) => {
            scan.catalog
                .db
                .execute_batch("ROLLBACK TO provider_scan; RELEASE provider_scan")?;
            scan.catalog.preserve_path(&home.id, &name, epoch)?;
        }
    }
    if let Some(db) = opened {
        db.close(scan.scratch);
    }
    scan.catalog
        .crashes
        .finished(&scan.catalog.db, &home.id, &name)?;
    match outcome {
        Ok(()) => Ok(()),
        Err(error) if scan.cancel.is_cancelled() || matches!(error, Error::Aborted) => Err(error),
        Err(error) => {
            let message = error.to_string();
            // A busy snapshot is read by the next scan; a race waits silently.
            if message != BUSY {
                let reason = (message != CHANGED).then_some(message);
                scan.catalog.backoff.failed(
                    &scan.catalog.db,
                    &home.id,
                    &name,
                    reason.as_deref(),
                    (scan.now)(),
                )?;
                if let Some(reason) = reason {
                    scan.tally.unsupported(&home.id, &reason);
                }
            }
            Ok(())
        }
    }
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
