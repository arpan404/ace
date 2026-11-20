// SPDX-License-Identifier: Apache-2.0

//! What to list, and what came back.

use crate::entry::Entry;

/// A request for one page of one folder.
#[derive(Debug, Clone)]
pub struct ListOptions {
    /// How many entries to return, 1 to 5000.
    pub limit: usize,
    /// Where to resume from. `None` starts at the first entry.
    pub cursor: Option<String>,
    /// Globs that are never listed, matched like gitignore patterns against the path from the
    /// root. The caller's default is `[".git", ".DS_Store"]`.
    pub hide: Vec<String>,
}

/// One page of a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// This page's entries, in listing order: folders first, then files, both natural-sorted.
    pub entries: Vec<Entry>,
    /// The cursor for the next page, or `None` when this page reaches the end.
    pub next_cursor: Option<String>,
    /// How many entries the folder holds once `hide` patterns are applied.
    pub total: usize,
}
