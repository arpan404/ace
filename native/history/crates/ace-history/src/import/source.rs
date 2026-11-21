// SPDX-License-Identifier: Apache-2.0

//! The native records of one source (`source-records.ts`): a JSONL transcript's lines, OpenCode's
//! legacy storage files in their storage order, or an OpenCode database's rows.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::cancel::Cancel;
use crate::error::{CHANGED_DURING, Error, Result};
use crate::fsread::{
    JsonLines, RECORD_LIMIT, RecordKind, read_range, safe_open, stat::fingerprint,
};
use crate::opencode;
use crate::options::Home;
use crate::session::{Kind, Source};
use crate::snapshot::{SnapshotScratch, database_fingerprint};

/// Where a record's own bytes are, for an import that keeps them as a raw blob.
#[derive(Debug)]
pub enum Raw {
    /// A range of the open file the record was decoded from.
    Handle { file: Arc<File>, offset: u64 },
    /// A whole file inside the home, read again by path: refused unless it is still the file
    /// (by its fingerprint) the record was decoded from.
    File { path: PathBuf, fingerprint: String },
    /// A database row, read whole (rows over the decode limit are refused, never read).
    Bytes(Vec<u8>),
}

/// One native record: its size, what it decoded to, and where its bytes are.
#[derive(Debug)]
pub struct Native {
    pub bytes: u64,
    pub kind: RecordKind,
    pub raw: Raw,
}

impl Native {
    /// The record's bytes, in chunks of at most 64 KiB.
    pub fn chunks(
        &self,
        home: &Home,
        cancel: &Cancel,
        chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
    ) -> Result<()> {
        match &self.raw {
            Raw::Handle { file, offset } => read_range(file, *offset, self.bytes, cancel, chunk),
            Raw::File {
                path,
                fingerprint: then,
            } => {
                let file = safe_open(&home.home_dir, path)?;
                if fingerprint(&file.metadata()?) != *then {
                    return Err(Error::message(CHANGED_DURING));
                }
                read_range(&file, 0, self.bytes, cancel, chunk)
            }
            Raw::Bytes(bytes) => {
                for part in bytes.chunks(64 * 1024) {
                    cancel.check()?;
                    chunk(part)?;
                }
                Ok(())
            }
        }
    }
}

pub type Records<'a> = Box<dyn Iterator<Item = Result<Native>> + 'a>;

/// The lines of a JSONL file, as native records.
pub fn lines<'a>(home: &Path, path: &Path, cancel: &Cancel, limit: usize) -> Result<Records<'a>> {
    let lines = JsonLines::open(home, path, cancel, limit)?;
    let file = lines.handle();
    Ok(Box::new(lines.map(move |record| {
        record.map(|r| Native {
            bytes: r.bytes,
            kind: r.kind,
            raw: Raw::Handle {
                file: file.clone(),
                offset: r.offset,
            },
        })
    })))
}

/// The records of `source`; file records over `limit` are opaque. Database rows keep the decoder
/// limit.
pub fn records<'a>(
    home: &'a Home,
    source: &'a Source,
    scratch: &'a SnapshotScratch,
    cancel: &'a Cancel,
    limit: usize,
) -> Result<Records<'a>> {
    match source.kind {
        Kind::Jsonl => lines(&home.home_dir, Path::new(&source.path), cancel, limit),
        Kind::Storage => {
            opencode::storage::records(home, &source.summary.native_id, scratch, cancel, limit)
        }
        Kind::Database => opencode::database::records(home, source, scratch, cancel),
    }
}

/// An import's records, at the decode limit.
pub fn import_records<'a>(
    home: &'a Home,
    source: &'a Source,
    scratch: &'a SnapshotScratch,
    cancel: &'a Cancel,
) -> Result<Records<'a>> {
    records(home, source, scratch, cancel, RECORD_LIMIT)
}

/// The source's fingerprint now, to compare with the one it was listed with.
pub fn current_fingerprint(home: &Home, source: &Source, cancel: &Cancel) -> Result<String> {
    let path = Path::new(&source.path);
    match source.kind {
        Kind::Database => database_fingerprint(path),
        Kind::Jsonl => Ok(fingerprint(
            &std::fs::symlink_metadata(path).map_err(|e| crate::error::io_at(e, path))?,
        )),
        Kind::Storage => opencode::storage::fingerprint(home, path, cancel),
    }
}
