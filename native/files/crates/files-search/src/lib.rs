// SPDX-License-Identifier: Apache-2.0

//! Content search over one checkout, in process, backed by ripgrep's libraries.
//!
//! A search walks the root once on every available core, respects git's ignore rules unless the
//! caller asks otherwise, and streams one [`FileMatches`] per file to the caller's sink as soon as
//! that file is done. Binary files are skipped, long lines are cut to a 400-byte preview, and the
//! match cap stops every walker thread as soon as it is reached. Once the sink returns `false` no
//! further file is handed to it.
//!
//! Git's rules come from `.gitignore` files at and below the root and from `.git/info/exclude`;
//! when the root is a subfolder of a repository, the `.gitignore` files between the repository's
//! top and the root apply too, and never those above the repository. The user's global excludes
//! file is not consulted, so a search depends only on the checkout. A `.git` folder is never
//! entered, and hidden files are searched because the Files panel lists them.

mod error;
mod folders;
mod open;
mod parents;
mod pattern;
mod preview;
mod query;
mod result;
mod sink;
mod walk;

pub use error::Error;
pub use query::{Case, Query};
pub use result::{FileMatches, LineMatch, Summary};

use std::sync::atomic::AtomicBool;

use files_safe::Root;

/// Searches every file under `root` and streams the matches to `sink`.
///
/// The sink runs on walker threads, so it must be `Sync`, and returning `false` from it stops the
/// search: no file is delivered after that. A literal `pattern` is escaped; `regex` turns it into
/// a regular expression instead, which cannot match across lines. `cancel` is checked between
/// files and between reads, so setting it returns [`Error::Aborted`] promptly even while a large
/// file is being read.
pub fn search(
    root: &Root,
    query: &Query,
    cancel: &AtomicBool,
    sink: &(dyn Fn(FileMatches) -> bool + Sync),
) -> Result<Summary, Error> {
    walk::run(root, query, cancel, sink)
}
