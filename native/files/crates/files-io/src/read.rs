// SPDX-License-Identifier: Apache-2.0

//! Range reads: the bytes an editor asks for, plus what it needs to decode and display them.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};

use files_safe::Root;

use crate::Error;
use crate::encoding::{self, SAMPLE_BYTES};
use crate::version::version_of;

/// The slice of a file to return: `length` bytes starting at `offset`.
#[derive(Debug, Clone, Copy)]
pub struct ReadRange {
    pub offset: u64,
    pub length: u64,
    /// When the file is larger than this, return no bytes at all, so the caller can show a
    /// warning instead of opening a huge file.
    pub max_size: Option<u64>,
}

/// A file slice with everything an editor needs to decide how to show it.
#[derive(Debug, Clone)]
pub struct Read {
    /// The file's full size, not the size of `bytes`.
    pub size: u64,
    /// The version of the file that was read, for a later guarded write.
    pub version: String,
    pub bytes: Vec<u8>,
    /// The first 8 KiB contain a NUL byte.
    pub binary: bool,
    /// `encoding_rs`'s canonical name for the detected encoding.
    pub encoding: &'static str,
    /// The file starts with a byte-order mark.
    pub bom: bool,
    /// `bytes` reaches the end of the file.
    pub eof: bool,
}

/// Reads one slice of a file.
pub fn read(root: &Root, path: &str, range: ReadRange) -> Result<Read, Error> {
    let absolute = root.resolve(path)?;
    let metadata = std::fs::metadata(&absolute)?;
    if !metadata.is_file() {
        return Err(Error::NotFile(path.to_owned()));
    }
    let mut file = File::open(&absolute)?;
    let head = head(&mut file)?;
    let detection = encoding::detect(&head);
    let oversized = range.max_size.is_some_and(|max| metadata.len() > max);
    let bytes = if oversized {
        Vec::new()
    } else {
        slice(&mut file, metadata.len(), range)?
    };
    let eof = !oversized && range.offset.saturating_add(bytes.len() as u64) >= metadata.len();
    Ok(Read {
        size: metadata.len(),
        version: version_of(&absolute, &metadata)?,
        bytes,
        binary: detection.binary,
        encoding: detection.encoding,
        bom: detection.bom,
        eof,
    })
}

/// The first 8 KiB, which decide encoding and binary-ness for every range of the file.
fn head(file: &mut File) -> Result<Vec<u8>, Error> {
    file.seek(SeekFrom::Start(0))?;
    let mut head = Vec::with_capacity(SAMPLE_BYTES as usize);
    file.by_ref().take(SAMPLE_BYTES).read_to_end(&mut head)?;
    Ok(head)
}

fn slice(file: &mut File, size: u64, range: ReadRange) -> Result<Vec<u8>, Error> {
    if range.offset >= size || range.length == 0 {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(range.offset))?;
    let wanted = range.length.min(size - range.offset);
    let mut bytes = Vec::with_capacity(wanted.min(SAMPLE_BYTES) as usize);
    file.by_ref().take(wanted).read_to_end(&mut bytes)?;
    Ok(bytes)
}
