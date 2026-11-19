// SPDX-License-Identifier: Apache-2.0

//! File I/O for ace-files: range reads with encoding detection, atomic writes guarded by the
//! daemon's version string, and the create/rename/remove mutations the Files panel needs.
//!
//! Every operation goes through a handle: `files-safe` walks to the folder that holds the entry
//! and hands back the folder's capability and the entry's name, so no path string reaches the
//! filesystem and a link rewritten mid-operation cannot redirect the work.

mod describe;
mod encoding;
mod error;
mod fingerprint;
mod handle;
mod mutate;
mod number;
mod policy;
mod read;
mod tree;
mod version;
mod write;

pub use describe::{
    Description, Kind, Measurement, Walks, describe, describe_entry, entry_version, measure,
};
pub use error::Error;
pub use fingerprint::{Fingerprint, fingerprint};
pub use mutate::{Committed, create_dir, remove, rename, trash, untrash};
pub use policy::refuse_reserved;
pub use read::{Read, ReadRange, read};
pub use version::stat_version;
pub use write::{SaveWarning, Saved, create_file, write};
