// SPDX-License-Identifier: Apache-2.0

//! File I/O for ace-files: range reads with encoding detection, atomic writes guarded by the
//! daemon's version string, and the create/rename/remove mutations the Files panel needs.
//!
//! Every path is `files-safe`'s: the caller passes a canonical root and a `/`-separated relative
//! path, and anything that leaves the root is refused before a handle is opened.

mod encoding;
mod error;
mod mutate;
mod read;
mod version;
mod write;

pub use error::Error;
pub use mutate::{create_dir, remove, rename};
pub use read::{Read, ReadRange, read};
pub use version::stat_version;
pub use write::{create_file, write};
