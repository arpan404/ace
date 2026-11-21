// SPDX-License-Identifier: Apache-2.0

//! `openProviderDb`: a provider database read without touching it. A WAL database whose WAL is
//! empty is read in place with `immutable=1` and fenced by its fingerprint; anything else is read
//! from a private snapshot.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::copy::copy_snapshot;
use super::scratch::{SnapshotScratch, Stage};
use crate::cancel::Cancel;
use crate::error::{Error, Result, io_at};
use crate::fsread::stat::fingerprint;
use crate::fsread::{read_at, safe_open};
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

fn wal_mode(home: &Path, path: &Path) -> Result<bool> {
    let file = safe_open(home, path)?;
    let mut header = [0u8; 100];
    let read = read_at(&file, &mut header, 0)?;
    Ok(read == 100 && header[18] == 2 && header[19] == 2)
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

fn open_immutable(path: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(
        uri(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

/// An open provider database and how to check the rows read from it form one committed state.
pub struct ProviderDb {
    pub db: Connection,
    fence: Option<(PathBuf, String)>,
    stage: Option<Stage>,
}

impl ProviderDb {
    /// Fails with the snapshot-changed message when a checkpoint changed the file meanwhile.
    pub fn verify(&self) -> Result<()> {
        if let Some((path, before)) = &self.fence {
            let now = fingerprint(&std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?);
            if &now != before || size(&sibling(path, "-journal"))?.is_some() {
                return Err(Error::message(super::CHANGED));
            }
        }
        Ok(())
    }

    pub fn close(self, scratch: &mut SnapshotScratch) {
        drop(self.db);
        if let Some(stage) = self.stage {
            scratch.release(stage);
        }
    }
}

fn attempt(
    home: &Home,
    path: &Path,
    scratch: &mut SnapshotScratch,
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
    if home.offline_snapshot {
        drop(safe_open(&home.home_dir, path)?);
        return Ok(ProviderDb {
            db: open_immutable(path)?,
            fence: None,
            stage: None,
        });
    }
    if wal_bytes.unwrap_or(0) == 0 && wal_mode(&home.home_dir, path)? {
        // Fingerprint first: a commit landing after the empty-WAL check reaches this file only
        // through a checkpoint, which changes the fingerprint and fails verify().
        let before = fingerprint(&std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?);
        if size(&sibling(path, "-wal"))?.unwrap_or(0) == 0
            && size(&sibling(path, "-journal"))?.is_none()
        {
            return Ok(ProviderDb {
                db: open_immutable(path)?,
                fence: Some((path.to_owned(), before)),
                stage: None,
            });
        }
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
        Ok(Connection::open_with_flags(
            &target,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?)
    })();
    match staged {
        Ok(db) => Ok(ProviderDb {
            db,
            fence: None,
            stage: Some(stage),
        }),
        Err(error) => {
            scratch.release(stage);
            Err(error)
        }
    }
}

/// Retry only checkpoint races, a bounded number of times.
pub fn open_provider_db(
    home: &Home,
    path: &Path,
    scratch: &mut SnapshotScratch,
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
