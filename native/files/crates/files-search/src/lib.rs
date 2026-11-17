// SPDX-License-Identifier: Apache-2.0

//! Content search over one checkout, in process, backed by ripgrep's libraries.
//!
//! A search walks the root once on every available core, respects git's ignore rules unless the
//! caller asks otherwise, and streams one [`FileMatches`] per file to the caller's sink as soon as
//! that file is done. Binary files are skipped, long lines are cut to a 400-byte preview, and the
//! match cap stops every walker thread as soon as it is reached.
//!
//! Hidden files and folders are searched, as the Files panel lists them; the caller's `exclude`
//! globs decide what to leave out, including `.git`. Git's rules come from `.gitignore` files at
//! and below the root and from `.git/info/exclude`; the user's global excludes file is not
//! consulted, so a search depends only on the checkout.

mod error;
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
/// search. A literal `pattern` is escaped; `regex` turns it into a regular expression instead.
/// `cancel` is checked between files and between matching lines: setting it makes the search
/// return [`Error::Aborted`].
pub fn search(
    root: &Root,
    query: &Query,
    cancel: &AtomicBool,
    sink: &(dyn Fn(FileMatches) -> bool + Sync),
) -> Result<Summary, Error> {
    walk::run(root, query, cancel, sink)
}
