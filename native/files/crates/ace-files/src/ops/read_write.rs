// SPDX-License-Identifier: Apache-2.0

//! `read`, `write`, `createFile`, `createDir`, `rename` and `remove`: the bytes and the changes.
//!
//! A read answers with metadata and puts its bytes in one body frame, so a large file arrives as
//! pages the client asks for. A write takes its bytes from a body frame that follows the request
//! on the same pipe.

use files_io::{ReadRange, Walks, read as io_read};
use files_wire::{MAX_BODY_LEN, ReadMeta, Reply};

use crate::convert;
use crate::dispatch::Shared;
use crate::error::Error;
use crate::requests::Cancel;

/// The slice of a file `read` asked for.
pub struct ReadOp {
    /// The root's number.
    pub root: u64,
    /// Root-relative path.
    pub path: String,
    /// Byte offset to start at.
    pub offset: u64,
    /// How many bytes to return.
    pub length: u64,
    /// Return no bytes at all when the file is larger than this.
    pub max_size: Option<u64>,
}

/// A file whose bytes arrive in a body frame: `write` and `createFile`.
pub struct WriteOp {
    /// The root's number.
    pub root: u64,
    /// Root-relative path.
    pub path: String,
    /// The version the writer last saw; absent means the file must not exist yet.
    pub expected: Option<String>,
}

/// Read one range, ready to be answered as metadata plus a body frame.
///
/// A cancel that arrives before the read starts stops it; one that arrives after the bytes are in
/// hand changes nothing, since the read has happened.
pub fn read(shared: &Shared, cancel: &Cancel, op: &ReadOp) -> Result<(ReadMeta, Vec<u8>), Error> {
    if op.length > u64::from(MAX_BODY_LEN) {
        return Err(Error::InvalidArgument(format!(
            "a read returns at most {MAX_BODY_LEN} bytes; page through the file"
        )));
    }
    if cancel.cancelled() {
        return Err(Error::Aborted);
    }
    let entry = shared.roots.get(op.root)?;
    let range = ReadRange {
        offset: op.offset,
        length: op.length,
        max_size: op.max_size,
    };
    let read = io_read(entry.root(), &op.path, range)?;
    let meta = convert::read_meta(&read);
    Ok((meta, read.bytes))
}

/// Replace a file's bytes with the body frame's and report the version it now has.
///
/// The same call creates a file when `expected` is absent: `files-io` refuses to overwrite a file
/// the caller never read, so a create that races with another writer is `CONFLICT`, not a clobber.
pub fn write(shared: &Shared, op: &WriteOp, bytes: &[u8]) -> Result<Reply, Error> {
    let entry = shared.roots.get(op.root)?;
    let version = files_io::write(entry.root(), &op.path, bytes, op.expected.as_deref())?;
    Ok(Reply::Version { version })
}

/// Create a folder.
pub fn create_dir(shared: &Shared, root: u64, path: &str) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    files_io::create_dir(entry.root(), path)?;
    Ok(Reply::Done)
}

/// Describe one path: the version a guarded write compares, its size, kind and mode.
///
/// The daemon's `stat` answer needs exactly this, so a client that has been reading a file with
/// the TypeScript daemon sees the same version strings from the Rust one. A folder digest walks
/// the tree, so the request's cancel flag and the walk budget reach it.
pub fn describe(shared: &Shared, root: u64, path: &str, walks: &Walks) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let description = files_io::describe(entry.root(), path, walks)?;
    Ok(Reply::Description(convert::description(description)))
}

/// Describe the entry itself, never a folder's tree digest: the cheap guard a queued mutation
/// re-checks before it acts.
pub fn describe_entry(shared: &Shared, root: u64, path: &str) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let description = files_io::describe_entry(entry.root(), path)?;
    Ok(Reply::Description(convert::description(description)))
}

/// Check that a path may be a mutation target: nothing on the way may be a link.
pub fn check_mutation(shared: &Shared, root: u64, path: &str) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    files_io::check_mutation(entry.root(), path)?;
    Ok(Reply::Done)
}

/// How many bytes of files a path holds, for the trash quota a delete reserves.
pub fn measure(shared: &Shared, root: u64, path: &str, walks: &Walks) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    let measured = files_io::measure(entry.root(), path, walks)?;
    Ok(Reply::Measure {
        bytes: measured.bytes,
        shallow: measured.shallow,
    })
}

/// Move or rename a path.
pub fn rename(
    shared: &Shared,
    root: u64,
    from: &str,
    to: &str,
    overwrite: bool,
) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    files_io::rename(entry.root(), from, to, overwrite)?;
    Ok(Reply::Done)
}

/// Delete a file, or a folder and everything inside it.
pub fn remove(shared: &Shared, root: u64, path: &str) -> Result<Reply, Error> {
    let entry = shared.roots.get(root)?;
    files_io::remove(entry.root(), path)?;
    Ok(Reply::Done)
}
