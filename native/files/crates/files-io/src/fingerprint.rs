// SPDX-License-Identifier: Apache-2.0

//! A file's content fingerprint: a digest of every byte, for a caller reconciling a tree it was
//! not watching.
//!
//! A version names a file's identity, size and times, which is what a guarded write needs. It does
//! not name the bytes: an edit that keeps the size and restores the modification time leaves the
//! version identical. A fingerprint reads the file through its folder's handle and digests the
//! bytes, so a caller comparing two versions that look unchanged can still tell that the content
//! moved.

use std::io::Read as _;

use cap_std::fs::File;
use files_safe::Root;
use sha2::{Digest, Sha256};

use crate::Error;
use crate::version;

/// How much of the file is read between checks; the digest covers every byte whatever this is.
const CHUNK: usize = 64 * 1024;

/// A file's content fingerprint and the version it was taken at.
#[derive(Debug, Clone)]
pub struct Fingerprint {
    /// The file's size in bytes.
    pub size: u64,
    /// The version the bytes had while they were read.
    pub version: String,
    /// `sha256:` and the digest of the file's bytes.
    pub digest: String,
}

/// Digests the bytes of the file at `path`.
///
/// A file that changes while it is being read is a `CONFLICT` carrying the version found, the same
/// answer a read gives: the caller must not treat a mix of old and new bytes as either version.
pub fn fingerprint(root: &Root, path: &str) -> Result<Fingerprint, Error> {
    let parent = crate::handle::target_parent_stored(root, path)?;
    crate::policy::refuse_components(&parent.folders, &parent.name, path)?;
    let (dir, name) = (parent.dir, parent.name);
    let mut file = dir.open(&name)?;
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Err(Error::NotFile(path.to_owned()));
    }
    let size = opened.len();
    let version = version::version_of(Some(&file), &opened)?;
    let digest = digest(&mut file)?;
    if version::version_of(Some(&file), &file.metadata()?)? != version {
        return Err(crate::read::conflict(path, Some(version)));
    }
    // The path may name another entry now, which would make this digest say nothing about it.
    let current = crate::read::current_version(root, path)?;
    if current.as_deref() != Some(version.as_str()) {
        return Err(crate::read::conflict(path, current));
    }
    Ok(Fingerprint {
        size,
        version,
        digest,
    })
}

/// The digest of the file's remaining bytes, in one streaming pass.
fn digest(file: &mut File) -> Result<String, Error> {
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}
