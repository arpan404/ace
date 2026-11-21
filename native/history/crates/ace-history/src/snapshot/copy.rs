// SPDX-License-Identifier: Apache-2.0

//! `copySqliteSnapshot`: a frozen copy of a database and the WAL prefix it had. Appended commits
//! are safe; a reset, checkpoint or replacement during the copy is reported as a change.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::scratch::SnapshotScratch;
use crate::cancel::Cancel;
use crate::error::{Error, Result, io_at};
use crate::fsread::stat::fingerprint;
use crate::fsread::{read_at, safe_open};

const CHUNK: usize = 64 * 1024;

fn create(target: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(target).map_err(|e| io_at(e, target))
}

/// Copy `length` bytes of `source` into a new `target`, hashing them.
fn stream(source: &File, target: &Path, length: u64, cancel: &Cancel) -> Result<String> {
    let mut out = create(target)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut done = 0u64;
    while done < length {
        cancel.check()?;
        let want = (CHUNK as u64).min(length - done) as usize;
        let read = read_at(source, &mut buffer[..want], done)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        out.write_all(&buffer[..read])
            .map_err(|e| io_at(e, target))?;
        done += read as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn digest(source: &File, length: u64, cancel: &Cancel) -> Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut done = 0u64;
    while done < length {
        cancel.check()?;
        let want = (CHUNK as u64).min(length - done) as usize;
        let read = read_at(source, &mut buffer[..want], done)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        done += read as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(_a: &std::fs::Metadata, _b: &std::fs::Metadata) -> bool {
    true
}

pub fn copy_snapshot(
    scratch: &SnapshotScratch,
    home: &Path,
    source: &Path,
    target: &Path,
    wal: Option<&Path>,
    cancel: &Cancel,
) -> Result<()> {
    let base = safe_open(home, source)?;
    let info = base.metadata()?;
    let before = fingerprint(&info);
    let wal_bytes = match wal {
        Some(wal) => std::fs::symlink_metadata(wal)
            .map_err(|e| io_at(e, wal))?
            .len(),
        None => 0,
    };
    let cloned = info.len() > 0 && scratch.clone_file(&base, target);
    cancel.check()?;
    scratch.reserve(if cloned { 0 } else { info.len() } + wal_bytes)?;
    if !cloned {
        stream(&base, target, info.len(), cancel)?;
    }
    if let Some(wal) = wal {
        let journal = safe_open(home, wal)?;
        let opened = journal.metadata()?;
        let size = opened.len();
        // Where a commit or checkpoint can race the copy: the WAL's size is already frozen.
        crate::hooks::at_path("snapshot-wal-sized", &wal.to_string_lossy());
        let wal_target = std::path::PathBuf::from(format!("{}-wal", target.display()));
        let copied = stream(&journal, &wal_target, size, cancel)?;
        // Compare only the copied bytes: later commits need not stop the scan.
        let check = digest(&journal, size, cancel)?;
        let after = std::fs::symlink_metadata(wal).map_err(|e| io_at(e, wal))?;
        let now = journal.metadata()?;
        if !same_file(&after, &now) || now.len() < size || copied != check {
            return Err(Error::message(super::CHANGED));
        }
    }
    let after_open = fingerprint(&base.metadata()?);
    let after_path = fingerprint(&std::fs::symlink_metadata(source).map_err(|e| io_at(e, source))?);
    if before != after_open || before != after_path {
        return Err(Error::message(super::CHANGED));
    }
    Ok(())
}
