// SPDX-License-Identifier: Apache-2.0

//! `readJsonLines` and `readRange`: one provider line can be gigabytes, so lines are found in
//! 64 KiB reads and at most `limit` bytes of one are ever held.

use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use super::stat::fingerprint_of;
use super::{read_at, safe_open};
use crate::cancel::Cancel;
use crate::error::{CHANGED_DURING, Error, Result};

/// The largest record decoded at all; larger ones stream as opaque bytes.
pub const RECORD_LIMIT: usize = 1024 * 1024;
const BUFFER: usize = 64 * 1024;

#[derive(Debug)]
pub enum RecordKind {
    Value(Value),
    Oversized,
    Malformed,
}

#[derive(Debug)]
pub struct Record {
    pub offset: u64,
    pub bytes: u64,
    pub kind: RecordKind,
}

/// Decode one JSON record as `JSON.parse(buffer.toString("utf8"))` would.
pub fn decode(bytes: &[u8]) -> Option<Value> {
    crate::hooks::decoding(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => crate::json::parse(text),
        Err(_) => crate::json::parse(&String::from_utf8_lossy(bytes)),
    }
}

/// The records of a JSONL file, one at a time. Exhausting it checks the file did not change.
pub struct JsonLines {
    file: Arc<File>,
    size: u64,
    before: String,
    limit: usize,
    cancel: Cancel,
    buffer: Vec<u8>,
    filled: usize,
    cursor: usize,
    position: u64,
    start: u64,
    length: u64,
    held: Vec<u8>,
    done: bool,
}

impl JsonLines {
    pub fn open(home: &Path, path: &Path, cancel: &Cancel, limit: usize) -> Result<JsonLines> {
        if !(1..=RECORD_LIMIT).contains(&limit) {
            return Err(Error::message("Invalid native record limit"));
        }
        let file = Arc::new(safe_open(home, path)?);
        let meta = file.metadata()?;
        Ok(JsonLines {
            size: meta.len(),
            before: fingerprint_of(&file)?,
            file,
            limit,
            cancel: cancel.clone(),
            buffer: vec![0; BUFFER],
            filled: 0,
            cursor: 0,
            position: 0,
            start: 0,
            length: 0,
            held: Vec::new(),
            done: false,
        })
    }

    /// The open file the records are read from: their raw bytes are read from it too, never
    /// from whatever the path names by then.
    pub fn handle(&self) -> Arc<File> {
        self.file.clone()
    }

    fn record(&mut self) -> Record {
        let kind = if self.length > self.limit as u64 {
            RecordKind::Oversized
        } else {
            decode(&self.held).map_or(RecordKind::Malformed, RecordKind::Value)
        };
        Record {
            offset: self.start,
            bytes: self.length,
            kind,
        }
    }

    fn step(&mut self) -> Result<Option<Record>> {
        loop {
            if self.cursor >= self.filled {
                if self.position >= self.size {
                    // A valid final record without a newline is accepted; a live fragment is
                    // kept as malformed raw. The change check runs once it has been taken.
                    if self.length > 0 {
                        let last = self.record();
                        self.length = 0;
                        self.held.clear();
                        return Ok(Some(last));
                    }
                    self.done = true;
                    let after = fingerprint_of(&self.file)?;
                    if after != self.before {
                        return Err(Error::message(CHANGED_DURING));
                    }
                    return Ok(None);
                }
                self.cancel.check()?;
                let want = (BUFFER as u64).min(self.size - self.position) as usize;
                let read = read_at(&self.file, &mut self.buffer[..want], self.position)?;
                if read == 0 {
                    return Err(Error::message("Session shrank during import"));
                }
                self.position += read as u64;
                self.filled = read;
                self.cursor = 0;
            }
            let window = &self.buffer[self.cursor..self.filled];
            let newline = window.iter().position(|b| *b == b'\n');
            let end = newline.unwrap_or(window.len());
            self.length += end as u64;
            if self.length <= self.limit as u64 {
                self.held.extend_from_slice(&window[..end]);
            } else {
                self.held = Vec::new();
            }
            let base = self.position - self.filled as u64;
            self.cursor += end + 1;
            if newline.is_some() {
                let record = (self.length > 0).then(|| self.record());
                self.start = base + (self.cursor as u64);
                self.length = 0;
                self.held.clear();
                if let Some(record) = record {
                    return Ok(Some(record));
                }
            } else {
                self.cursor = self.filled;
            }
        }
    }
}

impl Iterator for JsonLines {
    type Item = Result<Record>;

    fn next(&mut self) -> Option<Result<Record>> {
        if self.done {
            return None;
        }
        match self.step() {
            Ok(Some(record)) => Some(Ok(record)),
            Ok(None) => None,
            Err(error) => {
                self.done = true;
                Some(Err(error))
            }
        }
    }
}

/// The bytes of one record from an open file, in chunks of at most 64 KiB.
pub fn read_range(
    file: &File,
    offset: u64,
    bytes: u64,
    cancel: &Cancel,
    chunk: &mut dyn FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let mut buffer = vec![0u8; BUFFER];
    let mut read = 0u64;
    while read < bytes {
        cancel.check()?;
        let want = (BUFFER as u64).min(bytes - read) as usize;
        let got = super::read_once_public(file, &mut buffer[..want], offset + read)?;
        if got == 0 {
            return Err(Error::message("Source range disappeared"));
        }
        read += got as u64;
        chunk(&buffer[..got])?;
    }
    Ok(())
}
