// SPDX-License-Identifier: Apache-2.0

//! `openProviderDb`: a provider database read without touching it, always from a private
//! snapshot made from the handles `safe_open` checked: cloned copy-on-write where the filesystem
//! can (`fclonefileat`, `FICLONE`), else copied within the scratch cap. Nothing is opened by path
//! after the check: SQLite resolves a `/dev/fd` path back to a pathname on Linux, and Windows has
//! no file identity to prove a path still names the checked file.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::budget::{STEP, StepBudget};
use super::copy::copy_snapshot;
use super::scratch::{SnapshotScratch, Stage};
use crate::cancel::Cancel;
use crate::error::{Error, Result, io_at};
use crate::fsread::stat::fingerprint;
use crate::options::Home;

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.display()))
}

fn size(path: &Path) -> Result<Option<u64>> {
    match std::fs::symlink_metadata(path) {
        Ok(info) => Ok(Some(info.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_at(error, path)),
    }
}

/// `databaseFingerprint`: the database, its WAL and its rollback journal.
pub fn database_fingerprint(path: &Path) -> Result<String> {
    let mut parts = vec![fingerprint(
        &std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?,
    )];
    for suffix in ["-wal", "-journal"] {
        let other = sibling(path, suffix);
        match std::fs::symlink_metadata(&other) {
            Ok(info) => parts.push(fingerprint(&info)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parts.push("absent".to_owned())
            }
            Err(error) => return Err(io_at(error, &other)),
        }
    }
    Ok(parts.join("|"))
}

/// A `file:` URI for SQLite, its reserved characters escaped.
fn uri(path: &Path) -> String {
    let mut out = String::from("file:");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out.push_str("?immutable=1");
    out
}

/// An open provider database and how to check the rows read from it form one committed state.
pub struct ProviderDb {
    pub db: Connection,
    budget: StepBudget,
    _stage: Stage,
}

/// Whether `name` is a real table: a view could run any query a provider's file holds.
pub fn is_table(db: &Connection, name: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

impl ProviderDb {
    /// A row arrived: the next step of the read gets a whole time budget.
    pub fn renew(&self) {
        self.budget.renew();
    }

    /// The rows read form one committed state: they were read from a private snapshot.
    pub fn verify(&self) -> Result<()> {
        Ok(())
    }

    /// Closes the database, then removes its snapshot, if it had one.
    pub fn close(self) {
        let ProviderDb { db, _stage, .. } = self;
        drop(db);
        drop(_stage);
    }
}

fn attempt(
    home: &Home,
    path: &Path,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
) -> Result<ProviderDb> {
    let journal = size(&sibling(path, "-journal"))?.is_some();
    let wal_bytes = size(&sibling(path, "-wal"))?;
    let wal = wal_bytes.is_some();
    if home.offline_snapshot && (wal || journal) {
        return Err(Error::message("Immutable snapshot has a WAL or journal"));
    }
    if journal {
        return Err(Error::message(
            "Provider has an active rollback journal; retry after its writer settles",
        ));
    }
    let stage = scratch.acquire(cancel)?;
    let target = stage.dir.join("snapshot.sqlite");
    let staged = (|| -> Result<Connection> {
        let wal_path = sibling(path, "-wal");
        copy_snapshot(
            scratch,
            &home.home_dir,
            path,
            &target,
            wal.then_some(wal_path.as_path()),
            cancel,
        )?;
        if wal != size(&wal_path)?.is_some() || size(&sibling(path, "-journal"))?.is_some() {
            return Err(Error::message(super::CHANGED));
        }
        // A copy with a WAL replays it; one without is never written by anyone.
        Ok(if wal {
            Connection::open_with_flags(
                &target,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?
        } else {
            Connection::open_with_flags(
                uri(&target),
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?
        })
    })();
    let mut db = staged?;
    let budget = StepBudget::install(&mut db, cancel, STEP)?;
    Ok(ProviderDb {
        db,
        budget,
        _stage: stage,
    })
}

/// Retry only checkpoint races, a bounded number of times.
pub fn open_provider_db(
    home: &Home,
    path: &Path,
    scratch: &SnapshotScratch,
    cancel: &Cancel,
) -> Result<ProviderDb> {
    let mut tries = 0;
    loop {
        cancel.check()?;
        match attempt(home, path, scratch, cancel) {
            Err(Error::Message(m)) if m == super::CHANGED && tries < 2 => tries += 1,
            other => return other,
        }
    }
}
