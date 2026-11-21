// SPDX-License-Identifier: Apache-2.0

//! The catalog (`catalog.ts`): every saved session the scans found, in the ace-owned index. Same
//! file and schema as the TypeScript reader's, format 5, so an existing index is used as it is.

mod display;
mod ledger;
mod rows;

use std::path::Path;
use std::time::Duration;

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

pub use ledger::{CrashLedger, LedgerWriter, Mark, ReadBackoff, Verdict, ledger_path};
pub use rows::{children, get, list};

use crate::cancel::Cancel;
use crate::error::{Error, Result};
use crate::options::{Home, LastExit};
use crate::paths::{contains, resolve, text};

/// The only index format this build reads.
pub const FORMAT: &str = "5";

/// The index is not one this build reads: refused, never rewritten.
#[derive(Debug)]
pub struct Incompatible {
    pub path: String,
    pub message: String,
}

pub struct Catalog {
    pub db: Connection,
    reader: Connection,
    pub backoff: ReadBackoff,
    pub crashes: CrashLedger,
    registry_key: String,
    needs_cleanup: bool,
}

const WRITER_PRAGMAS: &str = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;";
const READER_PRAGMAS: &str = "PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256";
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,instance TEXT NOT NULL,path TEXT NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,cwd TEXT NOT NULL,activity INTEGER NOT NULL,native TEXT NOT NULL,parent TEXT,summary TEXT NOT NULL,epoch INTEGER NOT NULL,own_activity INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS source_path ON sources(instance,path);
      CREATE INDEX IF NOT EXISTS source_workspace ON sources(cwd,activity DESC,id DESC);
      CREATE INDEX IF NOT EXISTS source_native ON sources(instance,native);
      CREATE INDEX IF NOT EXISTS source_parent ON sources(instance,parent);
      CREATE TABLE IF NOT EXISTS scans(instance TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files(instance TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,fingerprint TEXT NOT NULL,home TEXT NOT NULL,provider TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(instance,path));
      CREATE TABLE IF NOT EXISTS catalog_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_titles(instance TEXT,native TEXT,title TEXT,origin TEXT NOT NULL,PRIMARY KEY(instance,native));";

/// `JSON.stringify` of the registered homes, sorted, as the cleanup marker compares them.
pub fn registry_key(instances: &[Home]) -> String {
    let mut entries: Vec<String> = instances
        .iter()
        .map(|h| {
            serde_json::to_string(&[
                h.id.as_str(),
                &text(&resolve(&h.home_dir)),
                h.provider.as_str(),
            ])
            .unwrap_or_default()
        })
        .collect();
    entries.sort();
    format!("[{}]", entries.join(","))
}

/// Install the trust filters a connection serves rows through: registered homes, and the view of
/// rows whose file is still inside its home.
pub fn install_filters(db: &Connection, instances: &[Home]) -> Result<()> {
    db.execute_batch(
        "DROP VIEW IF EXISTS temp.visible_sources; DROP TABLE IF EXISTS temp.registered_instances;
         CREATE TEMP TABLE registered_instances(id TEXT PRIMARY KEY,home TEXT,provider TEXT)",
    )?;
    db.create_scalar_function(
        "history_home_contains",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let home = ctx.get::<Option<String>>(0).ok().flatten();
            let path = ctx.get::<Option<String>>(1).ok().flatten();
            Ok(match (home, path) {
                (Some(home), Some(path)) => i64::from(contains(Path::new(&home), Path::new(&path))),
                _ => 0,
            })
        },
    )?;
    {
        let mut insert = db.prepare("INSERT INTO registered_instances VALUES (?1,?2,?3)")?;
        for home in instances {
            insert.execute(params![
                home.id,
                text(&resolve(&home.home_dir)),
                home.provider.as_str()
            ])?;
        }
    }
    db.execute_batch(
        "CREATE TEMP VIEW visible_sources AS SELECT sources.* FROM sources
        JOIN registered_instances r ON sources.instance=r.id
        WHERE json_extract(summary,'$.provider')=r.provider
        AND EXISTS (SELECT 1 FROM files f WHERE f.instance=sources.instance AND f.path=sources.path
          AND f.home=r.home AND f.provider=r.provider)
        AND history_home_contains(r.home,path)=1",
    )?;
    Ok(())
}

/// A read-only connection for answering lists and reads while a scan or import runs.
pub fn open_reader(path: &Path, instances: &[Home]) -> Result<Connection> {
    let reader = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    reader.execute_batch(READER_PRAGMAS)?;
    install_filters(&reader, instances)?;
    Ok(reader)
}

impl Catalog {
    /// Open the index, refusing a format this build does not read.
    pub fn open(
        path: &Path,
        now: f64,
        last_exit: Option<LastExit>,
        own: &[String],
    ) -> Result<std::result::Result<Catalog, Incompatible>> {
        let db = Connection::open(path)?;
        // Crash-ledger marks are written between samples; wait out another writer's brief commit.
        db.busy_timeout(Duration::from_millis(2000))?;
        db.execute_batch(WRITER_PRAGMAS)?;
        // One transaction from the freshness check to the format marker: no reader can see the
        // tables without the marker, and a crash between them leaves a fresh file, never one
        // that is refused at the next start.
        db.execute_batch("BEGIN IMMEDIATE")?;
        let created = (|| -> Result<()> {
            let fresh: bool = db
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'",
                    [],
                    |_| Ok(()),
                )
                .optional()?
                .is_none();
            db.execute_batch(SCHEMA)?;
            crate::hooks::at("index-schema");
            if fresh {
                db.execute("INSERT INTO catalog_settings VALUES('format',?1)", [FORMAT])?;
            }
            Ok(())
        })();
        match created {
            Ok(()) => db.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
        let format: Option<String> = db
            .query_row(
                "SELECT value FROM catalog_settings WHERE key='format'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if format.as_deref() != Some(FORMAT) {
            return Ok(Err(Incompatible {
                path: text(path),
                message: format!(
                    "The saved-history index is format {}, and this build reads format {FORMAT}",
                    format.as_deref().unwrap_or("unknown")
                ),
            }));
        }
        let backoff = ReadBackoff::open(&db)?;
        let crashes = CrashLedger::open(&ledger_path(path), now, last_exit, own)?;
        let reader = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        reader.execute_batch(READER_PRAGMAS)?;
        Ok(Ok(Catalog {
            db,
            reader,
            backoff,
            crashes,
            registry_key: String::new(),
            needs_cleanup: true,
        }))
    }

    /// Install bounded trust filters before serving cached rows; defer inventory cleanup.
    pub fn reconcile(&mut self, instances: &[Home]) -> Result<()> {
        self.registry_key = registry_key(instances);
        let stored: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM catalog_settings WHERE key='instances'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        self.needs_cleanup = stored.as_deref() != Some(self.registry_key.as_str());
        install_filters(&self.db, instances)?;
        install_filters(&self.reader, instances)?;
        self.db.execute(
            "DELETE FROM native_titles WHERE instance IN (SELECT f.instance FROM files f LEFT JOIN registered_instances r ON f.instance=r.id WHERE r.id IS NULL OR r.home<>f.home OR r.provider<>f.provider)",
            [],
        )?;
        Ok(())
    }

    /// Remove rows of homes no longer registered, in pages of 256 between cancellation checks.
    pub fn cleanup(&mut self, cancel: &Cancel) -> Result<()> {
        if !self.needs_cleanup {
            return Ok(());
        }
        let mut after = String::new();
        loop {
            cancel.check()?;
            let ids: Vec<String> = {
                let mut statement = self
                    .db
                    .prepare_cached("SELECT id FROM sources WHERE id>?1 ORDER BY id LIMIT 256")?;
                statement
                    .query_map([&after], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            if ids.is_empty() {
                break;
            }
            for id in ids {
                self.db
                    .prepare_cached("DELETE FROM sources WHERE id=?1 AND id NOT IN (SELECT id FROM visible_sources WHERE id=?1)")?
                    .execute([&id])?;
                after = id;
            }
        }
        let mut after = 0i64;
        loop {
            cancel.check()?;
            let rows: Vec<i64> = {
                let mut statement = self.db.prepare_cached(
                    "SELECT rowid FROM files WHERE rowid>?1 ORDER BY rowid LIMIT 256",
                )?;
                statement
                    .query_map([after], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            if rows.is_empty() {
                break;
            }
            for row in rows {
                self.db.prepare_cached(
                    "DELETE FROM files WHERE rowid=?1 AND NOT EXISTS (SELECT 1 FROM registered_instances r WHERE r.id=files.instance AND r.home=files.home AND r.provider=files.provider AND history_home_contains(r.home,files.path)=1)",
                )?.execute([row])?;
                after = row;
            }
        }
        loop {
            cancel.check()?;
            let removed = self.db.execute(
                "DELETE FROM scans WHERE rowid IN (SELECT rowid FROM scans WHERE instance NOT IN (SELECT id FROM registered_instances) LIMIT 256)",
                [],
            )?;
            if removed == 0 {
                break;
            }
        }
        self.db.execute(
            "INSERT OR REPLACE INTO catalog_settings VALUES ('instances',?1)",
            [&self.registry_key],
        )?;
        self.needs_cleanup = false;
        Ok(())
    }

    pub fn reader(&self) -> &Connection {
        &self.reader
    }

    /// Run `body` inside `BEGIN IMMEDIATE … COMMIT`, rolling back on error.
    pub fn transaction<T>(&self, body: impl FnOnce(&Catalog) -> Result<T>) -> Result<T> {
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        match body(self) {
            Ok(value) => {
                self.db.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

impl From<Incompatible> for Error {
    fn from(refused: Incompatible) -> Error {
        Error::Message(refused.message)
    }
}
