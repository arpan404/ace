// SPDX-License-Identifier: Apache-2.0

//! The crash ledger and read backoff (`crash-ledger.ts`, `read-backoff.ts`): durable marks of
//! sources being read when a reader died, and waits before rereading a failed database.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;
use crate::options::LastExit;

const CRASH_LIMIT: i64 = 3;
const BASE_MS: f64 = 30_000.0;
const MAX_MS: f64 = 3_600_000.0;
const RETRYING: &str = "This saved conversation stopped the history reader. It will be read again later; open it in its original app if this keeps happening.";
const FAILED: &str = "This saved conversation stopped the history reader several times and is no longer read. Open it in its original app.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Read,
    Isolate,
    Blocked(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Reading,
    Verifying,
}

struct Entry {
    struck: bool,
    strikes: i64,
    retry_at: f64,
    /// The source's fingerprint when it was marked: strikes belong to that content only.
    fingerprint: Option<String>,
}

/// Marks are written before a read and cleared after it, whatever its outcome. Marks left at
/// start were in flight when the reader died. One mark left after an ordinary crash strikes its
/// source; after a memory-limit kill only a source read alone (`verifying`) is struck, since
/// memory another read used may have pushed the reader over; several marks make every one a
/// suspect, read alone next time. A strike holds for the content it was made on: a source whose
/// fingerprint changed is read again.
pub struct CrashLedger {
    entries: HashMap<(String, String), Entry>,
}

impl CrashLedger {
    /// Recover the marks of this reader's own homes (`own`), leaving another reader's alone.
    pub fn open(
        db: &Connection,
        now: f64,
        last_exit: Option<LastExit>,
        own: &[String],
    ) -> Result<CrashLedger> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS scan_crashes(instance TEXT NOT NULL,path TEXT NOT NULL,state TEXT NOT NULL,strikes INTEGER NOT NULL,retry_at REAL NOT NULL,PRIMARY KEY(instance,path))",
        )?;
        // A small table of in-flight and struck sources: adding the column is constant work.
        let has_fingerprint = db
            .prepare("PRAGMA table_info(scan_crashes)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|c| c == "fingerprint");
        if !has_fingerprint {
            db.execute_batch("ALTER TABLE scan_crashes ADD COLUMN fingerprint TEXT")?;
        }
        let own_json = serde_json::to_string(own).unwrap_or_else(|_| "[]".to_owned());
        let mine = "instance IN (SELECT value FROM json_each(?2))";
        let count = |state: &str| -> Result<i64> {
            Ok(db.query_row(
                &format!("SELECT count(*) FROM scan_crashes WHERE state=?1 AND {mine}"),
                params![state, own_json],
                |row| row.get(0),
            )?)
        };
        let reading = count("reading")?;
        let verifying = count("verifying")?;
        let strike = |states: &str| -> Result<()> {
            db.execute(
                &format!(
                    "UPDATE scan_crashes SET state='struck',strikes=strikes+1,retry_at=?1 * (1 << strikes) + ?3 WHERE state IN ({states}) AND instance IN (SELECT value FROM json_each(?2))"
                ),
                params![BASE_MS, own_json, now],
            )?;
            Ok(())
        };
        let suspect = || -> Result<()> {
            db.execute(
                "UPDATE scan_crashes SET state='suspect' WHERE state IN ('reading','verifying') AND instance IN (SELECT value FROM json_each(?1))",
                params![own_json],
            )?;
            Ok(())
        };
        if last_exit == Some(LastExit::MemoryLimit) {
            if verifying == 1 && reading == 0 {
                strike("'verifying'")?;
            } else {
                suspect()?;
            }
        } else if reading + verifying == 1 {
            strike("'reading','verifying'")?;
        } else if reading + verifying > 1 {
            suspect()?;
        }
        let mut entries = HashMap::new();
        let mut statement = db
            .prepare("SELECT instance,path,state,strikes,retry_at,fingerprint FROM scan_crashes")?;
        let rows = statement.query_map([], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                Entry {
                    struck: row.get::<_, String>(2)? == "struck",
                    strikes: row.get(3)?,
                    retry_at: row.get(4)?,
                    fingerprint: row.get(5)?,
                },
            ))
        })?;
        for row in rows {
            let (key, entry) = row?;
            entries.insert(key, entry);
        }
        Ok(CrashLedger { entries })
    }

    /// What to do with a source about to be read. `fingerprint` is its content now, when known:
    /// a source replaced since its strikes is read as new.
    pub fn verdict(
        &self,
        instance: &str,
        path: &str,
        fingerprint: Option<&str>,
        now: f64,
    ) -> Verdict {
        let Some(entry) = self.entries.get(&(instance.to_owned(), path.to_owned())) else {
            return Verdict::Read;
        };
        if let (Some(then), Some(now)) = (entry.fingerprint.as_deref(), fingerprint)
            && then != now
        {
            return Verdict::Read;
        }
        if !entry.struck {
            return Verdict::Isolate;
        }
        if entry.strikes >= CRASH_LIMIT {
            return Verdict::Blocked(FAILED.to_owned());
        }
        if now < entry.retry_at {
            return Verdict::Blocked(RETRYING.to_owned());
        }
        Verdict::Isolate
    }

    /// Mark before reading content; the mark must be durable before the read can crash.
    /// Mark before reading content (of `fingerprint`); a mark on new content starts its strikes
    /// over.
    pub fn mark(
        &self,
        db: &Connection,
        instance: &str,
        path: &str,
        mark: Mark,
        fingerprint: &str,
    ) -> Result<()> {
        let state = match mark {
            Mark::Reading => "reading",
            Mark::Verifying => "verifying",
        };
        db.execute(
            "INSERT INTO scan_crashes(instance,path,state,strikes,retry_at,fingerprint) VALUES(?1,?2,?3,0,0,?4)
             ON CONFLICT(instance,path) DO UPDATE SET state=?3,
               strikes=CASE WHEN fingerprint IS ?4 THEN strikes ELSE 0 END,
               retry_at=CASE WHEN fingerprint IS ?4 THEN retry_at ELSE 0 END,
               fingerprint=?4",
            params![instance, path, state, fingerprint],
        )?;
        Ok(())
    }

    /// The read ended without killing the reader, so the source is not a crash cause.
    pub fn finished(&mut self, db: &Connection, instance: &str, path: &str) -> Result<()> {
        db.execute(
            "DELETE FROM scan_crashes WHERE instance=?1 AND path=?2",
            params![instance, path],
        )?;
        self.entries.remove(&(instance.to_owned(), path.to_owned()));
        Ok(())
    }
}

/// Provider databases that failed to read wait 30 s, doubling to an hour, before another open.
pub struct ReadBackoff;

impl ReadBackoff {
    pub fn open(db: &Connection) -> Result<ReadBackoff> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS provider_db_backoff(instance TEXT NOT NULL,path TEXT NOT NULL,failures INTEGER NOT NULL,retry_at REAL NOT NULL,reason TEXT,PRIMARY KEY(instance,path))",
        )?;
        Ok(ReadBackoff)
    }

    /// While waiting, the last failure's notice ("" for silent races).
    pub fn waiting(
        &self,
        db: &Connection,
        instance: &str,
        path: &str,
        now: f64,
    ) -> Result<Option<String>> {
        let row: Option<(f64, Option<String>)> = db
            .query_row(
                "SELECT retry_at,reason FROM provider_db_backoff WHERE instance=?1 AND path=?2",
                params![instance, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((retry_at, reason)) if now < retry_at => Some(reason.unwrap_or_default()),
            _ => None,
        })
    }

    pub fn failed(
        &self,
        db: &Connection,
        instance: &str,
        path: &str,
        reason: Option<&str>,
        now: f64,
    ) -> Result<()> {
        let failures: i64 = db
            .query_row(
                "SELECT failures FROM provider_db_backoff WHERE instance=?1 AND path=?2",
                params![instance, path],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0)
            + 1;
        let delay = MAX_MS.min(BASE_MS * 2f64.powi((failures - 1).min(16) as i32));
        db.execute(
            "INSERT OR REPLACE INTO provider_db_backoff VALUES(?1,?2,?3,?4,?5)",
            params![instance, path, failures, now + delay, reason],
        )?;
        Ok(())
    }

    pub fn succeeded(&self, db: &Connection, instance: &str, path: &str) -> Result<()> {
        db.execute(
            "DELETE FROM provider_db_backoff WHERE instance=?1 AND path=?2",
            params![instance, path],
        )?;
        Ok(())
    }
}
